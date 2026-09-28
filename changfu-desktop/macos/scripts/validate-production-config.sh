#!/usr/bin/env bash
set -euo pipefail

: "${CHANGFU_PUBLIC_API_ORIGIN:?CHANGFU_PUBLIC_API_ORIGIN is required}"

case "$CHANGFU_PUBLIC_API_ORIGIN" in
  https://*.invalid*|*localhost*|*127.0.0.1*)
    echo "production API origin cannot use a placeholder or loopback host" >&2
    exit 1
    ;;
  https://*) ;;
  *) echo "production API origin must use HTTPS" >&2; exit 1 ;;
esac

python3 - "$CHANGFU_PUBLIC_API_ORIGIN" <<'PY'
import sys
from urllib.parse import urlparse

url = urlparse(sys.argv[1])
if not url.hostname or url.path not in ("", "/") or url.query or url.fragment:
    raise SystemExit("CHANGFU_PUBLIC_API_ORIGIN must be an HTTPS origin without a path")
PY
