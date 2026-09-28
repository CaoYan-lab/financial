#!/usr/bin/env bash
set -euo pipefail

: "${CHANGFU_PUBLIC_API_ORIGIN:?required}"
: "${CHANGFU_PRIVATE_WORKER_ORIGIN:?required}"
: "${CHANGFU_WORKER_PROBE_ORIGIN:?required}"

case "$CHANGFU_PUBLIC_API_ORIGIN" in
  https://*.invalid*|http://*|*localhost*|*127.0.0.1*)
    echo "invalid production API origin" >&2
    exit 1
    ;;
  https://*) ;;
  *) echo "production API origin must use HTTPS" >&2; exit 1 ;;
esac

for command in curl jq; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "missing command: $command" >&2
    exit 1
  }
done

WORKER_HEALTH="$(
  curl --fail --silent --show-error --retry 6 --retry-delay 5 \
    "${CHANGFU_WORKER_PROBE_ORIGIN%/}/internal/v1/health"
)"
jq -e '.ok == true and .database == true' <<<"$WORKER_HEALTH" >/dev/null

GATEWAY_READY="$(
  curl --fail --silent --show-error --retry 6 --retry-delay 5 \
    "${CHANGFU_PUBLIC_API_ORIGIN%/}/v1/ready"
)"
jq -e '.ok == true and .database == true and .worker == true' \
  <<<"$GATEWAY_READY" >/dev/null

PUBLIC_WORKER_STATUS="$(
  curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    --request POST --header 'content-type: application/json' --data '{}' \
    "${CHANGFU_WORKER_PROBE_ORIGIN%/}/internal/v1/model/runs"
)"
[[ "$PUBLIC_WORKER_STATUS" == "401" ]] || {
  echo "worker public probe must be rejected with 401" >&2
  exit 1
}

echo "deployment verification passed"
