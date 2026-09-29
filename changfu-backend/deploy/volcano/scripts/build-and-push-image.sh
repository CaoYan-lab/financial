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
for command in "$CONTAINER_CLI" jq ve npm node; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "missing command: $command" >&2
    exit 1
  }
done

registry_login() {
  local auth_json=""
  local credential_json=""
  local username=""
  local token=""
  local auth_file="${VEFAAS_AUTH_FILE:-${VEFAAS_HOME:-$HOME}/.vefaas/auth.enc}"

  auth_json="$(
    ve cr GetAuthorizationToken --Registry "$REGISTRY" --output json 2>/dev/null
  )" || auth_json=""

  if [[ -z "$auth_json" && -r "$auth_file" ]]; then
    credential_json="$(
      VEFAAS_AUTH_FILE="$auth_file" node <<'NODE'
const crypto = require('crypto')
const fs = require('fs')

const payload = JSON.parse(fs.readFileSync(process.env.VEFAAS_AUTH_FILE, 'utf8'))
const key = crypto.pbkdf2Sync(
  'vefaas-cli:credential-store:v1',
  'vefaas-cli-salt-v1',
  100_000,
  32,
  'sha256',
)
const decipher = crypto.createDecipheriv(
  'aes-256-gcm',
  key,
  Buffer.from(payload.iv, 'base64'),
  { authTagLength: 16 },
)
decipher.setAuthTag(Buffer.from(payload.tag, 'base64'))
const credentials = JSON.parse(
  Buffer.concat([
    decipher.update(Buffer.from(payload.data, 'base64')),
    decipher.final(),
  ]).toString('utf8'),
)
process.stdout.write(JSON.stringify({ ak: credentials.ak, sk: credentials.sk }))
NODE
    )"
    auth_json="$(
      VOLCENGINE_ACCESS_KEY="$(jq -er '.ak' <<<"$credential_json")" \
      VOLCENGINE_SECRET_KEY="$(jq -er '.sk' <<<"$credential_json")" \
      VOLCENGINE_REGION="${VOLCENGINE_REGION:-cn-beijing}" \
        ve cr GetAuthorizationToken --Registry "$REGISTRY" --output json
    )"
  fi

  username="$(jq -er '.Result.Username' <<<"$auth_json")"
  token="$(jq -er '.Result.AuthorizationToken // .Result.Token' <<<"$auth_json")"
  printf '%s' "$token" |
    "$CONTAINER_CLI" login \
      --username "$username" \
      --password-stdin \
      "$REGISTRY_ENDPOINT" >/dev/null
  unset auth_json credential_json username token
}

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

registry_login

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
