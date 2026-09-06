from datetime import datetime, timedelta, timezone

from futu_common import UNAVAILABLE, futu_code, money, now_iso, read_payload, safe_float, ticker_from_futu_code, write_json
from futu_live_fee import normalize_fees
from futu_live_orders import normalize_orders


def main():
    payload = read_payload()
    host = payload.get("host", "127.0.0.1")
    port = int(payload.get("port", 11111))
    account_id = str(payload.get("accountId", "") or "")
    order_id = str(payload.get("orderId", "") or "")
    ticker = str(payload.get("ticker", "") or "").upper()
    start_date, end_date = detail_date_range(payload.get("submittedAt"))

    if not account_id.isdigit():
        write_json(error_response("REAL accountId is required."))
        return
    if not order_id:
        write_json(error_response("Futu REAL orderId is required."))
        return

    try:
        from futu import OpenSecTradeContext, RET_OK, TrdEnv, TrdMarket
    except Exception as exc:
        write_json(error_response(f"futu-api Python SDK unavailable: {exc}"))
        return

    trade_ctx = None
    warnings = []
    try:
        code = futu_code(ticker) if ticker else ""
        trade_ctx = OpenSecTradeContext(
            filter_trdmarket=trade_market_for_code(code, TrdMarket),
            host=host,
            port=port,
            ai_type=1,
        )

        order = query_current_order(trade_ctx, RET_OK, TrdEnv, account_id, order_id, code, warnings)
        if order is None:
            order = query_history_order(
                trade_ctx,
                RET_OK,
                TrdEnv,
                account_id,
                order_id,
                code,
                start_date,
                end_date,
                warnings,
            )
        if order is None:
            write_json(error_response("Futu REAL order was not found.", warnings))
            return

        deals = query_deals(
            trade_ctx,
            RET_OK,
            TrdEnv,
            account_id,
            order_id,
            code,
            start_date,
            end_date,
            warnings,
        )
        fee_context = query_fee(
            trade_ctx,
            RET_OK,
            TrdEnv,
            account_id,
            order_id,
            order.get("currency", "USD"),
            warnings,
        )
        order["feeContext"] = fee_context
        write_json(
            {
                "ok": True,
                "order": order,
                "deals": deals,
                "checkedAt": now_iso(),
                "warnings": warnings,
            }
        )
    except Exception as exc:
        write_json(error_response(f"Futu REAL order detail query unavailable: {exc}", warnings))
    finally:
        if trade_ctx is not None:
            trade_ctx.close()


def query_current_order(trade_ctx, ret_ok, trd_env, account_id, order_id, code, warnings):
    ret, data = trade_ctx.order_list_query(
        order_id=order_id,
        code=code,
        trd_env=trd_env.REAL,
        acc_id=int(account_id),
        refresh_cache=True,
    )
    if ret != ret_ok or data is None:
        warnings.append(f"order_list_query REAL failed: {data}")
        return None
    return find_order(normalize_orders(data), order_id)


def query_history_order(trade_ctx, ret_ok, trd_env, account_id, order_id, code, start_date, end_date, warnings):
    ret, data = trade_ctx.history_order_list_query(
        code=code,
        start=start_date,
        end=end_date,
        trd_env=trd_env.REAL,
        acc_id=int(account_id),
    )
    if ret != ret_ok or data is None:
        warnings.append(f"history_order_list_query REAL failed: {data}")
        return None
    return find_order(normalize_orders(data), order_id)


def find_order(orders, order_id):
    return next((order for order in orders if str(order.get("orderId")) == order_id), None)


def query_deals(trade_ctx, ret_ok, trd_env, account_id, order_id, code, start_date, end_date, warnings):
    rows = []
    ret, current = trade_ctx.deal_list_query(
        code=code,
        trd_env=trd_env.REAL,
        acc_id=int(account_id),
        refresh_cache=True,
    )
    if ret == ret_ok and current is not None:
        rows.extend(normalize_deals(current, order_id))
    else:
        warnings.append(f"deal_list_query REAL failed: {current}")

    ret, history = trade_ctx.history_deal_list_query(
        code=code,
        start=start_date,
        end=end_date,
        trd_env=trd_env.REAL,
        acc_id=int(account_id),
    )
    if ret == ret_ok and history is not None:
        rows.extend(normalize_deals(history, order_id))
    else:
        warnings.append(f"history_deal_list_query REAL failed: {history}")

    result = {}
    for row in rows:
        result[row["dealId"]] = row
    return sorted(result.values(), key=lambda row: row.get("createdAt", ""))


def normalize_deals(data, order_id):
    if not hasattr(data, "iterrows") or getattr(data, "empty", False):
        return []
    deals = []
    for _, row in data.iterrows():
        row_order_id = str(pick(row, ["order_id", "orderID", "orderId"], UNAVAILABLE))
        if row_order_id != order_id:
            continue
        qty = safe_float(pick(row, ["qty", "quantity"], 0)) or 0
        price = safe_float(pick(row, ["price"], 0)) or 0
        code = str(pick(row, ["code"], UNAVAILABLE))
        raw = {str(key): str(value) for key, value in row.to_dict().items()}
        deals.append(
            {
                "dealId": str(pick(row, ["deal_id", "dealID", "dealId"], UNAVAILABLE)),
                "orderId": row_order_id,
                "ticker": ticker_from_futu_code(code).upper(),
                "side": str(pick(row, ["trd_side", "side"], UNAVAILABLE)),
                "quantity": format_number(qty),
                "price": money(price),
                "dealtAmount": money(qty * price),
                "createdAt": str(pick(row, ["create_time", "created_at", "createTime"], UNAVAILABLE)),
                "counterBrokerId": str(pick(row, ["counter_broker_id", "counterBrokerId"], "")),
                "counterBrokerName": str(pick(row, ["counter_broker_name", "counterBrokerName"], "")),
                "rawResponse": raw,
            }
        )
    return deals


def query_fee(trade_ctx, ret_ok, trd_env, account_id, order_id, currency, warnings):
    ret, data = trade_ctx.order_fee_query(
        order_id_list=[order_id],
        trd_env=trd_env.REAL,
        acc_id=int(account_id),
    )
    if ret != ret_ok or data is None:
        warnings.append(f"order_fee_query REAL failed: {data}")
        return unavailable_fee(order_id, currency)
    fees = normalize_fees(data, now_iso())
    if not fees:
        warnings.append("Futu REAL fee is not available yet.")
        return unavailable_fee(order_id, currency)
    return fees[0]


def unavailable_fee(order_id, currency):
    return {
        "source": "unavailable",
        "orderId": order_id,
        "currency": currency or "USD",
        "feeAmount": None,
        "feeDetails": [],
        "queriedAt": now_iso(),
        "warning": "Futu REAL fee is not available yet.",
    }


def detail_date_range(value):
    now = datetime.now(timezone.utc)
    try:
        submitted = datetime.fromisoformat(str(value).replace("Z", "+00:00")) if value else now - timedelta(days=30)
    except ValueError:
        submitted = now - timedelta(days=30)
    start = min(submitted, now) - timedelta(days=1)
    start = max(start, now - timedelta(days=89))
    return start.date().isoformat(), now.date().isoformat()


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


def format_number(value):
    numeric = safe_float(value)
    if numeric is None:
        return UNAVAILABLE
    if numeric.is_integer():
        return str(int(numeric))
    return f"{numeric:.4f}".rstrip("0").rstrip(".")


def error_response(error, warnings=None):
    return {
        "ok": False,
        "error": error,
        "warnings": warnings or [],
    }


if __name__ == "__main__":
    main()
