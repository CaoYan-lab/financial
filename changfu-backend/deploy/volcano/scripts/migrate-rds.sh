#!/usr/bin/env bash
set -euo pipefail

EXPECTED_HOST="${CHANGFU_DEPLOY_HOSTNAME:-ECS-0EJj-deploy}"

ACTUAL_HOST="$(hostname -s | tr '[:upper:]' '[:lower:]')"
EXPECTED_HOST_NORMALIZED="$(printf '%s' "$EXPECTED_HOST" | tr '[:upper:]' '[:lower:]')"
if [[ "$ACTUAL_HOST" != "$EXPECTED_HOST_NORMALIZED" ]]; then
  echo "refusing migration outside ${EXPECTED_HOST}" >&2
  exit 1
fi
: "${CHANGFU_MIGRATION_DATABASE_URL:?CHANGFU_MIGRATION_DATABASE_URL is required}"
: "${CHANGFU_DATABASE_URL:?CHANGFU_DATABASE_URL must use the runtime role}"
: "${CHANGFU_RUNTIME_DB_ROLE:?CHANGFU_RUNTIME_DB_ROLE is required}"
: "${CHANGFU_RUNTIME_DB_PASSWORD:?CHANGFU_RUNTIME_DB_PASSWORD is required}"
: "${CHANGFU_MIGRATOR_IMAGE:?CHANGFU_MIGRATOR_IMAGE is required}"
: "${CHANGFU_VPC_ID:?CHANGFU_VPC_ID is required}"
: "${CHANGFU_SUBNET_IDS:?CHANGFU_SUBNET_IDS is required}"
: "${CHANGFU_SECURITY_GROUP_ID:?CHANGFU_SECURITY_GROUP_ID is required}"

for command in jq vefaas; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "missing command: $command" >&2
    exit 1
  }
done

export VE_CALLER_TYPE="${VE_CALLER_TYPE:-ai_agent}"
export VE_CALLER_NAME="${VE_CALLER_NAME:-$(hostname -s)}"
export VE_SKILL_NAME="${VE_SKILL_NAME:-volcengine-cli}"

NAME="changfu-migrator-$(date +%s)"
BODY="$(mktemp)"
RESULT="$(mktemp)"
FUNCTION_ID=""

cleanup() {
  rm -f "$BODY" "$RESULT"
  if [[ -n "$FUNCTION_ID" ]]; then
    vefaas api DeleteFunction --Id "$FUNCTION_ID" \
      --region "${VOLCENGINE_REGION:-cn-beijing}" --output json >/dev/null || true
  fi
}
trap cleanup EXIT

jq -n \
  --arg name "$NAME" \
  --arg image "$CHANGFU_MIGRATOR_IMAGE" \
  --arg migrationDatabaseUrl "$CHANGFU_MIGRATION_DATABASE_URL" \
  --arg runtimeDatabaseUrl "$CHANGFU_DATABASE_URL" \
  --arg runtimeRole "$CHANGFU_RUNTIME_DB_ROLE" \
  --arg runtimePassword "$CHANGFU_RUNTIME_DB_PASSWORD" \
  '{
    Name:$name,
    Description:"Ephemeral ChangFu database migrator",
    Runtime:"native/v1",
    SourceType:"image",
    Source:$image,
    Command:"bash deploy/volcano/run-migrator.sh",
    Port:8000,
    CpuMilli:1000,
    MemoryMB:2048,
    RequestTimeout:330,
    InitializerSec:120,
    ExclusiveMode:true,
    MaxConcurrency:1,
    ProjectName:"default",
    Envs:[
      {Key:"NODE_ENV",Value:"production"},
      {Key:"CHANGFU_MIGRATION_DATABASE_URL",Value:$migrationDatabaseUrl},
      {Key:"CHANGFU_RUNTIME_DATABASE_URL",Value:$runtimeDatabaseUrl},
      {Key:"CHANGFU_RUNTIME_DB_ROLE",Value:$runtimeRole},
      {Key:"CHANGFU_RUNTIME_DB_PASSWORD",Value:$runtimePassword}
    ]
  }' > "$BODY"
chmod 600 "$BODY"

vefaas api CreateFunction --body "@$BODY" \
  --region "${VOLCENGINE_REGION:-cn-beijing}" --output json > "$RESULT"
FUNCTION_ID="$(jq -er '.data.Id' "$RESULT")"

VPC_CONFIG="$(
  jq -n \
    --arg vpc "$CHANGFU_VPC_ID" \
    --arg subnets "$CHANGFU_SUBNET_IDS" \
    --arg securityGroup "$CHANGFU_SECURITY_GROUP_ID" \
    '{
      EnableVpc:true,
      VpcId:$vpc,
      SubnetIds:($subnets | split(",")),
      SecurityGroupIds:[$securityGroup],
      EnableSharedInternetAccess:true
    }'
)"
vefaas api UpdateFunction --Id "$FUNCTION_ID" --VpcConfig "$VPC_CONFIG" \
  --region "${VOLCENGINE_REGION:-cn-beijing}" --output json > "$RESULT"
jq -e '.ok == true' "$RESULT" >/dev/null

for _ in $(seq 1 60); do
  vefaas api GetImageSyncStatus --FunctionId "$FUNCTION_ID" \
    --Source "$CHANGFU_MIGRATOR_IMAGE" \
    --region "${VOLCENGINE_REGION:-cn-beijing}" --output json > "$RESULT"
  STATUS="$(jq -r '.data.ImageCacheStatus // .data.Status // "unknown"' "$RESULT")"
  case "$STATUS" in
    Ready|Succeeded) break ;;
    Failed|failed) echo "migrator image cache failed" >&2; exit 1 ;;
  esac
  sleep 5
done
[[ "$STATUS" == "Ready" || "$STATUS" == "Succeeded" ]] || {
  echo "migrator image cache timed out" >&2
  exit 1
}

vefaas api Release --FunctionId "$FUNCTION_ID" --RevisionNumber 0 \
  --Description "database migration" --MaxInstance 1 \
  --TargetTrafficWeight 100 --RollingStep 100 \
  --region "${VOLCENGINE_REGION:-cn-beijing}" --output json > "$RESULT"
jq -e '.ok == true' "$RESULT" >/dev/null

for _ in $(seq 1 66); do
  vefaas api GetReleaseStatus --FunctionId "$FUNCTION_ID" \
    --region "${VOLCENGINE_REGION:-cn-beijing}" --output json > "$RESULT"
  STATUS="$(jq -r '.data.Status // .data.status // "unknown"' "$RESULT")"
  case "$STATUS" in
    done|Done|Succeeded|succeeded) break ;;
    failed|Failed|aborted|Aborted) echo "migrator release failed" >&2; exit 1 ;;
  esac
  sleep 5
done
[[ "$STATUS" =~ ^(done|Done|Succeeded|succeeded)$ ]] || {
  echo "migrator release timed out" >&2
  exit 1
}

vefaas fn invoke --id "$FUNCTION_ID" --method GET --path / \
  --region "${VOLCENGINE_REGION:-cn-beijing}" --output json > "$RESULT"
jq -e '
  .ok == true
  and .data.statusCode == 200
  and (.data.response | fromjson | .ok == true and .migration == "verified")
' "$RESULT" >/dev/null
echo "database migration and runtime-role verification passed"
