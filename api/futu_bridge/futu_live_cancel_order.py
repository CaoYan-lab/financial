from futu_common import futu_code, read_payload, write_json
from futu_live_order_detail import query_current_order, query_history_order, detail_date_range, trade_market_for_code


CANCELLABLE_STATUSES = {"SUBMITTED", "WAITING_SUBMIT", "FILLED_PART"}


def main():
    payload = read_payload()
    host = payload.get("host", "127.0.0.1")
    port = int(payload.get("port", 11111))
    account_id = str(payload.get("accountId", "") or "")
    order_id = str(payload.get("orderId", "") or "")
    ticker = str(payload.get("ticker", "") or "").upper()
    start_date, end_date = detail_date_range(payload.get("submittedAt"))

    if not account_id.isdigit() or not order_id or not ticker:
        write_json(error_response(order_id, "accountId, orderId and ticker are required."))
        return

    try:
        from futu import ModifyOrderOp, OpenSecTradeContext, RET_OK, TrdEnv, TrdMarket
    except Exception as exc:
        write_json(error_response(order_id, f"futu-api Python SDK unavailable: {exc}"))
        return

    trade_ctx = None
    warnings = []
    try:
        code = futu_code(ticker)
        trade_ctx = OpenSecTradeContext(
            filter_trdmarket=trade_market_for_code(code, TrdMarket),
            host=host,
            port=port,
            ai_type=1,
        )
        order = query_current_order(
            trade_ctx, RET_OK, TrdEnv, account_id, order_id, code, warnings
        )
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
            write_json(error_response(order_id, "Futu REAL order was not found.", warnings))
            return

        status = str(order.get("orderStatus", "")).upper()
        if status not in CANCELLABLE_STATUSES:
            write_json(
                {
                    "ok": True,
                    "accepted": False,
                    "orderId": order_id,
                    "brokerStatus": status,
                    "order": order,
                    "warnings": warnings,
                    "reason": "Order is not cancellable in its current broker status.",
                }
            )
            return

        ret, data = trade_ctx.modify_order(
            ModifyOrderOp.CANCEL,
            order_id,
            0,
            0,
            trd_env=TrdEnv.REAL,
            acc_id=int(account_id),
        )
        if ret != RET_OK:
            write_json(error_response(order_id, f"modify_order CANCEL failed: {data}", warnings))
            return

        row = data.iloc[0].to_dict() if hasattr(data, "empty") and not data.empty else {}
        write_json(
            {
                "ok": True,
                "accepted": True,
                "orderId": order_id,
                "brokerStatus": status,
                "order": order,
                "rawResponse": {str(key): str(value) for key, value in row.items()},
                "warnings": warnings,
            }
        )
    except Exception as exc:
        write_json(error_response(order_id, f"Futu REAL cancel unavailable: {exc}", warnings))
    finally:
        if trade_ctx is not None:
            trade_ctx.close()


def error_response(order_id, error, warnings=None):
    return {
        "ok": False,
        "accepted": False,
        "orderId": order_id,
        "error": error,
        "warnings": warnings or [],
    }


if __name__ == "__main__":
    main()
