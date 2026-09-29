#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
EXPECTED_HOST="${CHANGFU_DEPLOY_HOSTNAME:-ECS-0EJj-deploy}"
REGISTRY_ENDPOINT="${CHANGFU_CR_REGISTRY_ENDPOINT:?CHANGFU_CR_REGISTRY_ENDPOINT is required}"
REGISTRY="${CHANGFU_CR_REGISTRY:?CHANGFU_CR_REGISTRY is required}"
NAMESPACE="${CHANGFU_CR_NAMESPACE:-fin}"
REPOSITORY="${CHANGFU_CR_REPOSITORY:-changfu-backend}"
RELEASE="${1:?usage: build-and-push-image.sh vNN}"
CONTAINER_CLI="${CONTAINER_CLI:-podman}"

ACTUAL_HOST="$(hostname -s | tr '[:upper:]' '[:lower:]')"
EXPECTED_HOST_NORMALIZED="$(printf '%s' "$EXPECTED_HOST" | tr '[:upper:]' '[:lower:]')"
if [[ "$ACTUAL_HOST" != "$EXPECTED_HOST_NORMALIZED" ]]; then
  echo "refusing release outside ${EXPECTED_HOST}" >&2
  exit 1
fi
if [[ ! "$RELEASE" =~ ^v[1-9][0-9]*$ ]]; then
  echo "release must match vNN" >&2
  exit 1
fi
for command in "$CONTAINER_CLI" jq ve npm; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "missing command: $command" >&2
    exit 1
  }
done

if git -C "$BACKEND_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  SHA="$(git -C "$BACKEND_ROOT" rev-parse --short=12 HEAD)"
  if [[ -n "$(git -C "$BACKEND_ROOT" status --porcelain -- .)" ]]; then
    echo "refusing immutable build from a dirty changfu-backend tree" >&2
    exit 1
  fi
else
  SHA="${CHANGFU_SOURCE_SHA:?CHANGFU_SOURCE_SHA is required for a source snapshot}"
  [[ "$SHA" =~ ^[a-f0-9]{7,40}$ ]] || {
    echo "CHANGFU_SOURCE_SHA must be a 7-40 character lowercase hex digest" >&2
    exit 1
  }
fi
TAG="${RELEASE}-${SHA}"
GATEWAY_IMAGE="${REGISTRY_ENDPOINT}/${NAMESPACE}/${REPOSITORY}:${TAG}-gateway"
WORKER_IMAGE="${REGISTRY_ENDPOINT}/${NAMESPACE}/${REPOSITORY}:${TAG}-worker"
ADMIN_IMAGE="${REGISTRY_ENDPOINT}/${NAMESPACE}/${REPOSITORY}:${TAG}-admin"
MIGRATOR_IMAGE="${REGISTRY_ENDPOINT}/${NAMESPACE}/${REPOSITORY}:${TAG}-migrator"

export VE_CALLER_TYPE="${VE_CALLER_TYPE:-ai_agent}"
export VE_CALLER_NAME="${VE_CALLER_NAME:-$(hostname -s)}"
export VE_SKILL_NAME="${VE_SKILL_NAME:-volcengine-cli}"

cd "$BACKEND_ROOT"
npm ci
npm run check

"$CONTAINER_CLI" build \
  --target gateway \
  -f deploy/volcano/Dockerfile.vefaas \
  -t "$GATEWAY_IMAGE" \
  .
"$CONTAINER_CLI" build \
  --target worker \
  -f deploy/volcano/Dockerfile.vefaas \
  -t "$WORKER_IMAGE" \
  .
"$CONTAINER_CLI" build \
  --target admin \
  -f deploy/volcano/Dockerfile.vefaas \
  -t "$ADMIN_IMAGE" \
  .
"$CONTAINER_CLI" build \
  --target migrator \
  -f deploy/volcano/Dockerfile.vefaas \
  -t "$MIGRATOR_IMAGE" \
  .

AUTH_JSON="$(ve cr GetAuthorizationToken --Registry "$REGISTRY" --output json)"
CR_USERNAME="$(jq -er '.Result.Username' <<<"$AUTH_JSON")"
CR_TOKEN="$(jq -er '.Result.AuthorizationToken // .Result.Token' <<<"$AUTH_JSON")"
printf '%s' "$CR_TOKEN" |
  "$CONTAINER_CLI" login \
    --username "$CR_USERNAME" \
    --password-stdin \
    "$REGISTRY_ENDPOINT" >/dev/null
unset AUTH_JSON CR_TOKEN CR_USERNAME

"$CONTAINER_CLI" push "$GATEWAY_IMAGE"
"$CONTAINER_CLI" push "$WORKER_IMAGE"
"$CONTAINER_CLI" push "$ADMIN_IMAGE"
"$CONTAINER_CLI" push "$MIGRATOR_IMAGE"

jq -n \
  --arg tag "$TAG" \
  --arg gateway "$GATEWAY_IMAGE" \
  --arg worker "$WORKER_IMAGE" \
  --arg admin "$ADMIN_IMAGE" \
  --arg migrator "$MIGRATOR_IMAGE" \
  '{
    tag:$tag,
    gatewayImage:$gateway,
    workerImage:$worker,
    adminImage:$admin,
    migratorImage:$migrator
  }'
