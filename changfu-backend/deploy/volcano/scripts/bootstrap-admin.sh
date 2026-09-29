#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${SCRIPT_DIR}/../out/admin-bootstrap"
EXPECTED_HOST="${CHANGFU_DEPLOY_HOSTNAME:-ECS-0EJj-deploy}"
REGION="${VOLCENGINE_REGION:-cn-beijing}"

: "${CHANGFU_ADMIN_IMAGE:?required}"
: "${CHANGFU_ADMIN_DATABASE_URL:?required}"
: "${CHANGFU_ADMIN_INITIAL_PASSWORD:?required}"
: "${CHANGFU_MODEL_CREDENTIAL_KEY:?required}"
: "${CHANGFU_APIG_INSTANCE_ID:?required}"
: "${CHANGFU_VPC_ID:?required}"
: "${CHANGFU_SUBNET_IDS:?required}"
: "${CHANGFU_SECURITY_GROUP_ID:?required}"

ACTUAL_HOST="$(hostname -s | tr '[:upper:]' '[:lower:]')"
EXPECTED_HOST_NORMALIZED="$(printf '%s' "$EXPECTED_HOST" | tr '[:upper:]' '[:lower:]')"
if [[ "$ACTUAL_HOST" != "$EXPECTED_HOST_NORMALIZED" ]]; then
  echo "refusing admin bootstrap outside ${EXPECTED_HOST}" >&2
  exit 1
fi
for command in jq vefaas; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "missing command: $command" >&2
    exit 1
  }
done

export VE_CALLER_TYPE="${VE_CALLER_TYPE:-ai_agent}"
export VE_CALLER_NAME="${VE_CALLER_NAME:-$(hostname -s)}"
export VE_SKILL_NAME="${VE_SKILL_NAME:-volcengine-cli}"
umask 077
mkdir -p "$OUT_DIR"

FUNCTION_BODY="$OUT_DIR/function.json"
jq -n \
  --arg image "$CHANGFU_ADMIN_IMAGE" \
  --arg databaseUrl "$CHANGFU_ADMIN_DATABASE_URL" \
  --arg initialPassword "$CHANGFU_ADMIN_INITIAL_PASSWORD" \
  --arg modelKey "$CHANGFU_MODEL_CREDENTIAL_KEY" \
  '{
    Name:"changfu-admin",
    Description:"ChangFu internal Admin Web and API",
    Runtime:"native/v1",
    SourceType:"image",
    Source:$image,
    Command:"bash deploy/volcano/run-admin.sh",
    Port:8000,
    CpuMilli:1000,
    MemoryMB:2048,
    RequestTimeout:60,
    InitializerSec:120,
    ExclusiveMode:false,
    MaxConcurrency:20,
    ProjectName:"default",
    Envs:[
      {Key:"NODE_ENV",Value:"production"},
      {Key:"CHANGFU_ADMIN_DATABASE_URL",Value:$databaseUrl},
      {Key:"CHANGFU_ADMIN_INITIAL_PASSWORD",Value:$initialPassword},
      {Key:"CHANGFU_ADMIN_PORT",Value:"8000"},
      {Key:"CHANGFU_ADMIN_HOST",Value:"0.0.0.0"},
      {Key:"CHANGFU_ADMIN_COOKIE_SECURE",Value:"true"},
      {Key:"CHANGFU_MODEL_CREDENTIAL_KEY",Value:$modelKey}
    ]
  }' > "$FUNCTION_BODY"

if [[ "${CHANGFU_ADMIN_BOOTSTRAP_APPLY:-NO}" != "YES" ]]; then
  echo "admin bootstrap plan written to $OUT_DIR"
  echo "set CHANGFU_ADMIN_BOOTSTRAP_APPLY=YES to create the function and APIG resources"
  exit 0
fi

FUNCTION_RESULT="$OUT_DIR/function.result.json"
vefaas api CreateFunction --body "@$FUNCTION_BODY" \
  --region "$REGION" --output json > "$FUNCTION_RESULT"
FUNCTION_ID="$(jq -er '.data.Id' "$FUNCTION_RESULT")"

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
  --region "$REGION" --output json > "$OUT_DIR/function-vpc.result.json"

SERVICE_BODY="$OUT_DIR/service.json"
jq -n \
  --arg gateway "$CHANGFU_APIG_INSTANCE_ID" \
  '{
    ServiceName:"changfu-admin",
    GatewayId:$gateway,
    Protocol:["HTTPS"],
    AuthSpec:{Enable:false},
    Comments:"ChangFu internal management web and API"
  }' > "$SERVICE_BODY"
vefaas api CreateGatewayService \
  --service apig --api-version 2021-03-03 --region "$REGION" \
  --body "@$SERVICE_BODY" --output json > "$OUT_DIR/service.result.json"
SERVICE_ID="$(jq -er '.data.Id' "$OUT_DIR/service.result.json")"

UPSTREAM_BODY="$OUT_DIR/upstream.json"
jq -n \
  --arg name "changfu-admin-vefaas" \
  --arg gateway "$CHANGFU_APIG_INSTANCE_ID" \
  --arg functionId "$FUNCTION_ID" \
  '{
    Name:$name,
    GatewayId:$gateway,
    Comments:"ChangFu Admin veFaaS upstream",
    SourceType:"VeFaas",
    Protocol:"HTTP",
    UpstreamSpec:{VeFaas:{FunctionId:$functionId}},
    LoadBalancerSettings:{LbPolicy:"SimpleLB",SimpleLB:"ROUND_ROBIN",WarmupDuration:5},
    CircuitBreakingSettings:{Enable:true,ConsecutiveErrors:5,Interval:10000,
      BaseEjectionTime:30000,MaxEjectionPercent:50,MinHealthPercent:50}
  }' > "$UPSTREAM_BODY"
vefaas api CreateUpstream \
  --service apig --api-version 2021-03-03 --region "$REGION" \
  --body "@$UPSTREAM_BODY" --output json > "$OUT_DIR/upstream.result.json"
UPSTREAM_ID="$(jq -er '.data.Id' "$OUT_DIR/upstream.result.json")"

ROUTE_BODY="$OUT_DIR/route.json"
jq -n \
  --arg service "$SERVICE_ID" \
  --arg upstream "$UPSTREAM_ID" \
  '{
    Name:"changfu-admin-web",
    ServiceId:$service,
    MatchRule:{
      Path:{MatchType:"Prefix",MatchContent:"/"},
      Method:["GET","POST","PUT","PATCH","DELETE","OPTIONS"]
    },
    UpstreamList:[{Type:"VeFaas",UpstreamId:$upstream,Weight:100}],
    Priority:10,
    Enable:true,
    AdvancedSetting:{TimeoutSetting:{Enable:false}}
  }' > "$ROUTE_BODY"
vefaas api CreateRoute \
  --service apig --api-version 2022-11-12 --region "$REGION" \
  --body "@$ROUTE_BODY" --output json > "$OUT_DIR/route.result.json"
ROUTE_ID="$(jq -er '.data.Id' "$OUT_DIR/route.result.json")"

ADMIN_ORIGIN="$(
  vefaas gateway services --gateway-id "$CHANGFU_APIG_INSTANCE_ID" -o json \
    --jq ".data.services[] | select(.Id == \"$SERVICE_ID\") | .Domains[] | select(.Type == \"public\") | .Domain" \
    -r
)"
jq -n \
  --arg functionId "$FUNCTION_ID" \
  --arg serviceId "$SERVICE_ID" \
  --arg upstreamId "$UPSTREAM_ID" \
  --arg routeId "$ROUTE_ID" \
  --arg origin "$ADMIN_ORIGIN" \
  '{
    functionId:$functionId,
    serviceId:$serviceId,
    upstreamId:$upstreamId,
    routeId:$routeId,
    origin:$origin
  }' > "$OUT_DIR/resources.json"

echo "admin resources created; IDs written to $OUT_DIR/resources.json"
