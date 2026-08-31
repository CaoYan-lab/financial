from futu_common import UNAVAILABLE, now_iso, read_payload, safe_float, write_json


def main():
    payload = read_payload()
    host = payload.get("host", "127.0.0.1")
    port = int(payload.get("port", 11111))
    account_id = str(payload.get("accountId", "") or "")
    order_ids = payload.get("orderIds") or []
    timestamp = now_iso()

    if not account_id.isdigit():
        write_json({"ok": False, "fees": [], "warnings": ["REAL accountId is required."]})
        return
    if not isinstance(order_ids, list) or not all(str(item).strip() for item in order_ids):
        write_json({"ok": False, "fees": [], "warnings": ["orderIds must be a non-empty string array."]})
        return
    if len(order_ids) > 400:
        write_json({"ok": False, "fees": [], "warnings": ["order_fee_query supports at most 400 order IDs per request."]})
        return

    try:
        from futu import OpenSecTradeContext, RET_OK, TrdEnv, TrdMarket
    except Exception as exc:
        write_json({"ok": False, "fees": [], "warnings": [f"futu-api Python SDK unavailable: {exc}"]})
        return

    trade_ctx = None
    try:
        trade_ctx = OpenSecTradeContext(filter_trdmarket=TrdMarket.US, host=host, port=port, ai_type=1)
        ret, data = trade_ctx.order_fee_query(order_id_list=[str(item) for item in order_ids], trd_env=TrdEnv.REAL, acc_id=int(account_id))
        if ret != RET_OK or data is None:
            write_json({"ok": False, "fees": [], "warnings": [f"order_fee_query REAL failed: {data}"]})
            return
        fees = normalize_fees(data, timestamp)
        write_json({"ok": True, "fees": fees, "warnings": [] if fees else ["Futu REAL did not return fee rows for the requested order IDs."]})
    except Exception as exc:
        write_json({"ok": False, "fees": [], "warnings": [f"Futu REAL fee query unavailable: {exc}"]})
    finally:
        if trade_ctx is not None:
            trade_ctx.close()


def normalize_fees(data, timestamp):
    if not hasattr(data, "iterrows") or getattr(data, "empty", False):
        return []
    fees = []
    for _, row in data.iterrows():
        order_id = str(pick(row, ["order_id", "orderID", "orderId"], UNAVAILABLE))
        fee_amount = safe_float(pick(row, ["fee_amount", "feeAmount"], None))
        fees.append(
            {
                "source": "actual_post_trade",
                "orderId": order_id,
                "currency": str(pick(row, ["currency"], "USD")),
                "feeAmount": fee_amount,
                "feeDetails": normalize_fee_details(pick(row, ["fee_details", "feeDetails"], [])),
                "queriedAt": timestamp,
            }
        )
    return fees


def normalize_fee_details(value):
    if value is None:
        return []
    if isinstance(value, list):
        return [detail for item in value for detail in normalize_fee_item(item)]
    if isinstance(value, tuple):
        return normalize_fee_item(value)
    return [{"item": "raw", "amount": 0, "raw": str(value)}]


def normalize_fee_item(item):
    if isinstance(item, dict):
        label = str(item.get("item") or item.get("name") or item.get("fee_type") or "fee")
        amount = safe_float(item.get("amount") or item.get("value") or item.get("fee"))
        return [{"item": label, "amount": amount or 0}]
    if isinstance(item, tuple) and len(item) >= 2:
        amount = safe_float(item[1])
        return [{"item": str(item[0]), "amount": amount or 0}]
    return [{"item": str(item), "amount": 0}]


def pick(row, candidates, fallback):
    for candidate in candidates:
        value = row.get(candidate, None)
        if value is not None and str(value).upper() not in {"", "N/A", "NAN", UNAVAILABLE.upper()}:
            return value
    return fallback


if __name__ == "__main__":
    main()
