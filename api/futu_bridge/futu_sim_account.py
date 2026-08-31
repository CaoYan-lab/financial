import re

from futu_common import FUTU_DOCS_URL, UNAVAILABLE, market_cap, money, now_iso, read_payload, safe_float, write_json


def main():
    payload = read_payload()
    host = payload.get("host", "127.0.0.1")
    port = int(payload.get("port", 11111))
    requested_acc_id = str(payload.get("accountId", "") or "")
    timestamp = now_iso()
    source = {
        "source": "Futu OpenD Simulated Account",
        "url": FUTU_DOCS_URL,
        "accessedAt": timestamp,
        "timestamp": timestamp,
    }

    try:
        from futu import OpenSecTradeContext, RET_OK, TrdEnv, TrdMarket
    except Exception as exc:
        write_json(unavailable_dashboard(source, f"futu-api Python SDK unavailable: {exc}"))
        return

    trade_ctx = None
    try:
        trade_ctx = OpenSecTradeContext(filter_trdmarket=TrdMarket.US, host=host, port=port, ai_type=1)
        ret, data = trade_ctx.get_acc_list()
        if ret != RET_OK or data is None:
            write_json(unavailable_dashboard(source, f"get_acc_list failed: {data}"))
            return

        accounts = normalize_accounts(data, source)
        selected = select_sim_account(accounts, requested_acc_id)
        if selected is None:
            write_json(unavailable_dashboard(source, "No US SIMULATE account returned by Futu OpenD."))
            return

        acc_id = selected["accountId"]
        summary = fetch_summary(trade_ctx, TrdEnv, RET_OK, acc_id, source)
        positions = fetch_positions(trade_ctx, TrdEnv, RET_OK, acc_id)
        write_json(
            {
                "ok": True,
                "accounts": accounts,
                "selectedAccountId": acc_id,
                "summary": summary,
                "positions": positions,
                "trading": {
                    "environment": "SIMULATE",
                    "liveTradingEnabled": False,
                    "requiresConfirmation": False,
                    "warning": "Simulated trading only. Real-money order submission remains disabled.",
                },
                "warnings": [],
            }
        )
    except Exception as exc:
        write_json(unavailable_dashboard(source, f"Simulated account query unavailable: {exc}"))
    finally:
        if trade_ctx is not None:
            trade_ctx.close()


def normalize_accounts(data, source):
    accounts = []
    for _, row in data.iterrows():
        trd_env = str(row.get("trd_env", "")).upper()
        if trd_env != "SIMULATE":
            continue
        accounts.append(
            {
                "accountId": str(row.get("acc_id", UNAVAILABLE)),
                "trdEnv": "SIMULATE",
                "accType": str(row.get("acc_type", UNAVAILABLE)),
                "simAccType": str(row.get("sim_acc_type", UNAVAILABLE)),
                "trdMarketAuth": str(row.get("trdmarket_auth", UNAVAILABLE)),
                "currency": str(row.get("currency", "USD")),
                "source": source,
            }
        )
    return accounts


def select_sim_account(accounts, requested_acc_id):
    if requested_acc_id:
        for account in accounts:
            if account["accountId"] == requested_acc_id:
                return account
    for account in accounts:
        auth = f"{account.get('trdMarketAuth', '')} {account.get('simAccType', '')}".upper()
        if "US" in auth and ("STOCK" in auth or "STOCK_AND_OPTION" in auth):
            return account
    return accounts[0] if accounts else None


def fetch_summary(trade_ctx, TrdEnv, RET_OK, acc_id, source):
    ret, data = trade_ctx.accinfo_query(trd_env=TrdEnv.SIMULATE, acc_id=int(acc_id))
    if ret != RET_OK or data is None or data.empty:
        return unavailable_summary(source, acc_id)
    row = data.iloc[0]
    return {
        "accountId": acc_id,
        "currency": str(row.get("currency", "USD")),
        "totalAssets": money(row.get("total_assets")),
        "cash": money(row.get("cash")),
        "availableFunds": money(row.get("avl_withdrawal_cash") or row.get("available_funds")),
        "buyingPower": money(row.get("power")),
        "dailyPnL": money(row.get("today_pl_val")),
        "totalPnL": money(row.get("total_pl_val")),
        "source": source,
    }


def fetch_positions(trade_ctx, TrdEnv, RET_OK, acc_id):
    ret, data = trade_ctx.position_list_query(trd_env=TrdEnv.SIMULATE, acc_id=int(acc_id))
    if ret != RET_OK or data is None or data.empty:
        return []
    total_value = sum([safe_float(value) or 0 for value in data.get("market_val", [])]) or 0
    positions = []
    for _, row in data.iterrows():
        code = str(row.get("code", UNAVAILABLE))
        ticker = code.split(".", 1)[1] if "." in code else code
        asset_type = detect_asset_type(row, ticker, code)
        option_info = parse_option_contract(code, ticker, row) if asset_type == "OPTION" else {}
        underlying = option_info.get("underlyingTicker") or ticker
        quantity = safe_float(row.get("qty"))
        position_side = position_side_from_qty(quantity)
        option_position = option_position_type(option_info.get("optionType"), position_side) if asset_type == "OPTION" else UNAVAILABLE
        underlying_exposure = option_underlying_exposure(option_position) if asset_type == "OPTION" else position_side
        market_value = safe_float(row.get("market_val")) or 0
        position_ratio = (market_value / total_value * 100) if total_value > 0 else None
        positions.append(
            {
                "code": code,
                "ticker": ticker,
                "name": str(row.get("stock_name", ticker)),
                "assetType": asset_type,
                "underlyingTicker": underlying,
                "optionType": option_info.get("optionType", UNAVAILABLE),
                "strike": option_info.get("strike", UNAVAILABLE),
                "expirationDate": option_info.get("expirationDate", UNAVAILABLE),
                "contractSummary": option_info.get("contractSummary", ticker),
                "positionSide": position_side,
                "optionPositionType": option_position,
                "underlyingDirectionalExposure": underlying_exposure,
                "quantity": str(row.get("qty", UNAVAILABLE)),
                "marketValue": market_cap(market_value),
                "averageCost": money(row.get("cost_price")),
                "currentPrice": money(row.get("nominal_price")),
                "todayPnL": money(row.get("today_pl_val")),
                "unrealizedPnL": money(row.get("pl_val")),
                "pnlRatio": f"{safe_float(row.get('pl_ratio')):.2f}%" if safe_float(row.get("pl_ratio")) is not None else UNAVAILABLE,
                "positionRatio": f"{position_ratio:.2f}%" if position_ratio is not None else UNAVAILABLE,
                "currency": str(row.get("currency", "USD")),
            }
        )
    return positions


def detect_asset_type(row, ticker, code):
    joined = " ".join([str(row.get(field, "")) for field in ["stock_type", "sec_type", "security_type", "stock_owner", "stock_child_type"]]).upper()
    code_upper = f"{code} {ticker}".upper()
    if "OPTION" in joined or re.search(r"\d{6}[CP]\d{8}", code_upper) or re.search(r"\d{6}[CP]\d+", code_upper):
        return "OPTION"
    if "ETF" in joined:
        return "ETF"
    if any(kind in joined for kind in ["WARRANT", "BOND", "FUND", "FUTURE", "INDEX"]):
        return "OTHER"
    return "STOCK"


def parse_option_contract(code, ticker, row):
    raw = f"{code}.{ticker}".upper()
    compact = raw.replace(" ", "").replace("_", "")
    match = re.search(r"([A-Z]{1,6})(\d{6})([CP])(\d{8})", compact)
    if not match:
        match = re.search(r"([A-Z]{1,6})(\d{6})([CP])(\d+)", compact)
    if not match:
        return {
            "underlyingTicker": str(row.get("underlying_stock_code", ticker)).split(".")[-1],
            "optionType": UNAVAILABLE,
            "strike": UNAVAILABLE,
            "expirationDate": UNAVAILABLE,
            "contractSummary": ticker,
        }

    underlying, expiry, option_type, strike_raw = match.groups()
    expiration = f"20{expiry[:2]}-{expiry[2:4]}-{expiry[4:6]}"
    strike = safe_float(strike_raw)
    strike_text = money(strike / 1000) if strike is not None and len(strike_raw) >= 8 else str(strike_raw)
    option_label = "CALL" if option_type == "C" else "PUT"
    return {
        "underlyingTicker": underlying,
        "optionType": option_label,
        "strike": strike_text,
        "expirationDate": expiration,
        "contractSummary": f"{underlying} {expiration} {option_label} {strike_text}",
    }


def position_side_from_qty(quantity):
    if quantity is None:
        return UNAVAILABLE
    if quantity > 0:
        return "LONG"
    if quantity < 0:
        return "SHORT"
    return "FLAT"


def option_position_type(option_type, position_side):
    if option_type not in ["CALL", "PUT"] or position_side not in ["LONG", "SHORT"]:
        return UNAVAILABLE
    return f"{position_side}_{option_type}"


def option_underlying_exposure(option_position):
    if option_position in ["LONG_CALL", "SHORT_PUT"]:
        return "BULLISH"
    if option_position in ["SHORT_CALL", "LONG_PUT"]:
        return "BEARISH"
    return "NEUTRAL"


def unavailable_summary(source, account_id=UNAVAILABLE):
    return {
        "accountId": account_id or UNAVAILABLE,
        "currency": "USD",
        "totalAssets": UNAVAILABLE,
        "cash": UNAVAILABLE,
        "availableFunds": UNAVAILABLE,
        "buyingPower": UNAVAILABLE,
        "dailyPnL": UNAVAILABLE,
        "totalPnL": UNAVAILABLE,
        "source": source,
    }


def unavailable_dashboard(source, warning):
    return {
        "ok": False,
        "accounts": [],
        "selectedAccountId": UNAVAILABLE,
        "summary": unavailable_summary(source),
        "positions": [],
        "trading": {
            "environment": "SIMULATE",
            "liveTradingEnabled": False,
            "requiresConfirmation": False,
            "warning": "Simulated account data unavailable; simulated trading is disabled.",
        },
        "warnings": [warning],
    }


if __name__ == "__main__":
    main()
