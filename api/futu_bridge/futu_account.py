import re

from futu_common import FUTU_DOCS_URL, UNAVAILABLE, market_cap, money, now_iso, read_payload, safe_float, write_json


def main():
    payload = read_payload()
    host = payload.get("host", "127.0.0.1")
    port = int(payload.get("port", 11111))
    timestamp = now_iso()
    source = {
        "source": "Futu OpenD Account",
        "url": FUTU_DOCS_URL,
        "accessedAt": timestamp,
        "timestamp": timestamp,
    }

    try:
        from futu import OpenSecTradeContext, TrdEnv, TrdMarket
    except Exception as exc:
        write_json(unavailable_dashboard(source, f"futu-api Python SDK unavailable: {exc}"))
        return

    trade_ctx = None
    try:
        target_market = str(payload.get("market") or "US").upper()
        target_currency = str(payload.get("tradingCurrency") or currency_for_market(target_market)).upper()
        trade_ctx = OpenSecTradeContext(filter_trdmarket=trd_market_enum(TrdMarket, target_market), host=host, port=port, ai_type=1)
        account_id = fetch_account_id(trade_ctx, payload.get("accountId"), target_market)
        summary = fetch_summary(trade_ctx, TrdEnv, source, account_id, target_currency, payload.get("refreshCache") is True)
        positions = fetch_positions(trade_ctx, TrdEnv, account_id, payload.get("refreshCache") is True)
        risk = build_risk(summary, positions)
        write_json(
            {
                "ok": True,
                "summary": summary,
                "positions": positions,
                "risk": risk,
                "trading": {
                    "environment": "REAL",
                    "liveTradingEnabled": False,
                    "requiresConfirmation": True,
                    "warning": "Live trading entry is gated; this dashboard does not auto-submit orders.",
                },
                "missingCapabilities": [],
            }
        )
    except Exception as exc:
        write_json(unavailable_dashboard(source, f"Account/position query unavailable: {exc}"))
    finally:
        if trade_ctx is not None:
            trade_ctx.close()


def trd_market_enum(TrdMarket, market):
    if market == "CN":
        return TrdMarket.CN
    if market == "HK":
        return TrdMarket.HK
    return TrdMarket.US


def currency_for_market(market):
    if market == "CN":
        return "CNY"
    if market == "HK":
        return "HKD"
    return "USD"


def fetch_account_id(trade_ctx, requested_account_id=None, target_market="US"):
    if requested_account_id and str(requested_account_id).isdigit():
        return int(requested_account_id)
    ret, data = trade_ctx.get_acc_list()
    if ret != 0 or data is None or data.empty:
        return 0
    real_accounts = data[(data["trd_env"].astype(str).str.upper() == "REAL") & (data["acc_status"].astype(str).str.upper() == "ACTIVE")]
    if not real_accounts.empty:
        market_accounts = real_accounts[real_accounts["trdmarket_auth"].astype(str).str.contains(target_market, na=False)]
        row = market_accounts.iloc[0] if not market_accounts.empty else real_accounts.iloc[0]
        try:
            return int(str(row.get("acc_id")))
        except (TypeError, ValueError):
            return 0
    return 0


def first_number(*values):
    for value in values:
        number = safe_float(value)
        if number is not None:
            return number
    return None


def fetch_summary(trade_ctx, TrdEnv, source, account_id=0, target_currency="USD", refresh_cache=False):
    ret, data = trade_ctx.accinfo_query(trd_env=TrdEnv.REAL, acc_id=account_id, refresh_cache=refresh_cache)
    if ret != 0 or data is None or data.empty:
        raise RuntimeError("Account funds query failed or returned no account")
    row = data.iloc[0]
    # power and max_power_short describe different trading directions.
    buying_power = first_number(row.get("power"))
    generic_currency = str(row.get("currency", "")).upper()
    total_assets_in_target = currency_specific_value(row, target_currency, "assets", row.get("total_assets"))
    cash_in_target = currency_specific_value(row, target_currency, "cash", row.get("cash"))
    available_in_target = currency_specific_value(row, target_currency, "available", first_number(row.get("avl_withdrawal_cash"), row.get("available_funds")))
    buying_power_in_target = currency_specific_value(row, target_currency, "buying_power", buying_power)
    return {
        "accountId": str(row.get("acc_id", account_id or UNAVAILABLE)),
        "currency": generic_currency,
        "totalAssets": currency_money(row.get("total_assets"), generic_currency),
        "cash": currency_money(row.get("cash"), generic_currency),
        "availableFunds": currency_money(first_number(row.get("avl_withdrawal_cash"), row.get("available_funds")), generic_currency),
        "buyingPower": currency_money(buying_power, generic_currency),
        "tradingCurrency": target_currency,
        "totalAssetsInTradingCurrency": currency_money(total_assets_in_target, target_currency),
        "cashInTradingCurrency": currency_money(cash_in_target, target_currency),
        "availableFundsInTradingCurrency": currency_money(available_in_target, target_currency),
        "buyingPowerInTradingCurrency": currency_money(buying_power_in_target, target_currency),
        "futuExposureLevel": str(row.get("exposure_level", "NONE")),
        "futuRiskStatus": str(row.get("risk_status", "NONE")),
        "financingCurrency": generic_currency,
        "financingEquity": currency_money(row.get("total_assets"), generic_currency),
        "initialMargin": currency_money(row.get("initial_margin"), generic_currency),
        "maintenanceMargin": currency_money(row.get("maintenance_margin"), generic_currency),
        "dailyPnL": currency_money(row.get("today_pl_val"), generic_currency),
        "totalPnL": currency_money(row.get("total_pl_val"), generic_currency),
        "source": source,
    }


def currency_money(value, currency):
    if currency not in ["USD", "HKD", "CNY"]:
        return UNAVAILABLE
    formatted = money(value)
    if formatted == UNAVAILABLE:
        return formatted
    return f"HK{formatted}" if currency == "HKD" else f"CNY {formatted[1:]}" if currency == "CNY" else formatted


def currency_specific_value(row, target_currency, kind, generic_value):
    target_currency = str(target_currency).upper()
    if target_currency == "USD":
        if kind == "assets":
            return first_number(row.get("usd_assets"), generic_value if row.get("currency") == "USD" else None)
        if kind == "cash":
            return first_number(row.get("us_cash"), generic_value if row.get("currency") == "USD" else None)
        if kind == "available":
            return first_number(row.get("us_avl_withdrawal_cash"), row.get("usd_net_cash_power"), generic_value if row.get("currency") == "USD" else None)
        return trading_currency_value(row, generic_value)
    if target_currency == "HKD":
        for field in fields_for_currency("hk", kind):
            value = row.get(field)
            if safe_float(value) is not None:
                return value
    if target_currency == "CNY":
        for prefix in ["cn", "cny", "rmb"]:
            for field in fields_for_currency(prefix, kind):
                value = row.get(field)
                if safe_float(value) is not None:
                    return value
    generic_currency = str(row.get("currency", "")).upper()
    if generic_currency == target_currency:
        return generic_value
    return None


def fields_for_currency(prefix, kind):
    if kind == "assets":
        return [f"{prefix}_assets", f"{prefix}_total_assets"]
    if kind == "cash":
        return [f"{prefix}_cash"]
    if kind == "available":
        return [f"{prefix}_avl_withdrawal_cash", f"{prefix}_available_funds", f"{prefix}_net_cash_power"]
    return [f"{prefix}_power", f"{prefix}_buying_power"]


def trading_currency_value(row, value):
    numeric = safe_float(value)
    if numeric is None:
        return None
    currency = str(row.get("currency", "")).upper()
    if currency == "USD":
        return numeric
    # Currency balances are not an exchange rate or a convertible buying limit.
    return None


def fetch_positions(trade_ctx, TrdEnv, account_id=0, refresh_cache=False):
    ret, data = trade_ctx.position_list_query(trd_env=TrdEnv.REAL, acc_id=account_id, refresh_cache=refresh_cache)
    if ret != 0 or data is None:
        raise RuntimeError("Account positions query failed")
    if data.empty:
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
                "availableToClose": available_to_close(row.get("can_sell_qty"), quantity),
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


def available_to_close(raw, quantity):
    value = safe_float(raw)
    if value is None or quantity is None or value < 0 or value > abs(quantity):
        return None
    return value


def detect_asset_type(row, ticker, code):
    joined = " ".join([str(row.get(field, "")) for field in ["stock_type", "sec_type", "security_type", "stock_owner", "stock_child_type"]]).upper()
    code_upper = f"{code} {ticker}".upper()
    if "OPTION" in joined or re.search(r"\d{6}[CP]\d{8}", code_upper) or re.search(r"\d{6}[CP]\d+", code_upper):
        return "OPTION"
    if "ETF" in joined:
        return "ETF"
    non_equity_markers = ["BOND", "WARRANT", "FUTURE", "INDEX", "FUND", "FOREX", "CURRENCY", "CRYPTO"]
    if any(marker in joined for marker in non_equity_markers):
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


def build_risk(summary, positions):
    largest = max(positions, key=lambda item: safe_float(item["marketValue"].replace("$", "").replace(",", "")) or 0, default=None)
    warnings = []
    largest_ratio = largest["positionRatio"] if largest else UNAVAILABLE
    if largest and safe_float(largest_ratio.replace("%", "")) and safe_float(largest_ratio.replace("%", "")) > 25:
        warnings.append(f"Concentration risk: {largest['ticker']} is {largest_ratio} of reported positions.")
    return {
        "concentrationRisk": largest_ratio,
        "largestPosition": largest["ticker"] if largest else UNAVAILABLE,
        "cashRatio": UNAVAILABLE,
        "top30Overlap": UNAVAILABLE,
        "warnings": warnings,
    }


def unavailable_summary(source):
    return {
        "accountId": UNAVAILABLE,
        "currency": "USD",
        "totalAssets": UNAVAILABLE,
        "cash": UNAVAILABLE,
        "availableFunds": UNAVAILABLE,
        "buyingPower": UNAVAILABLE,
        "tradingCurrency": "USD",
        "totalAssetsInTradingCurrency": UNAVAILABLE,
        "cashInTradingCurrency": UNAVAILABLE,
        "availableFundsInTradingCurrency": UNAVAILABLE,
        "buyingPowerInTradingCurrency": UNAVAILABLE,
        "dailyPnL": UNAVAILABLE,
        "totalPnL": UNAVAILABLE,
        "source": source,
    }


def unavailable_dashboard(source, warning):
    return {
        "ok": False,
        "summary": unavailable_summary(source),
        "positions": [],
        "risk": {
            "concentrationRisk": UNAVAILABLE,
            "largestPosition": UNAVAILABLE,
            "cashRatio": UNAVAILABLE,
            "top30Overlap": UNAVAILABLE,
            "warnings": [warning],
        },
        "trading": {
            "environment": "UNKNOWN",
            "liveTradingEnabled": False,
            "requiresConfirmation": True,
            "warning": "Account data unavailable; live trading is disabled.",
        },
        "missingCapabilities": [warning],
    }


if __name__ == "__main__":
    main()
