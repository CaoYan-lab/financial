from datetime import datetime, timedelta

from futu_common import UNAVAILABLE, futu_code, money, read_payload, safe_float, ticker_from_futu_code, write_json


def main():
    payload = read_payload()
    host = payload.get("host", "127.0.0.1")
    port = int(payload.get("port", 11111))
    account_id = str(payload.get("accountId", "") or "")
    page = clamp_int(payload.get("page"), 1, 1_000_000, 1)
    page_size = clamp_int(payload.get("pageSize"), 1, 100, 12)
    start_date, end_date = normalize_date_range(payload.get("startDate"), payload.get("endDate"))
    ticker = str(payload.get("ticker", "") or "").upper()
    if ticker == "ALL":
        ticker = ""
    status_filter = str(payload.get("status", "ALL") or "ALL").upper()
    side_filter = str(payload.get("side", "ALL") or "ALL").upper()

    if not account_id.isdigit():
        write_json(empty_response(False, account_id, page, page_size, start_date, end_date, ["缺少有效的 Futu REAL 账户编号。"]))
        return

    try:
        from futu import OpenSecTradeContext, RET_OK, TrdEnv, TrdMarket
    except Exception as exc:
        write_json(empty_response(False, account_id, page, page_size, start_date, end_date, [f"Futu Python SDK 不可用：{exc}"]))
        return

    trade_contexts = []
    try:
        code = futu_code(ticker) if ticker else ""
        markets = [trade_market_for_code(code, TrdMarket)] if code else [TrdMarket.US, TrdMarket.HK]
        orders = []
        warnings = []
        succeeded = False
        for market in markets:
            trade_ctx = OpenSecTradeContext(filter_trdmarket=market, host=host, port=port, ai_type=1)
            trade_contexts.append(trade_ctx)
            ret, data = trade_ctx.history_order_list_query(
                code=code,
                start=start_date,
                end=end_date,
                trd_env=TrdEnv.REAL,
                acc_id=int(account_id),
            )
            if ret != RET_OK or data is None:
                warnings.append(f"Futu {market} 历史订单查询失败：{data}")
                continue
            succeeded = True
            orders.extend(normalize_orders(data))
        if not succeeded:
            write_json(empty_response(False, account_id, page, page_size, start_date, end_date, warnings))
            return

        orders = list({order["orderId"]: order for order in orders}.values())
        orders = [
            order
            for order in orders
            if matches_status_filter(order.get("orderStatus"), status_filter)
            and matches_side_filter(order.get("side"), side_filter)
        ]
        orders.sort(key=lambda item: item.get("updatedTime") or item.get("createTime") or "", reverse=True)
        total = len(orders)
        total_pages = max(1, (total + page_size - 1) // page_size)
        safe_page = min(page, total_pages)
        start_index = (safe_page - 1) * page_size
        write_json(
            {
                "ok": True,
                "orders": orders[start_index : start_index + page_size],
                "page": safe_page,
                "pageSize": page_size,
                "total": total,
                "totalPages": total_pages,
                "startDate": start_date,
                "endDate": end_date,
                "accountId": account_id,
                "warnings": warnings,
            }
        )
    except Exception as exc:
        write_json(empty_response(False, account_id, page, page_size, start_date, end_date, [f"Futu REAL 订单查询失败：{exc}"]))
    finally:
        for trade_ctx in trade_contexts:
            trade_ctx.close()


def normalize_orders(data):
    if not hasattr(data, "iterrows") or getattr(data, "empty", False):
        return []
    orders = []
    for _, row in data.iterrows():
        raw = {str(key): str(value) for key, value in row.to_dict().items()}
        code = pick(row, ["code"], UNAVAILABLE)
        status = str(pick(row, ["order_status", "status"], UNAVAILABLE))
        qty = safe_float(pick(row, ["qty", "quantity"], 0)) or 0
        filled_qty = safe_float(pick(row, ["dealt_qty", "filled_qty", "filledQuantity"], 0)) or 0
        remaining_qty = max(0, qty - filled_qty)
        orders.append(
            {
                "orderId": str(pick(row, ["order_id", "orderID", "orderId"], UNAVAILABLE)),
                "ticker": ticker_from_futu_code(str(code)).upper(),
                "code": str(code),
                "side": str(pick(row, ["trd_side", "side"], UNAVAILABLE)),
                "orderType": str(pick(row, ["order_type", "orderType"], UNAVAILABLE)),
                "orderSession": str(pick(row, ["session"], "")),
                "orderStatus": status,
                "orderStatusLabel": status_label(status),
                "quantity": format_number(qty),
                "filledQuantity": format_number(filled_qty),
                "remainingQuantity": format_number(remaining_qty),
                "price": money(pick(row, ["price"], None)),
                "filledAveragePrice": money(pick(row, ["dealt_avg_price", "filled_avg_price", "avg_price"], None)),
                "createTime": str(pick(row, ["create_time", "createTime"], UNAVAILABLE)),
                "updatedTime": str(pick(row, ["updated_time", "update_time", "updatedTime"], pick(row, ["create_time", "createTime"], UNAVAILABLE))),
                "dealtAmount": money(pick(row, ["dealt_amount", "dealtAmount"], None)),
                "currency": str(pick(row, ["currency"], "USD")),
                "remark": str(pick(row, ["remark"], "")),
                "rawResponse": raw,
            }
        )
    return orders


def trade_market_for_code(code, trd_market_cls):
    if code.startswith("HK."):
        return trd_market_cls.HK
    if code.startswith(("SH.", "SZ.")):
        return getattr(trd_market_cls, "CN")
    return trd_market_cls.US


def pick(row, candidates, fallback):
    for candidate in candidates:
        value = row.get(candidate, None)
        if value is not None and str(value).upper() not in {"", "N/A", "NAN", UNAVAILABLE.upper()}:
            return value
    return fallback


def status_label(status):
    normalized = str(status).upper()
    labels = {
        "SUBMITTED": "已提交",
        "WAITING_SUBMIT": "待提交",
        "SUBMITTING": "提交中",
        "FILLED_ALL": "全部成交",
        "FILLED_PART": "部分成交",
        "CANCELLED_ALL": "已撤单",
        "CANCELLED_PART": "部分成交后撤单",
        "FAILED": "失败",
        "SUBMIT_FAILED": "失败",
        "DISABLED": "已失效",
        "DELETED": "已删除",
    }
    return labels.get(normalized, str(status))


def matches_status_filter(status, status_filter):
    normalized_filter = str(status_filter or "ALL").upper()
    if normalized_filter == "ALL":
        return True
    normalized_status = str(status or "").upper()
    groups = {
        "PENDING": {"SUBMITTED", "WAITING_SUBMIT", "SUBMITTING"},
        "FILLED": {"FILLED_ALL"},
        "PARTIALLY_FILLED": {"FILLED_PART"},
        "CANCELED": {"CANCELLED_ALL", "CANCELLED_PART"},
        "FAILED": {"FAILED", "SUBMIT_FAILED", "DISABLED", "DELETED"},
    }
    return normalized_status in groups.get(normalized_filter, set())


def matches_side_filter(side, side_filter):
    normalized_filter = str(side_filter or "ALL").upper()
    if normalized_filter == "ALL":
        return True
    normalized_side = str(side or "").upper()
    if normalized_filter == "BUY":
        return normalized_side.startswith("BUY")
    if normalized_filter == "SELL":
        return normalized_side.startswith("SELL")
    return False


def normalize_date_range(start_date, end_date):
    today = datetime.utcnow().date()
    end = parse_date(end_date) or today
    start = parse_date(start_date) or (end - timedelta(days=7))
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


def clamp_int(value, minimum, maximum, fallback):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(minimum, min(maximum, parsed))


def format_number(value):
    numeric = safe_float(value)
    if numeric is None:
        return UNAVAILABLE
    if numeric.is_integer():
        return str(int(numeric))
    return f"{numeric:.4f}".rstrip("0").rstrip(".")


def empty_response(ok, account_id, page, page_size, start_date, end_date, warnings):
    return {
        "ok": ok,
        "orders": [],
        "page": page,
        "pageSize": page_size,
        "total": 0,
        "totalPages": 1,
        "startDate": start_date,
        "endDate": end_date,
        "accountId": account_id or UNAVAILABLE,
        "warnings": warnings,
    }


if __name__ == "__main__":
    main()
