#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPECTED_HOST="${CHANGFU_DEPLOY_HOSTNAME:-ECS-0EJj-deploy}"
TAG="${1:?usage: release-live-trading-core.sh vNN-gitsha}"

ACTUAL_HOST="$(hostname -s | tr '[:upper:]' '[:lower:]')"
EXPECTED_HOST_NORMALIZED="$(printf '%s' "$EXPECTED_HOST" | tr '[:upper:]' '[:lower:]')"
if [[ "$ACTUAL_HOST" != "$EXPECTED_HOST_NORMALIZED" ]]; then
  echo "refusing release outside ${EXPECTED_HOST}" >&2
  exit 1
fi
if [[ "${CHANGFU_CONFIRM_RELEASE:-}" != "YES" ]]; then
  echo "set CHANGFU_CONFIRM_RELEASE=YES after reviewing the release command" >&2
  exit 1
fi
if [[ "${CHANGFU_CONFIRM_LIVE_TRADING:-}" != "YES" ]]; then
  echo "set CHANGFU_CONFIRM_LIVE_TRADING=YES to enable both live-trading gates" >&2
  exit 1
fi
if [[ ! "$TAG" =~ ^v[1-9][0-9]*-[a-f0-9]{7,40}$ ]]; then
  echo "immutable tag must match vNN-gitsha" >&2
  exit 1
fi

: "${CHANGFU_GATEWAY_FUNCTION_ID:?required}"
: "${CHANGFU_WORKER_FUNCTION_ID:?required}"
: "${CHANGFU_CR_REGISTRY_ENDPOINT:?required}"
: "${CHANGFU_PUBLIC_API_ORIGIN:?required}"
: "${CHANGFU_WORKER_PROBE_ORIGIN:?required}"

for command in curl flock jq openssl vefaas; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "missing command: $command" >&2
    exit 1
  }
done

NAMESPACE="${CHANGFU_CR_NAMESPACE:-fin}"
REPOSITORY="${CHANGFU_CR_REPOSITORY:-changfu-backend}"
GATEWAY_IMAGE="${CHANGFU_CR_REGISTRY_ENDPOINT}/${NAMESPACE}/${REPOSITORY}:${TAG}-gateway"
WORKER_IMAGE="${CHANGFU_CR_REGISTRY_ENDPOINT}/${NAMESPACE}/${REPOSITORY}:${TAG}-worker"
export CHANGFU_MIGRATOR_IMAGE="${CHANGFU_CR_REGISTRY_ENDPOINT}/${NAMESPACE}/${REPOSITORY}:${TAG}-migrator"

SECRET_DIR="${CHANGFU_SECRET_DIR:-/root/.changfu-secrets}"
PRIVATE_KEY_PATH="${SECRET_DIR}/order-intent-ed25519-private.pem"
PUBLIC_KEY_PATH="${SECRET_DIR}/order-intent-ed25519-public.pem"
ORDER_KEY_ID="${CHANGFU_ORDER_INTENT_KEY_ID:-changfu-order-prod-v1}"
TEMP_FILES=()

cleanup() {
  if ((${#TEMP_FILES[@]} > 0)); then
    rm -f "${TEMP_FILES[@]}"
  fi
}
trap cleanup EXIT

umask 077
mkdir -p "$SECRET_DIR"
if [[ ! -s "$PRIVATE_KEY_PATH" || ! -s "$PUBLIC_KEY_PATH" ]]; then
  openssl genpkey -algorithm ED25519 -out "$PRIVATE_KEY_PATH"
  openssl pkey -in "$PRIVATE_KEY_PATH" -pubout -out "$PUBLIC_KEY_PATH"
fi

exec 9>/var/lock/changfu-live-trading-release.lock
flock -n 9 || {
  echo "another ChangFu live-trading release is active" >&2
  exit 1
}

wait_release() {
  local function_id="$1"
  local label="$2"
  for _ in $(seq 1 90); do
    local status
    status="$(vefaas fn info --id "$function_id" -o json --jq '.data.ReleaseStatus.status' -r)"
    case "$status" in
      done) echo "$label release completed"; return ;;
      failed|aborted) echo "$label release failed: $status" >&2; exit 1 ;;
    esac
    sleep 5
  done
  echo "$label release timed out" >&2
  exit 1
}

configure_function() {
  local function_id="$1"
  local image="$2"
  local role="$3"
  local info_file
  local body_file
  info_file="$(mktemp)"
  body_file="$(mktemp)"
  TEMP_FILES+=("$info_file" "$body_file")
  chmod 600 "$info_file" "$body_file"

  vefaas fn info --id "$function_id" -o json > "$info_file"
  jq \
    --arg role "$role" \
    --arg functionId "$function_id" \
    --arg image "$image" \
    --arg keyId "$ORDER_KEY_ID" \
    --rawfile privateKey "$PRIVATE_KEY_PATH" \
    --rawfile publicKey "$PUBLIC_KEY_PATH" \
    '
      {
        Id:$functionId,
        Source:$image,
        SourceType:"image",
        Envs:(
          (.data.Envs // [])
          | map(select(
              .Key != "CHANGFU_FUTU_LIVE_TRADING_ENABLED"
              and .Key != "CHANGFU_LONGBRIDGE_LIVE_TRADING_ENABLED"
              and .Key != "CHANGFU_ORDER_INTENT_PRIVATE_KEY_PEM"
              and .Key != "CHANGFU_ORDER_INTENT_PUBLIC_KEY_PEM"
              and .Key != "CHANGFU_ORDER_INTENT_KEY_ID"
            ))
          + [
              {Key:"CHANGFU_FUTU_LIVE_TRADING_ENABLED",Value:"true"},
              {Key:"CHANGFU_LONGBRIDGE_LIVE_TRADING_ENABLED",Value:"true"},
              {Key:"CHANGFU_ORDER_INTENT_KEY_ID",Value:$keyId}
            ]
          + if $role == "worker"
            then [{Key:"CHANGFU_ORDER_INTENT_PRIVATE_KEY_PEM",Value:$privateKey}]
            else [{Key:"CHANGFU_ORDER_INTENT_PUBLIC_KEY_PEM",Value:$publicKey}]
            end
        )
      }
    ' "$info_file" > "$body_file"
  vefaas api UpdateFunction --body "@$body_file" -o json \
    | jq -e '.ok == true' >/dev/null
}

configure_and_release() {
  local function_id="$1"
  local image="$2"
  local role="$3"
  configure_function "$function_id" "$image" "$role"
  vefaas fn release --id "$function_id" \
    --description "$TAG $role live trading" -y -o json >/dev/null
  wait_release "$function_id" "$role"
}

"$SCRIPT_DIR/migrate-rds.sh"

configure_and_release "$CHANGFU_WORKER_FUNCTION_ID" "$WORKER_IMAGE" worker
WORKER_HEALTH="$(
  curl --fail --silent --show-error --retry 12 --retry-delay 5 \
    "${CHANGFU_WORKER_PROBE_ORIGIN%/}/internal/v1/health"
)"
jq -e '
  .ok == true
  and .database == true
  and .liveTradingGates.FUTU == true
  and .liveTradingGates.LONGBRIDGE == true
  and .liveOrderSigningConfigured == true
' <<<"$WORKER_HEALTH" >/dev/null

configure_and_release "$CHANGFU_GATEWAY_FUNCTION_ID" "$GATEWAY_IMAGE" gateway
GATEWAY_READY="$(
  curl --fail --silent --show-error --retry 12 --retry-delay 5 \
    "${CHANGFU_PUBLIC_API_ORIGIN%/}/v1/ready"
)"
jq -e '
  .ok == true
  and .database == true
  and .worker == true
  and .liveTradingGates.FUTU == true
  and .liveTradingGates.LONGBRIDGE == true
' <<<"$GATEWAY_READY" >/dev/null

WORKER_GATE_HASH="$(jq -er '.liveTradingGateHash' <<<"$WORKER_HEALTH")"
GATEWAY_GATE_HASH="$(jq -er '.liveTradingGateHash' <<<"$GATEWAY_READY")"
[[ "$WORKER_GATE_HASH" == "$GATEWAY_GATE_HASH" ]] || {
  echo "Gateway and Worker live-trading gate hashes differ" >&2
  exit 1
}

echo "ChangFu live-trading core release completed: $TAG"
