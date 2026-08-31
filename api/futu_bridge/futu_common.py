import json
import math
import sys
from datetime import datetime, timedelta

UNAVAILABLE = "unavailable"
FUTU_DOCS_URL = "https://openapi.futunn.com/futu-api-doc/"


def read_payload():
    raw = sys.stdin.read().strip()
    if not raw:
        return {}
    return json.loads(raw)


def write_json(payload):
    print(json.dumps(payload, ensure_ascii=False))


def now_iso():
    return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def futu_code(ticker):
    upper = str(ticker).upper()
    if upper.startswith(("US.", "HK.", "SH.", "SZ.")):
        return upper
    if upper.isdigit() and len(upper) == 5:
        return f"HK.{upper}"
    return f"US.{upper}"


def ticker_from_futu_code(code):
    return code.split(".", 1)[1] if "." in code else code


def money(value):
    numeric = safe_float(value)
    if numeric is None:
        return UNAVAILABLE
    return f"${numeric:,.2f}"


def market_cap(value):
    numeric = safe_float(value)
    if numeric is None:
        return UNAVAILABLE
    return f"${numeric:,.0f}"


def percent(value):
    numeric = safe_float(value)
    if numeric is None:
        return UNAVAILABLE
    return f"{numeric:.2f}%"


def safe_float(value):
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    if isinstance(value, str) and value.upper() in {"N/A", "NAN", "", UNAVAILABLE}:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def moving_average(values, window):
    if len(values) < window:
        return None
    return sum(values[-window:]) / window


def rsi(values, period=14):
    if len(values) <= period:
        return None
    gains = []
    losses = []
    for index in range(1, period + 1):
        change = values[index] - values[index - 1]
        gains.append(max(change, 0))
        losses.append(abs(min(change, 0)))
    avg_gain = sum(gains) / period
    avg_loss = sum(losses) / period
    for index in range(period + 1, len(values)):
        change = values[index] - values[index - 1]
        gain = max(change, 0)
        loss = abs(min(change, 0))
        avg_gain = ((avg_gain * (period - 1)) + gain) / period
        avg_loss = ((avg_loss * (period - 1)) + loss) / period
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))


def option_window():
    start = datetime.now().date() + timedelta(days=30)
    end = datetime.now().date() + timedelta(days=45)
    return start.isoformat(), end.isoformat()
