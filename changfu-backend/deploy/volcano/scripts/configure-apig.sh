#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${SCRIPT_DIR}/../out/apig"
REGION="${VOLCENGINE_REGION:-cn-beijing}"

: "${CHANGFU_APIG_INSTANCE_ID:?required}"
: "${CHANGFU_GATEWAY_FUNCTION_ID:?required}"
: "${CHANGFU_WORKER_FUNCTION_ID:?required}"
: "${CHANGFU_ADMIN_FUNCTION_ID:?required}"

export VE_CALLER_TYPE="${VE_CALLER_TYPE:-ai_agent}"
export VE_CALLER_NAME="${VE_CALLER_NAME:-$(hostname -s)}"
export VE_SKILL_NAME="${VE_SKILL_NAME:-volcengine-cli}"
umask 077
mkdir -p "$OUT_DIR"

jq -n \
  --arg gateway "$CHANGFU_APIG_INSTANCE_ID" \
  '{
    ServiceName:"changfu-desktop-api",
    GatewayId:$gateway,
    Protocol:["HTTPS"],
    AuthSpec:{Enable:false},
    Comments:"ChangFu desktop public API"
  }' > "$OUT_DIR/public-service.json"

jq -n \
  --arg gateway "$CHANGFU_APIG_INSTANCE_ID" \
  '{
    ServiceName:"changfu-worker-internal",
    GatewayId:$gateway,
    Protocol:["HTTPS"],
    AuthSpec:{Enable:false},
    Comments:"ChangFu worker API; Gateway uses the private default domain"
  }' > "$OUT_DIR/private-service.json"

jq -n \
  --arg gateway "$CHANGFU_APIG_INSTANCE_ID" \
  '{
    ServiceName:"changfu-admin",
    GatewayId:$gateway,
    Protocol:["HTTPS"],
    AuthSpec:{Enable:false},
    Comments:"ChangFu internal management web and API"
  }' > "$OUT_DIR/admin-service.json"

create_upstream_body() {
  local name="$1"
  local function_id="$2"
  jq -n \
    --arg name "$name" \
    --arg gateway "$CHANGFU_APIG_INSTANCE_ID" \
    --arg functionId "$function_id" \
    '{
      Name:$name,
      GatewayId:$gateway,
      Comments:"ChangFu veFaaS upstream",
      SourceType:"VeFaas",
      Protocol:"HTTP",
      UpstreamSpec:{VeFaas:{FunctionId:$functionId}},
      LoadBalancerSettings:{LbPolicy:"SimpleLB",SimpleLB:"ROUND_ROBIN",WarmupDuration:5},
      CircuitBreakingSettings:{Enable:true,ConsecutiveErrors:5,Interval:10000,
        BaseEjectionTime:30000,MaxEjectionPercent:50,MinHealthPercent:50}
    }'
}

create_upstream_body "changfu-gateway-vefaas" "$CHANGFU_GATEWAY_FUNCTION_ID" \
  > "$OUT_DIR/gateway-upstream.json"
create_upstream_body "changfu-worker-internal" "$CHANGFU_WORKER_FUNCTION_ID" \
  > "$OUT_DIR/worker-upstream.json"
create_upstream_body "changfu-admin-vefaas" "$CHANGFU_ADMIN_FUNCTION_ID" \
  > "$OUT_DIR/admin-upstream.json"

if [[ "${CHANGFU_APIG_APPLY:-NO}" != "YES" ]]; then
  echo "APIG plan written to $OUT_DIR"
  echo "review it, then set CHANGFU_APIG_APPLY=YES to create resources"
  exit 0
fi
EXPECTED_HOST="${CHANGFU_DEPLOY_HOSTNAME:-ECS-0EJj-deploy}"
ACTUAL_HOST="$(hostname -s | tr '[:upper:]' '[:lower:]')"
EXPECTED_HOST_NORMALIZED="$(printf '%s' "$EXPECTED_HOST" | tr '[:upper:]' '[:lower:]')"
if [[ "$ACTUAL_HOST" != "$EXPECTED_HOST_NORMALIZED" ]]; then
  echo "refusing APIG changes outside ${EXPECTED_HOST}" >&2
  exit 1
fi

call_apig() {
  local action="$1"
  local version="$2"
  local body_file="$3"
  vefaas api "$action" \
    --service apig \
    --api-version "$version" \
    --region "$REGION" \
    --body "@$body_file" \
    --output json
}

PUBLIC_SERVICE_ID="$(
  call_apig CreateGatewayService 2021-03-03 "$OUT_DIR/public-service.json" |
    jq -er '.data.Id'
)"
PRIVATE_SERVICE_ID="$(
  call_apig CreateGatewayService 2021-03-03 "$OUT_DIR/private-service.json" |
    jq -er '.data.Id'
)"
ADMIN_SERVICE_ID="$(
  call_apig CreateGatewayService 2021-03-03 "$OUT_DIR/admin-service.json" |
    jq -er '.data.Id'
)"
GATEWAY_UPSTREAM_ID="$(
  call_apig CreateUpstream 2021-03-03 "$OUT_DIR/gateway-upstream.json" |
    jq -er '.data.Id'
)"
WORKER_UPSTREAM_ID="$(
  call_apig CreateUpstream 2021-03-03 "$OUT_DIR/worker-upstream.json" |
    jq -er '.data.Id'
)"
ADMIN_UPSTREAM_ID="$(
  call_apig CreateUpstream 2021-03-03 "$OUT_DIR/admin-upstream.json" |
    jq -er '.data.Id'
)"

create_route() {
  local name="$1"
  local service_id="$2"
  local upstream_id="$3"
  local path="$4"
  local match_type="$5"
  shift 5
  local methods
  methods="$(printf '%s\n' "$@" | jq -R . | jq -s .)"
  local body
  body="$(jq -n \
    --arg name "$name" \
    --arg service "$service_id" \
    --arg upstream "$upstream_id" \
    --arg path "$path" \
    --arg matchType "$match_type" \
    --argjson methods "$methods" \
    '{
      Name:$name,
      ServiceId:$service,
      MatchRule:{Path:{MatchType:$matchType,MatchContent:$path},Method:$methods},
      UpstreamList:[{Type:"VeFaas",UpstreamId:$upstream,Weight:100}],
      Priority:10,
      Enable:true,
      AdvancedSetting:{TimeoutSetting:{Enable:false}}
    }')"
  vefaas api CreateRoute \
    --service apig \
    --api-version 2022-11-12 \
    --region "$REGION" \
    --body "$body" \
    --output json
}

create_route changfu-public-v1 "$PUBLIC_SERVICE_ID" "$GATEWAY_UPSTREAM_ID" \
  /v1 Prefix GET POST PUT DELETE OPTIONS > "$OUT_DIR/public-route.result.json"
create_route changfu-worker-health "$PRIVATE_SERVICE_ID" "$WORKER_UPSTREAM_ID" \
  /internal/v1/health Exact GET > "$OUT_DIR/worker-health-route.result.json"
create_route changfu-worker-model "$PRIVATE_SERVICE_ID" "$WORKER_UPSTREAM_ID" \
  /internal/v1/model/runs Exact POST > "$OUT_DIR/worker-model-route.result.json"
create_route changfu-worker-sell-put "$PRIVATE_SERVICE_ID" "$WORKER_UPSTREAM_ID" \
  /internal/v1/sell-put/report Exact POST > "$OUT_DIR/worker-sell-put-route.result.json"
create_route changfu-admin-web "$ADMIN_SERVICE_ID" "$ADMIN_UPSTREAM_ID" \
  / Prefix GET POST PUT PATCH DELETE OPTIONS > "$OUT_DIR/admin-route.result.json"

jq -n \
  --arg publicServiceId "$PUBLIC_SERVICE_ID" \
  --arg privateServiceId "$PRIVATE_SERVICE_ID" \
  --arg adminServiceId "$ADMIN_SERVICE_ID" \
  --arg gatewayUpstreamId "$GATEWAY_UPSTREAM_ID" \
  --arg workerUpstreamId "$WORKER_UPSTREAM_ID" \
  --arg adminUpstreamId "$ADMIN_UPSTREAM_ID" \
  '{
    publicServiceId:$publicServiceId,
    privateServiceId:$privateServiceId,
    adminServiceId:$adminServiceId,
    gatewayUpstreamId:$gatewayUpstreamId,
    workerUpstreamId:$workerUpstreamId,
    adminUpstreamId:$adminUpstreamId
  }' > "$OUT_DIR/resources.json"

echo "APIG resources created; IDs written to $OUT_DIR/resources.json"
