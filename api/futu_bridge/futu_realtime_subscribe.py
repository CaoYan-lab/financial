import json
import sys
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from futu_common import futu_code, read_payload, safe_float, ticker_from_futu_code

MARKET_STATE_TTL_SECONDS = 30


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def now_iso():
    return datetime.now().isoformat()


def fmt_money(value):
    parsed = safe_float(value)
    if parsed is None:
        return "unavailable"
    return f"${parsed:,.2f}"


def fmt_signed_money(value):
    parsed = safe_float(value)
    if parsed is None:
        return "unavailable"
    sign = "+" if parsed >= 0 else "-"
    return f"{sign}${abs(parsed):,.2f}"


def fmt_percent(value):
    parsed = safe_float(value)
    if parsed is None:
        return "unavailable"
    sign = "+" if parsed >= 0 else ""
    return f"{sign}{parsed:.2f}%"


def row_value(row, *names):
    for name in names:
        if name in row and row.get(name) is not None:
            return row.get(name)
    return None


def dataframe_records(data):
    if data is None:
        return []
    if hasattr(data, "to_dict"):
        return data.to_dict("records")
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        return [data]
    return []


def event_ticker_from_futu_code(code, preserve_futu_code=False):
    return str(code).upper() if preserve_futu_code else ticker_from_futu_code(code)


def normalize_quote(row, market_state=None, preserve_futu_code=False):
    code = str(row_value(row, "code") or "")
    ticker = event_ticker_from_futu_code(code, preserve_futu_code)
    session_prefix = quote_session_prefix(market_state, row)
    price = session_value(row, session_prefix, "price") or row_value(row, "last_price", "price")
    change = session_value(row, session_prefix, "change_val") or row_value(row, "change_val", "change")
    change_rate = session_value(row, session_prefix, "change_rate") or row_value(row, "change_rate", "change_percent")
    if safe_float(change) is None:
        change = derived_change(row, price)
    if safe_float(change_rate) is None:
        change_rate = derived_change_rate(row, price, change)
    high = session_value(row, session_prefix, "high_price") or row_value(row, "high_price", "high")
    low = session_value(row, session_prefix, "low_price") or row_value(row, "low_price", "low")
    volume = session_value(row, session_prefix, "volume") or row_value(row, "volume")
    return {
        "ticker": ticker,
        "code": code,
        "name": str(row_value(row, "stock_name", "name") or ticker),
        "price": fmt_money(price),
        "change": fmt_signed_money(change),
        "changePercent": fmt_percent(change_rate),
        "open": fmt_money(row_value(row, "open_price", "open")),
        "high": fmt_money(high),
        "low": fmt_money(low),
        "volume": str(volume or "unavailable"),
        "marketState": str(market_state or "unavailable"),
        "updatedAt": str(row_value(row, "update_time", "time") or now_iso()),
    }


def derived_change(row, price):
    current = safe_float(price)
    previous_close = safe_float(row_value(row, "prev_close_price", "prev_close", "previous_close"))
    if current is None or previous_close is None:
        return None
    return current - previous_close


def derived_change_rate(row, price, change):
    previous_close = safe_float(row_value(row, "prev_close_price", "prev_close", "previous_close"))
    parsed_change = safe_float(change)
    if previous_close is None or previous_close == 0 or parsed_change is None:
        current = safe_float(price)
        if current is None or previous_close is None or previous_close == 0:
            return None
        parsed_change = current - previous_close
    return (parsed_change / previous_close) * 100


def quote_session_prefix(market_state, row=None):
    state = str(market_state or "").upper()
    if state in {"MORNING", "AFTERNOON", "AUCTION", "TRADE_AT_LAST", "REST"}:
        return None
    if state in {"PRE_MARKET_BEGIN", "PRE_MARKET_END"}:
        return "pre"
    if state in {"AFTER_HOURS_BEGIN", "AFTER_HOURS_END"}:
        return "after"
    if state in {"OVERNIGHT", "NIGHT", "NIGHT_OPEN"}:
        return "overnight"
    if row is not None and not state:
        for prefix in ("overnight", "after", "pre"):
            if safe_float(row_value(row, f"{prefix}_price")) is not None:
                return prefix
    return None


def session_value(row, prefix, suffix):
    if not prefix:
        return None
    return row_value(row, f"{prefix}_{suffix}")


def normalize_ticker_points(records):
    points = []
    for row in records[-720:]:
        price = safe_float(row_value(row, "price", "last_price"))
        if price is None:
            continue
        points.append(
            {
                "time": str(row_value(row, "time", "sequence") or now_iso()),
                "price": price,
            }
        )
    return points


def normalize_kline_bars(records):
    bars = []
    for row in records[-240:]:
        open_price = safe_float(row_value(row, "open"))
        high = safe_float(row_value(row, "high"))
        low = safe_float(row_value(row, "low"))
        close = safe_float(row_value(row, "close"))
        if None in [open_price, high, low, close]:
            continue
        bars.append(
            {
                "time": str(row_value(row, "time_key", "time") or now_iso()),
                "open": open_price,
                "high": high,
                "low": low,
                "close": close,
            }
        )
    return bars


def seed_realtime_series(quote_ctx, codes, KLType, RET_OK, Session, preserve_futu_code=False):
    market_states = fetch_market_states(quote_ctx, codes, RET_OK)
    try:
        ret, data = quote_ctx.get_market_snapshot(codes)
        if ret == RET_OK:
            for row in dataframe_records(data):
                code = str(row_value(row, "code") or "")
                quote = normalize_quote(row, market_states.get(code), preserve_futu_code=preserve_futu_code)
                emit({"kind": "quote", "ticker": quote["ticker"], "quote": quote, "updatedAt": quote["updatedAt"]})
        else:
            emit({"kind": "error", "message": f"get_market_snapshot failed: {data}", "updatedAt": now_iso()})
    except Exception as exc:
        emit({"kind": "error", "message": f"get_market_snapshot exception: {exc}", "updatedAt": now_iso()})

    for code in codes:
        try:
            ret, data = quote_ctx.get_rt_ticker(code, num=720)
            if ret == RET_OK:
                emit({"kind": "ticker", "ticker": event_ticker_from_futu_code(code, preserve_futu_code), "points": normalize_ticker_points(dataframe_records(data)), "updatedAt": now_iso()})
            else:
                emit({"kind": "error", "message": f"{code} get_rt_ticker failed: {data}", "updatedAt": now_iso()})
        except Exception as exc:
            emit({"kind": "error", "message": f"{code} get_rt_ticker exception: {exc}", "updatedAt": now_iso()})

        try:
            market_state = market_states.get(code)
            session = history_session_for_market_state(market_state, Session)
            market_now = now_for_futu_code(code)
            market_date = market_now.date()
            history_start = history_start_for_market_state(market_state, market_now).isoformat()
            ret, data, _ = quote_ctx.request_history_kline(
                code,
                start=history_start,
                end=(market_date + timedelta(days=1)).isoformat(),
                ktype=KLType.K_1M,
                max_count=1000,
                extended_time=True,
                session=session,
            )
            if ret == RET_OK:
                emit({"kind": "kline", "ticker": event_ticker_from_futu_code(code, preserve_futu_code), "bars": normalize_kline_bars(dataframe_records(data)), "updatedAt": now_iso()})
            else:
                emit({"kind": "error", "message": f"{code} request_history_kline extended session failed: {data}", "updatedAt": now_iso()})
        except Exception as exc:
            emit({"kind": "error", "message": f"{code} request_history_kline extended session exception: {exc}", "updatedAt": now_iso()})


def history_session_for_market_state(market_state, Session):
    state = str(market_state or "").upper()
    if state in {"MORNING", "AFTERNOON", "AUCTION", "TRADE_AT_LAST"}:
        return Session.ALL
    if state in {"PRE_MARKET_BEGIN", "PRE_MARKET_END", "AFTER_HOURS_BEGIN", "AFTER_HOURS_END"}:
        return Session.ALL
    if state in {"OVERNIGHT", "NIGHT", "NIGHT_OPEN"}:
        return Session.ALL
    return Session.ALL


def now_for_futu_code(code):
    code_upper = str(code or "").upper()
    if code_upper.startswith("HK."):
        return datetime.now(ZoneInfo("Asia/Hong_Kong"))
    if code_upper.startswith(("SH.", "SZ.")):
        return datetime.now(ZoneInfo("Asia/Shanghai"))
    return datetime.now(ZoneInfo("America/New_York"))


def history_start_for_market_state(market_state, market_now):
    state = str(market_state or "").upper()
    market_date = market_now.date()
    if str(getattr(market_now.tzinfo, "key", "")) == "Asia/Shanghai":
        return market_date - timedelta(days=3)
    if state == "MORNING" and market_now.hour < 10:
        return market_date - timedelta(days=3)
    if state in {"PRE_MARKET_BEGIN", "PRE_MARKET_END"}:
        return market_date - timedelta(days=3)
    if state in {"OVERNIGHT", "NIGHT", "NIGHT_OPEN"}:
        return market_date - timedelta(days=1) if market_now.hour < 4 else market_date
    return market_date


def fetch_market_states(quote_ctx, codes, RET_OK):
    try:
        ret, data = quote_ctx.get_market_state(codes)
        if ret != RET_OK:
            return {}
        states = {}
        for row in dataframe_records(data):
            code = str(row_value(row, "code") or "")
            states[code] = str(row_value(row, "market_state") or "")
        return states
    except Exception:
        return {}


def cached_market_states(quote_ctx, codes, RET_OK, cache, force=False):
    now = time.time()
    if not force and cache["values"] and now - cache["updated_at"] < MARKET_STATE_TTL_SECONDS:
        return cache["values"]
    states = fetch_market_states(quote_ctx, codes, RET_OK)
    if states:
        cache["values"] = states
        cache["updated_at"] = now
    return cache["values"]


def normalize_order_book_levels(levels):
    normalized = []
    max_size = 1.0
    raw = []
    for level in levels[:10]:
        if isinstance(level, (list, tuple)):
            price = level[0] if len(level) > 0 else None
            size = level[1] if len(level) > 1 else None
        elif isinstance(level, dict):
            price = row_value(level, "price")
            size = row_value(level, "volume", "size")
        else:
            continue
        parsed_size = safe_float(size) or 0
        max_size = max(max_size, parsed_size)
        raw.append((price, parsed_size))
    for price, size in raw:
        normalized.append({"price": fmt_money(price), "size": str(int(size)), "depth": round((size / max_size) * 100)})
    return normalized


def main():
    payload = read_payload()
    host = payload.get("host", "127.0.0.1")
    port = int(payload.get("port", 11111))
    tickers = [str(ticker).upper() for ticker in payload.get("tickers", [])]
    codes = [futu_code(ticker) for ticker in tickers]
    preserve_futu_code = bool(payload.get("preserveFutuCodeTicker", False))

    try:
        from futu import (
            CurKlineHandlerBase,
            KLType,
            OpenQuoteContext,
            OrderBookHandlerBase,
            RET_OK,
            StockQuoteHandlerBase,
            SubType,
            Session,
            TickerHandlerBase,
        )
    except Exception as exc:
        emit({"kind": "error", "message": f"futu-api Python SDK unavailable: {exc}", "updatedAt": now_iso()})
        return

    class QuoteHandler(StockQuoteHandlerBase):
        def on_recv_rsp(self, rsp_pb):
            ret_code, data = super().on_recv_rsp(rsp_pb)
            if ret_code != RET_OK:
                emit({"kind": "error", "message": str(data), "updatedAt": now_iso()})
                return ret_code, data
            market_states = current_market_states()
            for row in dataframe_records(data):
                code = str(row_value(row, "code") or "")
                quote = normalize_quote(row, market_states.get(code), preserve_futu_code=preserve_futu_code)
                emit({"kind": "quote", "ticker": quote["ticker"], "quote": quote, "updatedAt": quote["updatedAt"]})
            return ret_code, data

    class TickerHandler(TickerHandlerBase):
        def on_recv_rsp(self, rsp_pb):
            ret_code, data = super().on_recv_rsp(rsp_pb)
            if ret_code != RET_OK:
                emit({"kind": "error", "message": str(data), "updatedAt": now_iso()})
                return ret_code, data
            records = dataframe_records(data)
            by_code = {}
            for row in records:
                code = str(row_value(row, "code") or "")
                by_code.setdefault(code, []).append(row)
            for code, items in by_code.items():
                emit({"kind": "ticker", "ticker": event_ticker_from_futu_code(code, preserve_futu_code), "points": normalize_ticker_points(items), "updatedAt": now_iso()})
            return ret_code, data

    class KlineHandler(CurKlineHandlerBase):
        def on_recv_rsp(self, rsp_pb):
            ret_code, data = super().on_recv_rsp(rsp_pb)
            if ret_code != RET_OK:
                emit({"kind": "error", "message": str(data), "updatedAt": now_iso()})
                return ret_code, data
            records = dataframe_records(data)
            by_code = {}
            for row in records:
                code = str(row_value(row, "code") or "")
                by_code.setdefault(code, []).append(row)
            for code, items in by_code.items():
                emit({"kind": "kline", "ticker": event_ticker_from_futu_code(code, preserve_futu_code), "bars": normalize_kline_bars(items), "updatedAt": now_iso()})
            return ret_code, data

    class OrderBookHandler(OrderBookHandlerBase):
        def on_recv_rsp(self, rsp_pb):
            ret_code, data = super().on_recv_rsp(rsp_pb)
            if ret_code != RET_OK:
                emit({"kind": "error", "message": str(data), "updatedAt": now_iso()})
                return ret_code, data
            code = str(data.get("code", "")) if isinstance(data, dict) else ""
            emit(
                {
                    "kind": "orderBook",
                    "ticker": event_ticker_from_futu_code(code, preserve_futu_code),
                    "asks": normalize_order_book_levels(data.get("Ask", []) if isinstance(data, dict) else []),
                    "bids": normalize_order_book_levels(data.get("Bid", []) if isinstance(data, dict) else []),
                    "updatedAt": now_iso(),
                }
            )
            return ret_code, data

    quote_ctx = None
    try:
        quote_ctx = OpenQuoteContext(host=host, port=port, ai_type=1)
        market_state_cache = {"values": {}, "updated_at": 0.0}

        def current_market_states(force=False):
            return cached_market_states(quote_ctx, codes, RET_OK, market_state_cache, force=force)

        quote_ctx.set_handler(QuoteHandler())
        quote_ctx.set_handler(TickerHandler())
        quote_ctx.set_handler(KlineHandler())
        quote_ctx.set_handler(OrderBookHandler())
        sub_types = [SubType.QUOTE, SubType.TICKER, SubType.K_1M, SubType.ORDER_BOOK]
        ret, data = quote_ctx.subscribe(codes, sub_types, is_first_push=True, subscribe_push=True, is_detailed_orderbook=True, extended_time=True, session=Session.ALL)
        if ret != RET_OK:
            emit({"kind": "error", "message": f"subscribe failed: {data}", "updatedAt": now_iso()})
            return
        emit({"kind": "ready", "tickers": tickers, "codes": codes, "updatedAt": now_iso()})
        seed_realtime_series(quote_ctx, codes, KLType, RET_OK, Session, preserve_futu_code=preserve_futu_code)
        while True:
            time.sleep(1)
    except Exception as exc:
        emit({"kind": "error", "message": f"realtime subscribe failed: {exc}", "updatedAt": now_iso()})
    finally:
        if quote_ctx is not None:
            quote_ctx.close()


if __name__ == "__main__":
    main()
