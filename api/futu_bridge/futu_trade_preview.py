from futu_common import UNAVAILABLE, money, read_payload, safe_float, write_json


def main():
    payload = read_payload()
    ticker = str(payload.get("ticker", "")).upper()
    side = str(payload.get("side", "")).upper()
    quantity = safe_float(payload.get("quantity"))
    order_type = str(payload.get("orderType", "LIMIT")).upper()
    limit_price = safe_float(payload.get("limitPrice"))
    warnings = [
        "This is a live-trading entry preview only. No order is submitted by this endpoint.",
        "Live orders require separate explicit confirmation and must never be auto-generated from research output.",
    ]
    errors = []

    if not ticker:
        errors.append("Ticker is required.")
    if side not in {"BUY", "SELL"}:
        errors.append("Side must be BUY or SELL.")
    if quantity is None or quantity <= 0:
        errors.append("Quantity must be greater than 0.")
    if order_type == "LIMIT" and (limit_price is None or limit_price <= 0):
        errors.append("Limit price is required for LIMIT orders.")

    estimated = (quantity or 0) * (limit_price or 0) if order_type == "LIMIT" else None
    write_json(
        {
            "ok": len(errors) == 0,
            "orderSide": side or UNAVAILABLE,
            "ticker": ticker or UNAVAILABLE,
            "quantity": str(quantity) if quantity is not None else UNAVAILABLE,
            "orderType": order_type,
            "limitPrice": money(limit_price) if limit_price is not None else UNAVAILABLE,
            "estimatedNotional": money(estimated) if estimated is not None else UNAVAILABLE,
            "riskWarnings": errors + warnings,
            "canSubmitLiveOrder": False,
        }
    )


if __name__ == "__main__":
    main()
