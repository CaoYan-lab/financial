#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
EXPECTED_HOST="${CHANGFU_DEPLOY_HOSTNAME:-ECS-0EJj-deploy}"
TAG="${1:?usage: release-from-deploy-host.sh vNN-gitsha}"

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
if [[ ! "$TAG" =~ ^v[1-9][0-9]*-[a-f0-9]{7,40}$ ]]; then
  echo "immutable tag must match vNN-gitsha" >&2
  exit 1
fi

: "${CHANGFU_GATEWAY_FUNCTION_ID:?required}"
: "${CHANGFU_WORKER_FUNCTION_ID:?required}"
: "${CHANGFU_ADMIN_FUNCTION_ID:?required}"
: "${CHANGFU_CR_REGISTRY_ENDPOINT:?required}"
: "${CHANGFU_PUBLIC_API_ORIGIN:?required}"
: "${CHANGFU_PRIVATE_WORKER_ORIGIN:?required}"
: "${CHANGFU_WORKER_PROBE_ORIGIN:?required}"
: "${CHANGFU_ADMIN_ORIGIN:?required}"

NAMESPACE="${CHANGFU_CR_NAMESPACE:-fin}"
REPOSITORY="${CHANGFU_CR_REPOSITORY:-changfu-backend}"
GATEWAY_IMAGE="${CHANGFU_CR_REGISTRY_ENDPOINT}/${NAMESPACE}/${REPOSITORY}:${TAG}-gateway"
WORKER_IMAGE="${CHANGFU_CR_REGISTRY_ENDPOINT}/${NAMESPACE}/${REPOSITORY}:${TAG}-worker"
ADMIN_IMAGE="${CHANGFU_CR_REGISTRY_ENDPOINT}/${NAMESPACE}/${REPOSITORY}:${TAG}-admin"
export CHANGFU_MIGRATOR_IMAGE="${CHANGFU_CR_REGISTRY_ENDPOINT}/${NAMESPACE}/${REPOSITORY}:${TAG}-migrator"

for command in flock vefaas curl jq; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "missing command: $command" >&2
    exit 1
  }
done

exec 9>/var/lock/changfu-backend-release.lock
flock -n 9 || {
  echo "another ChangFu release is active" >&2
  exit 1
}

assert_function_name() {
  local id="$1"
  local expected="$2"
  local actual
  actual="$(vefaas fn info --id "$id" -o json --jq '.data.Name' -r)"
  [[ "$actual" == "$expected" ]] || {
    echo "function $id is $actual, expected $expected" >&2
    exit 1
  }
}

wait_release() {
  local id="$1"
  local label="$2"
  for _ in $(seq 1 90); do
    local status
    status="$(vefaas fn info --id "$id" -o json --jq '.data.ReleaseStatus.status' -r)"
    case "$status" in
      done) echo "$label release completed"; return ;;
      failed|aborted) echo "$label release failed: $status" >&2; exit 1 ;;
    esac
    sleep 5
  done
  echo "$label release timed out" >&2
  exit 1
}

assert_function_name "$CHANGFU_GATEWAY_FUNCTION_ID" "changfu-gateway"
assert_function_name "$CHANGFU_WORKER_FUNCTION_ID" "changfu-decision-worker"
assert_function_name "$CHANGFU_ADMIN_FUNCTION_ID" "changfu-admin"

cd "$BACKEND_ROOT"
"$SCRIPT_DIR/migrate-rds.sh"

vefaas fn config --id "$CHANGFU_WORKER_FUNCTION_ID" \
  --source "$WORKER_IMAGE" --sourceType image -y -o json >/dev/null
vefaas fn release --id "$CHANGFU_WORKER_FUNCTION_ID" \
  --description "$TAG worker" -y -o json >/dev/null
wait_release "$CHANGFU_WORKER_FUNCTION_ID" "Worker"
curl --fail --silent --show-error --retry 12 --retry-delay 5 \
  "${CHANGFU_WORKER_PROBE_ORIGIN%/}/internal/v1/health" >/dev/null

vefaas fn config --id "$CHANGFU_GATEWAY_FUNCTION_ID" \
  --source "$GATEWAY_IMAGE" --sourceType image -y -o json >/dev/null
vefaas fn release --id "$CHANGFU_GATEWAY_FUNCTION_ID" \
  --description "$TAG gateway" -y -o json >/dev/null
wait_release "$CHANGFU_GATEWAY_FUNCTION_ID" "Gateway"

vefaas fn config --id "$CHANGFU_ADMIN_FUNCTION_ID" \
  --source "$ADMIN_IMAGE" --sourceType image -y -o json >/dev/null
vefaas fn release --id "$CHANGFU_ADMIN_FUNCTION_ID" \
  --description "$TAG admin" -y -o json >/dev/null
wait_release "$CHANGFU_ADMIN_FUNCTION_ID" "Admin"

"$SCRIPT_DIR/verify-deployment.sh"
echo "ChangFu release completed: $TAG"
