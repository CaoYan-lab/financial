#!/usr/bin/env bash
set -euo pipefail

: "${CHANGFU_MIGRATION_DATABASE_URL:?required}"
: "${CHANGFU_RUNTIME_DATABASE_URL:?required}"
: "${CHANGFU_RUNTIME_DB_ROLE:?required}"
: "${CHANGFU_RUNTIME_DB_PASSWORD:?required}"
: "${CHANGFU_ADMIN_RUNTIME_DATABASE_URL:?required}"
: "${CHANGFU_ADMIN_RUNTIME_DB_ROLE:?required}"
: "${CHANGFU_ADMIN_RUNTIME_DB_PASSWORD:?required}"

export CHANGFU_DATABASE_URL="$CHANGFU_MIGRATION_DATABASE_URL"
node /app/dist/scripts/migrate.js
node /app/dist/scripts/ensure-runtime-role.js
node /app/dist/scripts/apply-runtime-grants.js

export CHANGFU_DATABASE_URL="$CHANGFU_RUNTIME_DATABASE_URL"
export CHANGFU_VERIFY_ROLE_KIND=runtime
node /app/dist/scripts/verify-database.js

export CHANGFU_DATABASE_URL="$CHANGFU_ADMIN_RUNTIME_DATABASE_URL"
export CHANGFU_VERIFY_ROLE_KIND=admin
node /app/dist/scripts/verify-database.js

exec node -e '
  const { createServer } = require("node:http")
  const port = Number(process.env.PORT || 8000)
  createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ ok: true, migration: "verified" }))
  }).listen(port, "0.0.0.0")
'
