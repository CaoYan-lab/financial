from datetime import datetime

from futu_common import read_payload, write_json

MAX_SECTION_ROWS = 12


def main():
    payload = read_payload()
    code = str(payload.get("futuCode") or payload.get("ticker") or "").upper()
    host = payload.get("host", "127.0.0.1")
    port = int(payload.get("port", 11111))
    generated_at = datetime.now().isoformat()
    if not code:
        write_json(unavailable(generated_at, code, "Missing futuCode."))
        return
    try:
        from futu import OpenQuoteContext, RET_OK
    except Exception as exc:
        write_json(unavailable(generated_at, code, f"futu-api Python SDK unavailable: {exc}"))
        return

    sections = {}
    warnings = []
    try:
        ctx = OpenQuoteContext(host=host, port=port)
        try:
            call_section(ctx, "get_research_rating_summary", code, "researchRatingSummary", sections, warnings, RET_OK)
            call_section(ctx, "get_research_analyst_consensus", code, "analystConsensus", sections, warnings, RET_OK)
            call_section(ctx, "get_research_morningstar_report", code, "morningstarReport", sections, warnings, RET_OK)
            call_section(ctx, "get_financial_unusual", code, "financialUnusual", sections, warnings, RET_OK)
            call_section(ctx, "get_capital_flow", code, "capitalFlow", sections, warnings, RET_OK, summarize_capital_flow)
            call_section(ctx, "get_capital_distribution", code, "capitalDistribution", sections, warnings, RET_OK, summarize_capital_distribution)
            call_market_state(ctx, code, sections, warnings, RET_OK)
            call_global_state(ctx, sections, warnings, RET_OK)
        finally:
            try:
                ctx.close()
            except Exception:
                pass
    except Exception as exc:
        write_json(unavailable(generated_at, code, f"Futu stock context exception: {exc}"))
        return

    section_count = sum(1 for value in sections.values() if value is not None)
    status = "OK" if section_count >= 4 and not warnings else "PARTIAL" if section_count else "UNAVAILABLE"
    write_json(
        {
            "ok": True,
            "source": "futu-openapi",
            "status": status,
            "generatedAt": generated_at,
            "futuCode": code,
            "sections": sections,
            "warnings": warnings,
        }
    )


def call_section(ctx, method_name, code, key, sections, warnings, ret_ok, normalizer=None):
    method = getattr(ctx, method_name, None)
    if method is None:
        warnings.append(f"{key}: method {method_name} is unavailable in current futu-api SDK.")
        return
    try:
        ret, data = method(code)
        if ret != ret_ok:
            warnings.append(f"{key}: Futu returned {ret}: {data}")
            return
        normalized = normalize_data(data)
        sections[key] = normalizer(normalized) if normalizer else compact_section(normalized)
    except Exception as exc:
        warnings.append(f"{key}: exception: {exc}")


def call_market_state(ctx, code, sections, warnings, ret_ok):
    method = getattr(ctx, "get_market_state", None)
    if method is None:
        warnings.append("marketState: method get_market_state is unavailable in current futu-api SDK.")
        return
    try:
        ret, data = method([code])
        if ret != ret_ok:
            warnings.append(f"marketState: Futu returned {ret}: {data}")
            return
        sections["marketState"] = compact_section(normalize_data(data))
    except Exception as exc:
        warnings.append(f"marketState: exception: {exc}")


def call_global_state(ctx, sections, warnings, ret_ok):
    method = getattr(ctx, "get_global_state", None)
    if method is None:
        warnings.append("globalState: method get_global_state is unavailable in current futu-api SDK.")
        return
    try:
        ret, data = method()
        if ret != ret_ok:
            warnings.append(f"globalState: Futu returned {ret}: {data}")
            return
        sections["globalState"] = compact_section(normalize_data(data))
    except Exception as exc:
        warnings.append(f"globalState: exception: {exc}")


def normalize_data(data):
    if data is None:
        return None
    if hasattr(data, "to_dict"):
        return data.to_dict("records")
    if isinstance(data, (dict, list, tuple, str, int, float, bool)):
        return data
    return str(data)


def compact_section(value):
    if isinstance(value, list):
        return value[:MAX_SECTION_ROWS]
    return value


def summarize_capital_flow(value):
    rows = value if isinstance(value, list) else []
    if not rows:
        return value
    recent = rows[-MAX_SECTION_ROWS:]
    latest = recent[-1] if recent else {}
    first = rows[0] if rows else {}
    return {
        "rowCount": len(rows),
        "firstTime": row_value(first, "capital_flow_item_time", "last_valid_time"),
        "latestTime": row_value(latest, "capital_flow_item_time", "last_valid_time"),
        "latest": latest,
        "recent": recent,
        "summary": {
            "latestInFlow": row_value(latest, "in_flow"),
            "latestSuperInFlow": row_value(latest, "super_in_flow"),
            "latestBigInFlow": row_value(latest, "big_in_flow"),
            "latestMidInFlow": row_value(latest, "mid_in_flow"),
            "latestSmallInFlow": row_value(latest, "sml_in_flow"),
        },
    }


def summarize_capital_distribution(value):
    rows = value if isinstance(value, list) else []
    if not rows:
        return value
    latest = rows[-1]
    return {
        "rowCount": len(rows),
        "latest": latest,
        "summary": {
            "capitalInSuper": row_value(latest, "capital_in_super"),
            "capitalInBig": row_value(latest, "capital_in_big"),
            "capitalInMid": row_value(latest, "capital_in_mid"),
            "capitalInSmall": row_value(latest, "capital_in_small"),
            "capitalOutSuper": row_value(latest, "capital_out_super"),
            "capitalOutBig": row_value(latest, "capital_out_big"),
            "capitalOutMid": row_value(latest, "capital_out_mid"),
            "capitalOutSmall": row_value(latest, "capital_out_small"),
            "updateTime": row_value(latest, "update_time"),
        },
    }


def row_value(row, *names):
    if not isinstance(row, dict):
        return None
    for name in names:
        if name in row and row.get(name) is not None:
            return row.get(name)
    return None


def unavailable(generated_at, code, reason):
    return {
        "ok": True,
        "source": "futu-openapi",
        "status": "UNAVAILABLE",
        "generatedAt": generated_at,
        "futuCode": code,
        "sections": {},
        "warnings": [f"futuStockContext: UNAVAILABLE - {reason}"],
    }


if __name__ == "__main__":
    main()
