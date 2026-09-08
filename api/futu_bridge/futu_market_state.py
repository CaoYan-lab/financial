from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from futu_common import UNAVAILABLE, futu_code, now_iso, read_payload, ticker_from_futu_code, write_json


def main():
    payload = read_payload()
    host = payload.get("host", "127.0.0.1")
    port = int(payload.get("port", 11111))
    tickers = [str(ticker).upper() for ticker in payload.get("tickers", [])]
    timestamp = now_iso()

    try:
        from futu import Market, OpenQuoteContext, RET_OK
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

        rows_by_code = {
            str(row.get("code", UNAVAILABLE)).upper(): str(row.get("market_state", UNAVAILABLE))
            for _, row in data.iterrows()
        }
        calendar = {
            "US": trading_date_status(quote_ctx, Market.US, "US", RET_OK),
            "HK": trading_date_status(quote_ctx, Market.HK, "HK", RET_OK),
        }
        states = []
        for ticker in tickers:
            code = futu_code(ticker).upper()
            market = market_from_code(code)
            calendar_open = calendar[market]
            raw_state = rows_by_code.get(code, UNAVAILABLE)
            state = (
                UNAVAILABLE
                if calendar_open is None
                else raw_state if calendar_open else "CLOSED"
            )
            states.append(normalize_state(code, state, timestamp))
        write_json({"ok": True, "states": states, "updatedAt": timestamp})
    except Exception as exc:
        write_json({"ok": False, "states": fallback_states(tickers, timestamp), "error": f"Market state unavailable: {exc}", "updatedAt": timestamp})
    finally:
        if quote_ctx is not None:
            quote_ctx.close()


def fallback_states(tickers, timestamp):
    return [normalize_state(futu_code(ticker), UNAVAILABLE, timestamp) for ticker in tickers]


def trading_date_status(quote_ctx, market_enum, market, ret_ok):
    session_date = session_date_for_market(market)
    ret, data = quote_ctx.request_trading_days(
        market=market_enum,
        start=session_date,
        end=session_date,
    )
    if ret != ret_ok or data is None:
        return None
    records = data.to_dict("records") if hasattr(data, "to_dict") else list(data)
    dates = {str(row.get("time", "")) for row in records if isinstance(row, dict)}
    return session_date in dates


def session_date_for_market(market):
    zone = ZoneInfo("America/New_York" if market == "US" else "Asia/Hong_Kong")
    local = datetime.now(timezone.utc).astimezone(zone)
    if market == "US" and local.hour >= 20:
        local += timedelta(days=1)
    return local.date().isoformat()


def market_from_code(code):
    return "HK" if str(code).upper().startswith("HK.") else "US"


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
