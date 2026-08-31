import json
from datetime import datetime, timedelta

from futu_common import read_payload, write_json


def main():
    payload = read_payload()
    code = str(payload.get("futuCode") or payload.get("ticker") or "").upper()
    limit = int(payload.get("limit") or 20)
    lookback_hours = int(payload.get("lookbackHours") or 48)
    generated_at = datetime.now().isoformat()
    if not code:
        write_json(unavailable(generated_at, "Missing futuCode."))
        return
    try:
        from futu import OpenQuoteContext, RET_OK
    except Exception as exc:
        write_json(unavailable(generated_at, f"futu-api Python SDK unavailable: {exc}"))
        return

    try:
        ctx = OpenQuoteContext(host="127.0.0.1", port=11111)
        try:
            fetcher = getattr(ctx, "get_news", None) or getattr(ctx, "request_news", None)
            if fetcher is None:
                write_json(unavailable(generated_at, "Current futu-api SDK does not expose get_news/request_news."))
                return
            result = fetcher(code=code) if fetcher.__name__ == "get_news" else fetcher(code)
            if not isinstance(result, tuple) or len(result) < 2:
                write_json(unavailable(generated_at, f"Unexpected Futu news response: {type(result)}"))
                return
            ret, data = result[0], result[1]
            if ret != RET_OK:
                write_json(unavailable(generated_at, f"Futu news query failed: {data}"))
                return
            rows = dataframe_records(data)
            cutoff = datetime.now() - timedelta(hours=lookback_hours)
            articles = []
            for row in rows:
                published_at = str(row_value(row, "time", "publish_time", "datetime", "updated_time") or "")
                if published_at and older_than(published_at, cutoff):
                    continue
                title = str(row_value(row, "title", "headline", "name") or "").strip()
                if not title:
                    continue
                articles.append(
                    {
                        "title": title,
                        "source": str(row_value(row, "source", "publisher") or "Futu"),
                        "publishedAt": published_at or None,
                        "url": row_value(row, "url", "link"),
                        "summary": row_value(row, "summary", "content", "abstract"),
                    }
                )
                if len(articles) >= limit:
                    break
            write_json(
                {
                    "ok": True,
                    "source": "futu-news",
                    "status": "OK" if articles else "UNAVAILABLE",
                    "generatedAt": generated_at,
                    "articles": articles,
                    "warnings": [] if articles else ["Futu news returned no articles for this ticker/window."],
                }
            )
        finally:
            try:
                ctx.close()
            except Exception:
                pass
    except Exception as exc:
        write_json(unavailable(generated_at, f"Futu news bridge exception: {exc}"))


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


def row_value(row, *names):
    for name in names:
        if isinstance(row, dict) and name in row and row.get(name) is not None:
            return row.get(name)
    return None


def older_than(value, cutoff):
    try:
        normalized = str(value).replace("Z", "+00:00")
        return datetime.fromisoformat(normalized).replace(tzinfo=None) < cutoff
    except Exception:
        return False


def unavailable(generated_at, reason):
    return {
        "ok": True,
        "source": "futu-news",
        "status": "UNAVAILABLE",
        "generatedAt": generated_at,
        "articles": [],
        "warnings": [f"stockNewsContext: UNAVAILABLE - {reason}"],
    }


if __name__ == "__main__":
    main()
