from datetime import datetime, timedelta

from futu_common import (
    FUTU_DOCS_URL,
    UNAVAILABLE,
    futu_code,
    market_cap,
    money,
    moving_average,
    now_iso,
    option_window,
    percent,
    read_payload,
    rsi,
    safe_float,
    ticker_from_futu_code,
    write_json,
)


def main():
    payload = read_payload()
    host = payload.get("host", "127.0.0.1")
    port = int(payload.get("port", 11111))
    tickers = payload.get("tickers", [])
    include_options = bool(payload.get("includeOptions", True))
    include_technicals = bool(payload.get("includeTechnicals", True))
    timestamp = now_iso()
    source = {
        "source": "Futu OpenD",
        "url": FUTU_DOCS_URL,
        "accessedAt": timestamp,
        "timestamp": timestamp,
    }

    try:
        from futu import (
            AuType,
            KLType,
            OpenQuoteContext,
            OptionType,
            RET_OK,
            SecurityType,
            SubType,
        )
    except Exception as exc:
        write_json(failure(source, f"futu-api Python SDK unavailable: {exc}", tickers))
        return

    quote_ctx = None
    try:
        quote_ctx = OpenQuoteContext(host=host, port=port, ai_type=1)
        codes = [futu_code(ticker) for ticker in tickers]
        snapshot_by_code, snapshot_warnings = fetch_snapshots(quote_ctx, codes, RET_OK)
        if not snapshot_by_code:
            write_json(failure(source, f"get_market_snapshot failed for all requested codes: {'; '.join(snapshot_warnings)}", tickers))
            return
        technicals = {}
        option_rows = {}

        if include_technicals:
            technicals = fetch_technicals(quote_ctx, codes, KLType, AuType)
        if include_options:
            option_rows = fetch_options(quote_ctx, codes, OptionType, SecurityType)

        rows = []
        warnings = snapshot_warnings
        latest_update_time = None
        for ticker in tickers:
            code = futu_code(ticker)
            snap = snapshot_by_code.get(code)
            row_source = source.copy()
            if snap is not None and snap.get("update_time"):
                latest_update_time = snap.get("update_time")
                row_source["timestamp"] = str(snap.get("update_time"))
            rows.append(to_raw_row(ticker, snap, technicals.get(code, {}), option_rows.get(code, {}), row_source))

        if latest_update_time:
            source["timestamp"] = str(latest_update_time)
        if not technicals:
            warnings.append("Technical indicators unavailable; historical K-line access may require permissions.")
        if not option_rows:
            warnings.append("Option data unavailable; option chain or option snapshot access may require permissions.")

        write_json({"ok": True, "source": source, "rows": rows, "warnings": warnings})
    except Exception as exc:
        write_json(failure(source, f"OpenD snapshot bridge failed at {host}:{port}: {exc}", tickers))
    finally:
        if quote_ctx is not None:
            quote_ctx.close()


def fetch_technicals(quote_ctx, codes, KLType, AuType):
    result = {}
    for code in codes:
        try:
            ret, data, _ = quote_ctx.request_history_kline(
                code,
                start=(datetime.utcnow().date() - timedelta(days=420)).isoformat(),
                end=datetime.utcnow().date().isoformat(),
                ktype=KLType.K_DAY,
                autype=AuType.QFQ,
                max_count=260,
            )
            if ret != 0 or data is None or data.empty:
                continue
            closes = [float(value) for value in data["close"].tolist() if safe_float(value) is not None]
            result[code] = {
                "rsi14": rsi(closes),
                "ma50": moving_average(closes, 50),
                "ma200": moving_average(closes, 200),
                "trend20d": return_pct(closes, 20),
                "trend60d": return_pct(closes, 60),
                "trend120d": return_pct(closes, 120),
                "distanceTo52wHigh": distance_to_extreme(closes, max),
                "distanceTo52wLow": distance_to_extreme(closes, min),
                "realizedVol30d": realized_volatility(closes, 30),
            }
        except Exception:
            continue
    return result


def fetch_snapshots(quote_ctx, codes, RET_OK):
    warnings = []
    ret, snapshot = quote_ctx.get_market_snapshot(codes)
    if ret == RET_OK and snapshot is not None and not snapshot.empty:
        return {row["code"]: row for _, row in snapshot.iterrows()}, warnings

    warnings.append(f"Batch snapshot failed: {snapshot}")
    result = {}
    for code in codes:
        try:
            ret_one, snapshot_one = quote_ctx.get_market_snapshot([code])
            if ret_one == RET_OK and snapshot_one is not None and not snapshot_one.empty:
                for _, row in snapshot_one.iterrows():
                    result[row["code"]] = row
            else:
                warnings.append(f"{code} snapshot unavailable: {snapshot_one}")
        except Exception as exc:
            warnings.append(f"{code} snapshot exception: {exc}")
    return result, warnings


def fetch_options(quote_ctx, codes, OptionType, SecurityType):
    result = {}
    start, end = option_window()
    for code in codes:
        try:
            ret, chain = quote_ctx.get_option_chain(code, start=start, end=end, option_type=OptionType.PUT)
            if ret != 0 or chain is None or chain.empty:
                continue
            candidates = []
            for _, row in chain.iterrows():
                option_code = row.get("code")
                strike = safe_float(row.get("strike_price") or row.get("option_strike_price"))
                expiry = row.get("strike_time") or row.get("expiry_date")
                if option_code and strike:
                    candidates.append({"code": option_code, "strike": strike, "expiry": str(expiry) if expiry else UNAVAILABLE})
            if not candidates:
                continue
            option_codes = [item["code"] for item in candidates[:120]]
            ret_snap, option_snapshot = quote_ctx.get_market_snapshot(option_codes)
            if ret_snap != 0 or option_snapshot is None or option_snapshot.empty:
                continue
            best = choose_option(option_snapshot, candidates)
            if best:
                result[code] = best
        except Exception:
            continue
    return result


def choose_option(option_snapshot, candidates):
    by_code = {item["code"]: item for item in candidates}
    scored = []
    for _, row in option_snapshot.iterrows():
        code = row.get("code")
        meta = by_code.get(code)
        if not meta:
            continue
        delta = safe_float(row.get("option_delta"))
        iv = safe_float(row.get("option_implied_volatility"))
        premium, premium_source = option_premium(row)
        delta_score = abs(abs(delta) - 0.30) if delta is not None else 10
        premium_penalty = 0 if premium is not None else 5
        score = premium_penalty + delta_score
        scored.append((score, {**meta, "delta": delta, "iv": iv, "premium": premium, "premiumSource": premium_source}))
    if not scored:
        return None
    scored.sort(key=lambda item: item[0])
    return scored[0][1]


def option_premium(row):
    bid = safe_float(row.get("bid_price"))
    ask = safe_float(row.get("ask_price"))
    if bid is not None and bid > 0 and ask is not None and ask > 0:
        return (bid + ask) / 2, "Futu option snapshot bid_ask_mid"
    if bid is not None and bid > 0:
        return bid, "Futu option snapshot bid_price"
    if ask is not None and ask > 0:
        return ask, "Futu option snapshot ask_price"

    for field in ["last_price", "nominal_price", "price", "close_price", "prev_close_price"]:
        value = safe_float(row.get(field))
        if value is not None and value > 0:
            return value, f"Futu option snapshot {field}"

    return None, UNAVAILABLE


def to_raw_row(ticker, snap, technicals, option_data, source):
    pe_ttm = safe_float(snap.get("pe_ttm_ratio")) if snap is not None else None
    pe = safe_float(snap.get("pe_ratio")) if snap is not None else None
    selected_pe = pe_ttm if pe_ttm is not None else pe
    pe_label = f"{selected_pe:.2f}{' TTM' if pe_ttm is not None else ''}" if selected_pe is not None else UNAVAILABLE
    strike = option_data.get("strike")

    return {
        "ticker": ticker_from_futu_code(futu_code(ticker)),
        "currentPrice": money(snap.get("last_price")) if snap is not None else UNAVAILABLE,
        "marketCap": market_cap(snap.get("total_market_val")) if snap is not None else UNAVAILABLE,
        "peRatio": pe_label,
        "rsi14": f"{technicals.get('rsi14'):.2f}" if technicals.get("rsi14") is not None else UNAVAILABLE,
        "ma50": money(technicals.get("ma50")) if technicals.get("ma50") is not None else UNAVAILABLE,
        "ma200": money(technicals.get("ma200")) if technicals.get("ma200") is not None else UNAVAILABLE,
        "ivRank": UNAVAILABLE,
        "iv30": percent(option_data.get("iv")) if option_data.get("iv") is not None else UNAVAILABLE,
        "nextEarningsDate": UNAVAILABLE,
        "capitalPerContract": money(strike * 100) if strike else UNAVAILABLE,
        "sevenDayNews": UNAVAILABLE,
        "selectedOptionCode": option_data.get("code", UNAVAILABLE),
        "selectedOptionStrike": money(strike) if strike else UNAVAILABLE,
        "selectedOptionExpiry": option_data.get("expiry", UNAVAILABLE),
        "selectedOptionPremium": money(option_data.get("premium")) if option_data.get("premium") is not None else UNAVAILABLE,
        "selectedOptionDelta": f"{option_data.get('delta'):.2f}" if option_data.get("delta") is not None else UNAVAILABLE,
        "selectedOptionPremiumSource": option_data.get("premiumSource", UNAVAILABLE),
        "trend20d": percent(technicals.get("trend20d")) if technicals.get("trend20d") is not None else UNAVAILABLE,
        "trend60d": percent(technicals.get("trend60d")) if technicals.get("trend60d") is not None else UNAVAILABLE,
        "trend120d": percent(technicals.get("trend120d")) if technicals.get("trend120d") is not None else UNAVAILABLE,
        "distanceTo52wHigh": percent(technicals.get("distanceTo52wHigh")) if technicals.get("distanceTo52wHigh") is not None else UNAVAILABLE,
        "distanceTo52wLow": percent(technicals.get("distanceTo52wLow")) if technicals.get("distanceTo52wLow") is not None else UNAVAILABLE,
        "realizedVol30d": percent(technicals.get("realizedVol30d")) if technicals.get("realizedVol30d") is not None else UNAVAILABLE,
        "source": source,
    }


def failure(source, warning, tickers):
    return {
        "ok": False,
        "source": source,
        "warnings": [warning],
        "rows": [
            {
                "ticker": ticker,
                "currentPrice": UNAVAILABLE,
                "marketCap": UNAVAILABLE,
                "peRatio": UNAVAILABLE,
                "rsi14": UNAVAILABLE,
                "ma50": UNAVAILABLE,
                "ma200": UNAVAILABLE,
                "ivRank": UNAVAILABLE,
                "iv30": UNAVAILABLE,
                "nextEarningsDate": UNAVAILABLE,
                "capitalPerContract": UNAVAILABLE,
                "sevenDayNews": UNAVAILABLE,
                "source": source,
            }
            for ticker in tickers
        ],
    }


def return_pct(closes, periods):
    if len(closes) <= periods:
        return None
    base = closes[-periods - 1]
    latest = closes[-1]
    if base <= 0:
        return None
    return ((latest / base) - 1) * 100


def distance_to_extreme(closes, selector):
    if not closes:
        return None
    window = closes[-252:] if len(closes) >= 252 else closes
    extreme = selector(window)
    latest = closes[-1]
    if extreme <= 0:
        return None
    return ((latest / extreme) - 1) * 100


def realized_volatility(closes, periods):
    if len(closes) <= periods:
        return None
    returns = []
    window = closes[-periods - 1 :]
    for index in range(1, len(window)):
        previous = window[index - 1]
        current = window[index]
        if previous > 0:
            returns.append((current / previous) - 1)
    if len(returns) < 2:
        return None
    mean = sum(returns) / len(returns)
    variance = sum((value - mean) ** 2 for value in returns) / (len(returns) - 1)
    return (variance ** 0.5) * (252 ** 0.5) * 100


if __name__ == "__main__":
    main()
