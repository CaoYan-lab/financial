import json
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from futu_common import now_iso, read_payload, write_json

BOARD_ALIASES = {"科创板", "科創板", "STAR", "STAR MARKET", "SCI-TECH", "SCI TECH"}
EASTMONEY_A_SHARE_FS = "m:1+t:2,m:1+t:23,m:0+t:6,m:0+t:80"


def normalize_query(query):
    normalized = str(query or "").strip().upper()
    if "." in normalized:
        exchange, code = normalized.split(".", 1)
        if exchange in {"SH", "SZ"} and code.isdigit() and len(code) == 6:
            return exchange, code
        return None, None
    if normalized.isdigit() and len(normalized) == 6:
        return None, normalized
    return None, None


def normalize_text(value):
    return str(value or "").strip().upper().replace(" ", "")


def infer_board(code):
    body = str(code or "").split(".", 1)[-1]
    exchange = str(code or "").split(".", 1)[0] if "." in str(code or "") else ""
    if exchange == "SH" and body.startswith("688"):
        return "STAR"
    if exchange == "SH":
        return "SH_MAIN"
    if exchange == "SZ" and body.startswith(("300", "301")):
        return "CHINEXT"
    if exchange == "SZ":
        return "SZ_MAIN"
    return "UNKNOWN"


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


def normalize_candidate(row, fallback_exchange):
    code = str(row_value(row, "code") or "").upper()
    if "." not in code:
        raw_code = str(row_value(row, "stock_code", "symbol") or "").zfill(6)
        code = f"{fallback_exchange}.{raw_code}"
    exchange = code.split(".", 1)[0]
    if exchange not in {"SH", "SZ"}:
        return None
    ticker_body = code.split(".", 1)[1]
    name = str(row_value(row, "name", "stock_name", "stock_name_cn") or code)
    raw_type = str(row_value(row, "stock_type", "security_type", "type") or "STOCK").upper()
    asset_type = "ETF" if "ETF" in raw_type else "STOCK"
    return {
        "ticker": code,
        "futuCode": code,
        "name": name,
        "market": "CN",
        "exchange": exchange,
        "tradingCurrency": "CNY",
        "assetType": asset_type,
        "board": infer_board(code),
        "raw": {str(key): str(value) for key, value in row.items()},
    }


def lookup_from_market(quote_ctx, market, security_type, exchange, matcher, RET_OK):
    ret, data = quote_ctx.get_stock_basicinfo(market, security_type)
    if ret != RET_OK:
        return []
    candidates = []
    for row in dataframe_records(data):
        normalized = normalize_candidate(row, exchange)
        if not normalized:
            continue
        if matcher(normalized):
            candidates.append(normalized)
    return candidates


def build_matcher(mode, query, requested_exchange, code):
    normalized_query = normalize_text(query)
    if mode == "code":
        return lambda candidate: candidate["ticker"].split(".", 1)[1] == code and (not requested_exchange or candidate["exchange"] == requested_exchange)
    if normalized_query in BOARD_ALIASES:
        return lambda candidate: candidate.get("board") == "STAR"
    return lambda candidate: matches_name_or_code(candidate, normalized_query)


def matches_name_or_code(candidate, normalized_query):
    code = normalize_text(candidate.get("ticker", "").split(".", 1)[-1])
    futu_code = normalize_text(candidate.get("futuCode", ""))
    name = normalize_text(candidate.get("name", ""))
    return normalized_query in name or normalized_query in code or normalized_query in futu_code


def candidate_rank(candidate, query):
    normalized_query = normalize_text(query)
    name = normalize_text(candidate.get("name", ""))
    code = normalize_text(candidate.get("ticker", "").split(".", 1)[-1])
    if name == normalized_query or code == normalized_query:
        return (0, candidate.get("ticker", ""))
    if name.startswith(normalized_query) or code.startswith(normalized_query):
        return (1, candidate.get("ticker", ""))
    if candidate.get("board") == "STAR":
        return (2, candidate.get("ticker", ""))
    return (3, candidate.get("ticker", ""))


def fetch_eastmoney_candidates(query):
    normalized_query = normalize_text(query)
    is_star_query = normalized_query in BOARD_ALIASES
    if not is_star_query:
        suggest_candidates = fetch_eastmoney_suggest_candidates(query)
        if suggest_candidates:
            return suggest_candidates
    params = {
        "pn": "1",
        "pz": "800",
        "po": "1",
        "np": "1",
        "ut": "bd1d9ddb04089700cf9c27f6f7426281",
        "fltt": "2",
        "invt": "2",
        "fid": "f3",
        "fs": "m:1+t:23" if is_star_query else EASTMONEY_A_SHARE_FS,
        "fields": "f12,f13,f14,f100",
    }
    url = f"https://push2.eastmoney.com/api/qt/clist/get?{urlencode(params)}"
    request = Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urlopen(request, timeout=8) as response:
        payload = json.loads(response.read().decode("utf-8"))
    rows = payload.get("data", {}).get("diff", [])
    candidates = []
    for row in rows:
        candidate = normalize_eastmoney_candidate(row)
        if not candidate:
            continue
        if is_star_query or matches_name_or_code(candidate, normalized_query):
            candidates.append(candidate)
    candidates.sort(key=lambda candidate: candidate_rank(candidate, query))
    return candidates[:50]


def fetch_eastmoney_suggest_candidates(query):
    params = {
        "input": query,
        "type": "14",
        "token": "44c9d251add88e27b65ed86506f6e5da",
    }
    url = f"https://searchapi.eastmoney.com/api/suggest/get?{urlencode(params)}"
    request = Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urlopen(request, timeout=8) as response:
        payload = json.loads(response.read().decode("utf-8"))
    rows = payload.get("QuotationCodeTable", {}).get("Data", [])
    candidates = []
    for row in rows:
        candidate = normalize_eastmoney_suggest_candidate(row)
        if candidate:
            candidates.append(candidate)
    candidates.sort(key=lambda candidate: candidate_rank(candidate, query))
    return candidates[:50]


def normalize_eastmoney_suggest_candidate(row):
    code = str(row.get("Code") or row.get("UnifiedCode") or "").strip()
    name = str(row.get("Name") or "").strip()
    classify = str(row.get("Classify") or "").upper()
    security_type_name = str(row.get("SecurityTypeName") or "")
    market_num = str(row.get("MktNum") or row.get("MarketType") or "").strip()
    if not code.isdigit() or len(code) != 6 or not name:
        return None
    is_a_share_type = (
        classify in {"ASTOCK", "FUND", "ETF"}
        or "A" in security_type_name
        or "基金" in security_type_name
        or "科创板" in security_type_name
        or "科創板" in security_type_name
        or "创业板" in security_type_name
        or "創業板" in security_type_name
    )
    if not is_a_share_type:
        return None
    exchange = "SH" if market_num == "1" or code.startswith(("6", "9", "5")) else "SZ"
    futu_code = f"{exchange}.{code}"
    asset_type = "ETF" if classify in {"FUND", "ETF"} or "基金" in security_type_name else "STOCK"
    return {
        "ticker": futu_code,
        "futuCode": futu_code,
        "name": name,
        "market": "CN",
        "exchange": exchange,
        "tradingCurrency": "CNY",
        "assetType": asset_type,
        "board": infer_board(futu_code),
        "raw": {"source": "eastmoney_suggest", **{str(key): str(value) for key, value in row.items()}},
    }


def normalize_eastmoney_candidate(row):
    code = str(row.get("f12") or "").strip()
    name = str(row.get("f14") or "").strip()
    market = str(row.get("f13") or "").strip()
    if not code.isdigit() or len(code) != 6 or not name:
        return None
    exchange = "SH" if market == "1" or code.startswith(("6", "9")) else "SZ"
    futu_code = f"{exchange}.{code}"
    return {
        "ticker": futu_code,
        "futuCode": futu_code,
        "name": name,
        "market": "CN",
        "exchange": exchange,
        "tradingCurrency": "CNY",
        "assetType": "STOCK",
        "board": infer_board(futu_code),
        "raw": {"source": "eastmoney", **{str(key): str(value) for key, value in row.items()}},
    }


def main():
    payload = read_payload()
    query = payload.get("query", "")
    mode = str(payload.get("mode") or "").lower()
    host = payload.get("host", "127.0.0.1")
    port = int(payload.get("port", 11111))
    requested_exchange, code = normalize_query(query)
    timestamp = now_iso()
    if code:
        mode = "code"
    elif mode != "name":
        write_json({"ok": False, "query": query, "candidates": [], "error": "Invalid A-share query.", "updatedAt": timestamp})
        return

    try:
        from futu import Market, OpenQuoteContext, RET_OK, SecurityType
    except Exception as exc:
        write_json({"ok": False, "query": query, "candidates": [], "error": f"futu-api Python SDK unavailable: {exc}", "updatedAt": timestamp})
        return

    quote_ctx = None
    try:
        quote_ctx = OpenQuoteContext(host=host, port=port, ai_type=1)
        market_by_exchange = {
            "SH": getattr(Market, "SH"),
            "SZ": getattr(Market, "SZ"),
        }
        security_types = [getattr(SecurityType, "STOCK")]
        if hasattr(SecurityType, "ETF"):
            security_types.append(getattr(SecurityType, "ETF"))
        exchanges = [requested_exchange] if requested_exchange else ["SH", "SZ"]
        matcher = build_matcher(mode, query, requested_exchange, code)
        candidates = []
        seen = set()
        for exchange in exchanges:
            for security_type in security_types:
                for candidate in lookup_from_market(quote_ctx, market_by_exchange[exchange], security_type, exchange, matcher, RET_OK):
                    key = candidate["futuCode"]
                    if key not in seen:
                        candidates.append(candidate)
                        seen.add(key)
        if mode == "name":
            try:
                for candidate in fetch_eastmoney_candidates(query):
                    key = candidate["futuCode"]
                    if key not in seen:
                        candidates.append(candidate)
                        seen.add(key)
            except Exception as exc:
                # Futu remains the authoritative subscription source. Eastmoney is only a Chinese-name lookup fallback.
                pass
        candidates.sort(key=lambda candidate: candidate_rank(candidate, query))
        candidates = candidates[:50]
        write_json({"ok": True, "query": query, "candidates": candidates, "updatedAt": timestamp})
    except Exception as exc:
        write_json({"ok": False, "query": query, "candidates": [], "error": f"Futu A-share lookup unavailable: {exc}", "updatedAt": timestamp})
    finally:
        if quote_ctx is not None:
            quote_ctx.close()


if __name__ == "__main__":
    main()
