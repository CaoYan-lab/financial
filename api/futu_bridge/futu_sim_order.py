import re

from futu_common import UNAVAILABLE, futu_code, money, now_iso, read_payload, safe_float, write_json


def main():
    payload = read_payload()
    timestamp = now_iso()
    host = payload.get("host", "127.0.0.1")
    port = int(payload.get("port", 11111))
    account_id = str(payload.get("accountId", "") or "")
    ticker = str(payload.get("ticker", "") or "").upper()
    side = str(payload.get("side", "") or "").upper()
    quantity = safe_float(payload.get("quantity"))
    limit_price = safe_float(payload.get("limitPrice"))
    order_type = str(payload.get("orderType", "MARKETABLE_LIMIT")).upper()
    order_session = str(payload.get("orderSession", "RTH")).upper()
    strategy = str(payload.get("strategy", "LLM_AUTONOMOUS_STOCK_TRADER"))
    signal_id = str(payload.get("signalId", UNAVAILABLE))

    errors = validate_payload(account_id, ticker, side, quantity, limit_price, order_type, order_session)
    if errors:
        write_json(error_response(payload, "; ".join(errors), timestamp))
        return

    try:
        from futu import OpenSecTradeContext, OrderType, RET_OK, Session, TrdEnv, TrdMarket, TrdSide
    except Exception as exc:
        write_json(error_response(payload, f"futu-api Python SDK unavailable: {exc}", timestamp))
        return

    trade_ctx = None
    try:
        code = futu_code(ticker)
        trd_market = trade_market_for_code(code, TrdMarket)
        trade_ctx = OpenSecTradeContext(filter_trdmarket=trd_market, host=host, port=port, ai_type=1)
        trd_side = TrdSide.BUY if side == "BUY" else TrdSide.SELL
        futu_session = Session.ETH if order_session == "ETH" else Session.RTH
        futu_order_type = OrderType.MARKET if order_type == "MARKET" else OrderType.NORMAL
        ret, data = trade_ctx.place_order(
            price=0 if order_type == "MARKET" else limit_price,
            qty=quantity,
            code=code,
            trd_side=trd_side,
            order_type=futu_order_type,
            trd_env=TrdEnv.SIMULATE,
            acc_id=int(account_id),
            remark=f"FinancialWorkbench SIM {strategy} {signal_id}"[:64],
            fill_outside_rth=order_session == "ETH",
            session=futu_session,
        )
        if ret != RET_OK:
            write_json(error_response(payload, f"place_order SIMULATE failed: {data}", timestamp))
            return

        row = data.iloc[0].to_dict() if hasattr(data, "empty") and not data.empty else {}
        write_json(
            {
                "ok": True,
                "orderId": str(row.get("order_id", row.get("orderID", UNAVAILABLE))),
                "ticker": ticker,
                "side": side,
                "quantity": str(quantity),
                "orderType": order_type,
                "orderSession": order_session,
                "limitPrice": "MARKET" if order_type == "MARKET" else money(limit_price),
                "submittedAt": timestamp,
                "strategy": strategy,
                "signalId": signal_id,
                "rawResponse": sanitize_raw(row),
            }
        )
    except Exception as exc:
        write_json(error_response(payload, f"Simulated order unavailable: {exc}", timestamp))
    finally:
        if trade_ctx is not None:
            trade_ctx.close()


def validate_payload(account_id, ticker, side, quantity, limit_price, order_type, order_session):
    errors = []
    if not account_id.isdigit():
        errors.append("SIMULATE accountId is required.")
    if not ticker:
        errors.append("Ticker is required.")
    if ticker.startswith(("US.", "HK.", "SH.", "SZ.")):
        ticker_body = ticker.split(".", 1)[1]
    else:
        ticker_body = ticker
    if re.search(r"\d{6}[CP]\d+", ticker_body):
        errors.append("Options are not allowed in simulated quant stock/ETF trading.")
    if side not in {"BUY", "SELL_SHORT", "SELL_TO_CLOSE"}:
        errors.append("Only BUY, SELL_SHORT and SELL_TO_CLOSE are allowed in SIMULATE stock/ETF trading.")
    if quantity is None or quantity <= 0:
        errors.append("Quantity must be greater than 0.")
    if order_type != "MARKET" and (limit_price is None or limit_price <= 0):
        errors.append("Limit price must be greater than 0.")
    if order_type not in {"LIMIT", "MARKETABLE_LIMIT", "MARKET"}:
        errors.append("Only LIMIT, MARKETABLE_LIMIT and MARKET are allowed.")
    if order_session not in {"RTH", "ETH"}:
        errors.append("Only RTH and ETH sessions are supported by Futu SIMULATE paper trading.")
    if futu_code(ticker).startswith("HK.") and order_session != "RTH":
        errors.append("HK instruments only support RTH orders in this simulation engine.")
    if futu_code(ticker).startswith(("SH.", "SZ.")):
        if side == "SELL_SHORT":
            errors.append("A-share simulated trading forbids SELL_SHORT.")
        if order_session != "RTH":
            errors.append("A-share instruments only support RTH orders.")
    if order_type == "MARKET" and order_session != "RTH":
        errors.append("MARKET orders are only allowed in RTH; use MARKETABLE_LIMIT for ETH.")
    if order_type == "MARKET" and side != "BUY":
        errors.append("MARKET orders are only allowed for short-cover BUY in this simulation engine.")
    return errors


def sanitize_raw(row):
    return {str(key): str(value) for key, value in row.items()}


def trade_market_for_code(code, trd_market_cls):
    if code.startswith("HK."):
        return trd_market_cls.HK
    if code.startswith(("SH.", "SZ.")):
        return getattr(trd_market_cls, "CN")
    return trd_market_cls.US


def error_response(payload, error, timestamp):
    return {
        "ok": False,
        "orderId": UNAVAILABLE,
        "ticker": str(payload.get("ticker", UNAVAILABLE)).upper(),
        "side": str(payload.get("side", UNAVAILABLE)).upper(),
        "quantity": str(payload.get("quantity", UNAVAILABLE)),
        "orderType": str(payload.get("orderType", "MARKETABLE_LIMIT")).upper(),
        "orderSession": str(payload.get("orderSession", "RTH")).upper(),
        "limitPrice": "MARKET" if str(payload.get("orderType", "")).upper() == "MARKET" else money(payload.get("limitPrice")),
        "submittedAt": timestamp,
        "strategy": str(payload.get("strategy", "LLM_AUTONOMOUS_STOCK_TRADER")),
        "signalId": str(payload.get("signalId", UNAVAILABLE)),
        "error": error,
    }


if __name__ == "__main__":
    main()
