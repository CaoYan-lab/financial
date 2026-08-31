import json
import os
import sys
from datetime import datetime
from pathlib import Path


def main():
    payload = read_payload()
    if sys.version_info < (3, 10):
        emit(
            {
                "ok": False,
                "error": f"TradingAgents requires Python >= 3.10, current Python is {sys.version.split()[0]}. Set TRADINGAGENTS_PYTHON_BIN to a venv Python.",
            }
        )
        return
    repo_path = Path(
        payload.get("repoPath")
        or os.environ.get("TRADINGAGENTS_REPO_PATH", "")
        or Path.cwd() / "third_party" / "TradingAgents"
    ).expanduser()
    if not repo_path.exists():
        emit(
            {
                "ok": False,
                "error": f"TradingAgents repo not found: {repo_path}. Set TRADINGAGENTS_REPO_PATH or clone TauricResearch/TradingAgents into third_party/TradingAgents.",
            }
        )
        return

    sys.path.insert(0, str(repo_path))
    try:
        from tradingagents.default_config import DEFAULT_CONFIG
        from tradingagents.graph.trading_graph import TradingAgentsGraph
        from tradingagents.llm_clients import create_llm_client
    except Exception as exc:
        emit({"ok": False, "error": f"Failed to import TradingAgents from {repo_path}: {exc}"})
        return

    if payload.get("checkOnly"):
        emit(
            {
                "ok": True,
                "source": "TauricResearch/TradingAgents",
                "repoPath": str(repo_path),
                "python": sys.version.split()[0],
            }
        )
        return

    ticker = to_tradingagents_symbol(str(payload.get("ticker") or ""))
    if not ticker:
        emit({"ok": False, "error": "Missing ticker"})
        return

    trade_date = str(payload.get("tradeDate") or datetime.now().strftime("%Y-%m-%d"))
    config = DEFAULT_CONFIG.copy()
    config.update(
        {
            "max_debate_rounds": int(payload.get("maxDebateRounds") or 1),
            "online_tools": True,
        }
    )
    if payload.get("llmProvider"):
        config["llm_provider"] = payload["llmProvider"]
    if payload.get("quickThinkLlm"):
        config["quick_think_llm"] = payload["quickThinkLlm"]
    if payload.get("deepThinkLlm"):
        config["deep_think_llm"] = payload["deepThinkLlm"]
    if payload.get("backendUrl"):
        config["backend_url"] = payload["backendUrl"]
    if payload.get("maxRiskRounds"):
        config["max_risk_discuss_rounds"] = int(payload["maxRiskRounds"])
    if payload.get("outputLanguage"):
        config["output_language"] = payload["outputLanguage"]
    if payload.get("openaiCompatibleApiKey"):
        os.environ["OPENAI_COMPATIBLE_API_KEY"] = str(payload["openaiCompatibleApiKey"])

    if payload.get("configOnly"):
        emit(
            {
                "ok": True,
                "source": "TauricResearch/TradingAgents",
                "repoPath": str(repo_path),
                "python": sys.version.split()[0],
                "config": {
                    "llm_provider": config.get("llm_provider"),
                    "backend_url": config.get("backend_url"),
                    "quick_think_llm": config.get("quick_think_llm"),
                    "deep_think_llm": config.get("deep_think_llm"),
                    "max_debate_rounds": config.get("max_debate_rounds"),
                    "max_risk_discuss_rounds": config.get("max_risk_discuss_rounds"),
                    "output_language": config.get("output_language"),
                    "openai_compatible_api_key_configured": bool(os.environ.get("OPENAI_COMPATIBLE_API_KEY")),
                },
            }
        )
        return

    if payload.get("llmSmokeOnly"):
        emit(run_llm_smoke(config, payload, create_llm_client))
        return

    if payload.get("contextAgentRun"):
        emit(run_context_agent(config, payload, create_llm_client, repo_path))
        return

    try:
        graph = TradingAgentsGraph(debug=False, config=config)
        _, decision = graph.propagate(ticker, trade_date)
        emit(
            {
                "ok": True,
                "source": "TauricResearch/TradingAgents",
                "repoPath": str(repo_path),
                "ticker": ticker,
                "tradeDate": trade_date,
                "decision": normalize_decision_text(decision),
                "rawDecision": stringify(decision),
            }
        )
    except Exception as exc:
        emit({"ok": False, "error": f"TradingAgents run failed for {ticker}: {exc}"})


def to_tradingagents_symbol(ticker: str) -> str:
    normalized = ticker.strip().upper()
    if normalized.endswith(".SH"):
        return normalized[:-3] + ".SS"
    return normalized


def normalize_decision_text(decision) -> str:
    if isinstance(decision, dict):
        for key in ("decision", "action", "recommendation", "final_decision"):
            if key in decision:
                return str(decision[key])
    return stringify(decision)


def stringify(value) -> str:
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False, default=str)
    except Exception:
        return str(value)


def run_llm_smoke(config, payload, create_llm_client):
    mock_data = payload.get("mockData") or {}
    symbol = str(mock_data.get("ticker") or payload.get("ticker") or "000001.SZ")
    context = stringify(
        {
            "ticker": symbol,
            "name": mock_data.get("name", "平安银行"),
            "session": mock_data.get("session", "RTH"),
            "lastPrice": mock_data.get("lastPrice", "10.88"),
            "kline1mBars": mock_data.get("kline1mBars", 120),
            "tickerPoints": mock_data.get("tickerPoints", 240),
            "orderBook": mock_data.get("orderBook", {"bid1": "10.87", "ask1": "10.89"}),
            "constraints": ["A股只多头", "禁止SELL_SHORT", "必须人工确认", "只允许HOLD/BUY/SELL_TO_CLOSE"],
        }
    )
    roles = [
        ("market_analyst", "quick", "用两句话判断短线价格和成交结构，只输出 JSON，字段 role, verdict, evidence。"),
        ("risk_analyst", "quick", "用两句话判断A股交易风险，只输出 JSON，字段 role, verdict, risk。"),
        ("bull_researcher", "deep", "给出看多理由，只输出 JSON，字段 role, thesis, confidence。"),
        ("bear_researcher", "deep", "给出反方风险，只输出 JSON，字段 role, thesis, confidence。"),
        ("portfolio_manager", "deep", "综合前面角色，给出 HOLD/BUY/SELL_TO_CLOSE 之一，只输出 JSON，字段 role, action, reason。"),
    ]
    try:
        quick_llm = create_llm_client(
            provider=config["llm_provider"],
            model=config["quick_think_llm"],
            base_url=config.get("backend_url"),
        ).get_llm()
        deep_llm = create_llm_client(
            provider=config["llm_provider"],
            model=config["deep_think_llm"],
            base_url=config.get("backend_url"),
        ).get_llm()
        results = []
        for role, model_type, instruction in roles:
            llm = quick_llm if model_type == "quick" else deep_llm
            response = llm.invoke(
                [
                    ("system", f"You are the {role} in a TradingAgents multi-agent trading workflow. Return concise JSON only."),
                    ("user", f"{instruction}\nMock A-share decision data:\n{context}"),
                ]
            )
            text = getattr(response, "content", stringify(response))
            results.append(
                {
                    "role": role,
                    "modelType": model_type,
                    "ok": bool(str(text).strip()),
                    "responsePreview": str(text).strip()[:500],
                }
            )
        return {
            "ok": all(item["ok"] for item in results),
            "source": "TauricResearch/TradingAgents",
            "repoPath": str(payload.get("repoPath") or os.environ.get("TRADINGAGENTS_REPO_PATH", "")),
            "config": {
                "llm_provider": config.get("llm_provider"),
                "backend_url": config.get("backend_url"),
                "quick_think_llm": config.get("quick_think_llm"),
                "deep_think_llm": config.get("deep_think_llm"),
                "openai_compatible_api_key_configured": bool(os.environ.get("OPENAI_COMPATIBLE_API_KEY")),
            },
            "mockData": mock_data,
            "results": results,
        }
    except Exception as exc:
        return {
            "ok": False,
            "error": f"TradingAgents LLM smoke failed: {exc}",
            "config": {
                "llm_provider": config.get("llm_provider"),
                "backend_url": config.get("backend_url"),
                "quick_think_llm": config.get("quick_think_llm"),
                "deep_think_llm": config.get("deep_think_llm"),
                "openai_compatible_api_key_configured": bool(os.environ.get("OPENAI_COMPATIBLE_API_KEY")),
            },
        }


def run_context_agent(config, payload, create_llm_client, repo_path):
    data_context = payload.get("dataContext") or {}
    symbol = str(data_context.get("ticker") or payload.get("ticker") or "")
    if not symbol:
        return {"ok": False, "error": "contextAgentRun requires dataContext.ticker"}
    try:
        quick_llm = create_llm_client(
            provider=config["llm_provider"],
            model=config["quick_think_llm"],
            base_url=config.get("backend_url"),
        ).get_llm()
        deep_llm = create_llm_client(
            provider=config["llm_provider"],
            model=config["deep_think_llm"],
            base_url=config.get("backend_url"),
        ).get_llm()
        context_text = stringify(data_context)
        role_specs = [
            (
                "market_analyst",
                quick_llm,
                "你是A股Trading Agent的Market Analyst。只基于marketDataContext判断短线价格、K线、逐笔成交和盘口。输出JSON：role,status,summary,evidence,risks,recommendation。",
            ),
            (
                "risk_analyst",
                quick_llm,
                "你是A股Trading Agent的Risk Analyst。重点读取macroNewsContext、stockNewsContext、dataQualityContext和aShareRulesContext。新闻只能提高风险约束。输出JSON：role,status,summary,evidence,risks,recommendation。",
            ),
            (
                "bull_researcher",
                deep_llm,
                "你是A股Trading Agent的Bull Researcher。提出看多理由，但必须承认数据质量限制。输出JSON：role,status,summary,evidence,risks,recommendation。",
            ),
            (
                "bear_researcher",
                deep_llm,
                "你是A股Trading Agent的Bear Researcher。提出反方风险，尤其关注宏观、新闻、盘口和数据缺失。输出JSON：role,status,summary,evidence,risks,recommendation。",
            ),
        ]
        reports = []
        for role, llm, instruction in role_specs:
            started_at = datetime.now().isoformat()
            response = llm.invoke(
                [
                    ("system", "你正在本项目A股实盘Trading Agent adapter中工作。不得调用外部行情工具。不得编造缺失数据。只输出紧凑JSON。"),
                    ("user", f"{instruction}\n\nA股上下文JSON：\n{context_text}"),
                ]
            )
            completed_at = datetime.now().isoformat()
            text = str(getattr(response, "content", stringify(response))).strip()
            reports.append(normalize_role_report(role, text, started_at, completed_at))

        final_started_at = datetime.now().isoformat()
        final_response = deep_llm.invoke(
            [
                (
                    "system",
                    "你是A股Trading Agent的Portfolio Manager。你必须在HOLD、BUY、SELL_TO_CLOSE中三选一。禁止SELL_SHORT。不得绕过人工确认和后端硬风控。A股买入一手为100股，BUY必须基于sizingContext计算价格*数量+费用，SELL_TO_CLOSE必须基于持仓数量和价格*数量计算回收金额。只输出JSON。",
                ),
                (
                    "user",
                    "根据A股上下文和前面角色报告给最终裁决。JSON字段：role,status,action,summary,evidence,risks,recommendation,limitPrice,orderQuantity,targetNotional,estimatedFee,cashImpact,positionImpact,sizingReason,minLotSatisfied,fundsSufficient,confidence。\n"
                    "若action为BUY，orderQuantity必须是sizingContext.lotSize的整数倍，并说明targetNotional与availableFunds/buyingPower是否匹配；若最小一手也不满足资金或预算约束，必须输出HOLD。\n"
                    "若action为SELL_TO_CLOSE，orderQuantity不得超过sizingContext.targetLongQuantity，并说明预计回收金额；若无持仓或数量不合法，必须输出HOLD。\n"
                    f"A股上下文JSON：\n{context_text}\n\n角色报告：\n{stringify(reports)}",
                ),
            ]
        )
        final_completed_at = datetime.now().isoformat()
        final_text = str(getattr(final_response, "content", stringify(final_response))).strip()
        final_report = normalize_role_report("portfolio_manager", final_text, final_started_at, final_completed_at)
        final_decision = parse_json_object(final_text) or {}
        action = normalize_action(str(final_decision.get("action") or final_decision.get("recommendation") or final_text))
        sizing_error = validate_sizing_decision(action, final_decision, data_context)
        if sizing_error:
            action = "HOLD"
            final_decision["sizingFailure"] = sizing_error
        reports.append(final_report)
        return {
            "ok": True,
            "source": "TauricResearch/TradingAgents contextAgentRun",
            "repoPath": str(repo_path),
            "ticker": symbol,
            "tradeDate": str(payload.get("tradeDate") or datetime.now().strftime("%Y-%m-%d")),
            "action": action,
            "decision": str(final_decision.get("summary") or final_decision.get("reason") or final_text),
            "roleReports": reports,
            "finalDecision": {
                **final_decision,
                "action": action,
            },
            "rawDecision": stringify({"roleReports": reports, "finalDecision": final_decision}),
        }
    except Exception as exc:
        return {"ok": False, "error": f"TradingAgents contextAgentRun failed for {symbol}: {exc}"}


def normalize_role_report(role, text, started_at, completed_at):
    parsed = parse_json_object(text) or {}
    raw_status = str(parsed.get("status") or "OK").upper()
    status = raw_status if raw_status in {"OK", "WATCH", "ERROR"} else "OK"
    return {
        "role": str(parsed.get("role") or role),
        "status": status,
        "summary": str(parsed.get("summary") or parsed.get("thesis") or parsed.get("verdict") or text)[:1200],
        "evidence": normalize_string_list(parsed.get("evidence")),
        "risks": normalize_string_list(parsed.get("risks") or parsed.get("risk")),
        "recommendation": stringify(parsed.get("recommendation") or parsed.get("action") or ""),
        "rawText": text,
        "raw": text,
        "startedAt": started_at,
        "completedAt": completed_at,
    }


def validate_sizing_decision(action, final_decision, data_context):
    if action == "HOLD":
        return None
    sizing = data_context.get("sizingContext") or {}
    lot_size = safe_number(sizing.get("lotSize")) or 100
    quantity = safe_number(final_decision.get("orderQuantity"))
    limit_price = safe_number(final_decision.get("limitPrice")) or safe_number(sizing.get("limitPrice")) or safe_number(sizing.get("lastPrice"))
    if quantity is None or quantity <= 0:
        return "非HOLD裁决缺少合法orderQuantity。"
    if not limit_price or limit_price <= 0:
        return "非HOLD裁决缺少合法limitPrice，无法计算名义金额。"
    if action == "BUY":
        if int(quantity) % int(lot_size) != 0:
            return f"BUY数量{quantity}不是一手{lot_size}股的整数倍。"
        available = safe_number(sizing.get("availableFunds")) or safe_number(sizing.get("buyingPower"))
        fee_rate = safe_number(sizing.get("estimatedFeeRate")) or 0
        estimated_cost = quantity * limit_price * (1 + fee_rate)
        if available is None:
            return "BUY缺少可用资金，不能生成买入裁决。"
        if estimated_cost > available:
            return f"BUY预计成本{estimated_cost:.2f}超过可用资金{available:.2f}。"
    if action == "SELL_TO_CLOSE":
        target_long_quantity = safe_number(sizing.get("targetLongQuantity")) or 0
        if target_long_quantity <= 0:
            return "SELL_TO_CLOSE无可识别多头持仓。"
        if quantity > target_long_quantity:
            return f"SELL_TO_CLOSE数量{quantity}超过持仓{target_long_quantity}。"
    return None


def safe_number(value):
    try:
        if value is None or value == "":
            return None
        if isinstance(value, str):
            value = value.replace(",", "").replace("¥", "").replace("￥", "").replace("$", "").replace("%", "").strip()
        parsed = float(value)
        return parsed if parsed == parsed else None
    except Exception:
        return None


def normalize_string_list(value):
    if value is None:
        return []
    if isinstance(value, list):
        return [stringify(item) for item in value][:10]
    return [stringify(value)]


def parse_json_object(text):
    if not text:
        return None
    candidate = text.strip()
    if candidate.startswith("```"):
        candidate = candidate.strip("`")
        if candidate.lower().startswith("json"):
            candidate = candidate[4:].strip()
    try:
        parsed = json.loads(candidate)
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        pass
    start = candidate.find("{")
    end = candidate.rfind("}")
    if start >= 0 and end > start:
        try:
            parsed = json.loads(candidate[start : end + 1])
            return parsed if isinstance(parsed, dict) else None
        except Exception:
            return None
    return None


def normalize_action(text):
    upper = str(text or "").upper()
    if "SELL_SHORT" in upper:
        return "HOLD"
    if "SELL_TO_CLOSE" in upper or "SELL" in upper or "卖出" in str(text):
        return "SELL_TO_CLOSE"
    if "BUY" in upper or "买入" in str(text):
        return "BUY"
    return "HOLD"


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False))


def read_payload():
    raw = sys.stdin.read().strip()
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        for line in reversed(raw.splitlines()):
            line = line.strip()
            if line.startswith("{") and line.endswith("}"):
                return json.loads(line)
        raise


if __name__ == "__main__":
    main()
