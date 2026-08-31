from futu_common import UNAVAILABLE, futu_code, now_iso, read_payload, ticker_from_futu_code, write_json


def main():
    payload = read_payload()
    host = payload.get("host", "127.0.0.1")
    port = int(payload.get("port", 11111))
    tickers = [str(ticker).upper() for ticker in payload.get("tickers", [])]
    timestamp = now_iso()

    try:
        from futu import OpenQuoteContext, RET_OK
    except Exception as exc:
        write_json({"ok": False, "states": [], "error": f"futu-api Python SDK unavailable: {exc}", "updatedAt": timestamp})
        return

    quote_ctx = None
    try:
        quote_ctx = OpenQuoteContext(host=host, port=port, ai_type=1)
        codes = [futu_code(ticker) for ticker in tickers]
        ret, data = quote_ctx.get_market_state(codes)
        if ret != RET_OK or data is None:
            write_json({"ok": False, "states": fallback_states(tickers, timestamp), "error": f"get_market_state failed: {data}", "updatedAt": timestamp})
            return

        states = []
        for _, row in data.iterrows():
            code = str(row.get("code", UNAVAILABLE))
            state = str(row.get("market_state", UNAVAILABLE))
            states.append(normalize_state(code, state, timestamp))
        write_json({"ok": True, "states": states, "updatedAt": timestamp})
    except Exception as exc:
        write_json({"ok": False, "states": fallback_states(tickers, timestamp), "error": f"Market state unavailable: {exc}", "updatedAt": timestamp})
    finally:
        if quote_ctx is not None:
            quote_ctx.close()


def fallback_states(tickers, timestamp):
    return [normalize_state(futu_code(ticker), UNAVAILABLE, timestamp) for ticker in tickers]


def normalize_state(code, state, timestamp):
    state_upper = str(state or UNAVAILABLE).upper()
    label_zh, label_en, tradable, extended = market_label(state_upper)
    return {
        "ticker": ticker_from_futu_code(code).upper(),
        "code": code,
        "state": state_upper,
        "labelZh": label_zh,
        "labelEn": label_en,
        "tradable": tradable,
        "allowsExtendedHours": extended,
        "updatedAt": timestamp,
    }


def market_label(state):
    if state in {"PRE_MARKET_BEGIN", "PRE_MARKET_END"}:
        return "盘前", "Pre-market", True, True
    if state in {"MORNING", "AFTERNOON", "AUCTION", "TRADE_AT_LAST"}:
        return "盘中", "Regular", True, False
    if state in {"AFTER_HOURS_BEGIN", "AFTER_HOURS_END"}:
        return "盘后", "After-hours", True, True
    if state in {"OVERNIGHT", "NIGHT", "NIGHT_OPEN"}:
        return "夜盘", "Overnight", True, True
    if state in {"WAITING_OPEN", "REST"}:
        return "等待开盘", "Waiting open", False, False
    if state in {"CLOSED", "NONE", UNAVAILABLE.upper()}:
        return "休市", "Closed", False, False
    return state, state, False, False


if __name__ == "__main__":
    main()
