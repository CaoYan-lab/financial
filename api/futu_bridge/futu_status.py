from datetime import datetime, timedelta

from futu_common import FUTU_DOCS_URL, now_iso, read_payload, write_json


def main():
    payload = read_payload()
    host = payload.get("host", "127.0.0.1")
    port = int(payload.get("port", 11111))
    status = {
        "ok": False,
        "futuPythonSdkAvailable": False,
        "futuOpenDAvailable": False,
        "futuOpenDLoggedIn": False,
        "optionsDataAvailable": False,
        "technicalDataAvailable": False,
        "source": {
            "source": "Futu OpenD",
            "url": FUTU_DOCS_URL,
            "accessedAt": now_iso(),
            "timestamp": now_iso(),
        },
        "missingCapabilities": [],
    }

    try:
        from futu import KLType, OpenQuoteContext, OptionType, RET_OK

        status["futuPythonSdkAvailable"] = True
    except Exception as exc:
        status["missingCapabilities"].append(f"futu-api Python SDK unavailable: {exc}")
        write_json(status)
        return

    quote_ctx = None
    try:
        quote_ctx = OpenQuoteContext(host=host, port=port, ai_type=1)
        ret, data = quote_ctx.get_global_state()
        if ret == RET_OK:
            status["futuOpenDAvailable"] = True
            status["futuOpenDLoggedIn"] = bool(data.get("qot_logined", False)) if isinstance(data, dict) else True
            status["technicalDataAvailable"] = check_technicals(quote_ctx, KLType, RET_OK)
            status["optionsDataAvailable"] = check_options(quote_ctx, OptionType, RET_OK)
        else:
            status["missingCapabilities"].append(str(data))
    except Exception as exc:
        status["missingCapabilities"].append(f"OpenD connection failed at {host}:{port}: {exc}")
    finally:
        if quote_ctx is not None:
            quote_ctx.close()

    status["ok"] = status["futuPythonSdkAvailable"] and status["futuOpenDAvailable"]
    if not status["futuOpenDLoggedIn"]:
        status["missingCapabilities"].append("OpenD must be running and manually logged in.")
    if not status["optionsDataAvailable"]:
        status["missingCapabilities"].append("Options data availability requires OpenD login and market data permissions.")
    if not status["technicalDataAvailable"]:
        status["missingCapabilities"].append("Technical indicators require historical K-line access.")

    write_json(status)


def check_technicals(quote_ctx, KLType, RET_OK):
    try:
        end = datetime.utcnow().date()
        start = end - timedelta(days=20)
        ret, data, _ = quote_ctx.request_history_kline(
            "US.SPY",
            start=start.isoformat(),
            end=end.isoformat(),
            ktype=KLType.K_DAY,
            max_count=5,
        )
        return ret == RET_OK and data is not None and not data.empty
    except Exception:
        return False


def check_options(quote_ctx, OptionType, RET_OK):
    try:
        start = (datetime.utcnow().date() + timedelta(days=30)).isoformat()
        end = (datetime.utcnow().date() + timedelta(days=45)).isoformat()
        ret, data = quote_ctx.get_option_chain("US.SPY", start=start, end=end, option_type=OptionType.PUT)
        return ret == RET_OK and data is not None and not data.empty
    except Exception:
        return False


if __name__ == "__main__":
    main()
