#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPECTED_HOST="${CHANGFU_DEPLOY_HOSTNAME:-ECS-0EJj-deploy}"
OUT_DIR="${1:-${SCRIPT_DIR}/../out/inventory}"
REGION="${VOLCENGINE_REGION:-cn-beijing}"

ACTUAL_HOST="$(hostname -s | tr '[:upper:]' '[:lower:]')"
EXPECTED_HOST_NORMALIZED="$(printf '%s' "$EXPECTED_HOST" | tr '[:upper:]' '[:lower:]')"
if [[ "$ACTUAL_HOST" != "$EXPECTED_HOST_NORMALIZED" ]]; then
  echo "refusing inventory outside ${EXPECTED_HOST}" >&2
  exit 1
fi
for command in ve vefaas; do
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

ve version | tee "$OUT_DIR/ve-version.txt"
ve sts GetCallerIdentity --output json > "$OUT_DIR/identity.json"
ve vpc DescribeVpcs --region "$REGION" --output json > "$OUT_DIR/vpcs.json"
ve vpc DescribeSubnets --region "$REGION" --output json > "$OUT_DIR/subnets.json"
ve vpc DescribeSecurityGroups --region "$REGION" --output json \
  > "$OUT_DIR/security-groups.json"
ve cr ListRegistries --region "$REGION" --output json > "$OUT_DIR/cr-registries.json"
ve rdspostgresql DescribeDBInstances --region "$REGION" --output json \
  > "$OUT_DIR/postgresql-instances.json"
vefaas fn list -o json > "$OUT_DIR/vefaas-functions.json"

APIG_LIST_ACTION="${CHANGFU_APIG_LIST_ACTION:-ListGateways}"
if [[ "$APIG_LIST_ACTION" =~ ^[A-Za-z0-9]+$ ]]; then
  ve apig "$APIG_LIST_ACTION" --region "$REGION" --output json \
    > "$OUT_DIR/apig-instances.json" 2>"$OUT_DIR/apig-instances.error" || true
fi

echo "read-only inventory written to $OUT_DIR"
