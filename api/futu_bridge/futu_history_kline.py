from datetime import datetime, timedelta

from futu_common import UNAVAILABLE, futu_code, now_iso, read_payload, safe_float, ticker_from_futu_code, write_json


def main():
    payload = read_payload()
    timestamp = now_iso()
    host = payload.get("host", "127.0.0.1")
    port = int(payload.get("port", 11111))
    ticker = str(payload.get("ticker", "") or "").upper()
    interval = str(payload.get("interval", "30m") or "30m").lower()
    start_date, end_date = normalize_date_range(payload.get("startDate"), payload.get("endDate"))
    session_name = str(payload.get("session", "ALL") or "ALL").upper()

    if not ticker:
        write_json(failure(ticker, interval, start_date, end_date, timestamp, "ticker is required."))
        return

    try:
        from futu import KLType, OpenQuoteContext, RET_OK, Session
    except Exception as exc:
        write_json(failure(ticker, interval, start_date, end_date, timestamp, f"futu-api Python SDK unavailable: {exc}"))
        return

    quote_ctx = None
    try:
        quote_ctx = OpenQuoteContext(host=host, port=port)
        ret, data, _ = quote_ctx.request_history_kline(
            futu_code(ticker),
            start=start_date,
            end=end_date,
            ktype=kl_type(interval, KLType),
            max_count=1000,
            extended_time=True,
            session=session_value(session_name, Session),
        )
        if ret != RET_OK or data is None:
            write_json(failure(ticker, interval, start_date, end_date, timestamp, f"request_history_kline failed: {data}"))
            return
        code = futu_code(ticker)
        write_json(
            {
                "ok": True,
                "ticker": ticker_from_futu_code(code).upper(),
                "code": code,
                "interval": interval,
                "startDate": start_date,
                "endDate": end_date,
                "bars": normalize_bars(dataframe_records(data)),
                "updatedAt": timestamp,
                "warnings": [],
            }
        )
    except Exception as exc:
        write_json(failure(ticker, interval, start_date, end_date, timestamp, f"Futu history kline unavailable: {exc}"))
    finally:
        if quote_ctx is not None:
            quote_ctx.close()


def kl_type(interval, KLType):
    if interval == "15m":
        return KLType.K_15M
    if interval == "1d":
        return KLType.K_DAY
    return KLType.K_30M


def session_value(session_name, Session):
    if session_name == "RTH":
        return Session.RTH
    if session_name == "ETH":
        return Session.ETH
    return Session.ALL


def normalize_bars(records):
    bars = []
    for row in records:
        open_price = safe_float(row_value(row, "open"))
        high = safe_float(row_value(row, "high"))
        low = safe_float(row_value(row, "low"))
        close = safe_float(row_value(row, "close"))
        if None in [open_price, high, low, close]:
            continue
        volume = safe_float(row_value(row, "volume", "turnover"))
        item = {
            "time": str(row_value(row, "time_key", "time") or now_iso()),
            "open": open_price,
            "high": high,
            "low": low,
            "close": close,
        }
        if volume is not None:
            item["volume"] = volume
        bars.append(item)
    return bars


def dataframe_records(data):
    if hasattr(data, "to_dict"):
        return data.to_dict("records")
    if isinstance(data, list):
        return data
    return []


def row_value(row, *keys):
    for key in keys:
        if isinstance(row, dict) and key in row:
            value = row.get(key)
            if value is not None and str(value).upper() not in {"", "N/A", "NAN", UNAVAILABLE.upper()}:
                return value
    return None


def normalize_date_range(start_date, end_date):
    today = datetime.utcnow().date()
    end = parse_date(end_date) or today
    start = parse_date(start_date) or (end - timedelta(days=10))
    if start > end:
        start, end = end, start
    return start.isoformat(), end.isoformat()


def parse_date(value):
    if not value:
        return None
    try:
        return datetime.strptime(str(value)[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def failure(ticker, interval, start_date, end_date, timestamp, warning):
    return {
        "ok": False,
        "ticker": ticker or UNAVAILABLE,
        "code": futu_code(ticker) if ticker else UNAVAILABLE,
        "interval": interval,
        "startDate": start_date,
        "endDate": end_date,
        "bars": [],
        "updatedAt": timestamp,
        "warnings": [warning],
    }


if __name__ == "__main__":
    main()
