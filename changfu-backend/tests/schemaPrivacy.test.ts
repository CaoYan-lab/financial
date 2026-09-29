import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('迁移只创建 changfu schema 且不含原始上下文字段', async () => {
  const sql = await readFile(resolve(root, 'migrations/001_changfu_schema.sql'), 'utf8')
  const requiredTables = [
    'devices',
    'device_sessions',
    'trading_leases',
    'broker_connections',
    'strategy_configs',
    'model_runs',
    'signals',
    'pending_orders',
    'order_executions',
    'order_events',
    'reports',
    'conversations',
    'messages',
    'ad_configs',
    'ad_deliveries',
    'security_audit',
    'idempotency_records',
  ]
  for (const table of requiredTables) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS changfu\\.${table} \\(`))
  }

  for (const forbidden of [
    'raw_context',
    'prompt_body',
    'account_snapshots',
    'position_snapshots',
    'minute_bars_json',
    'ticker_points_json',
    'order_books_json',
  ]) {
    assert.equal(sql.includes(forbidden), false, `迁移包含禁止字段 ${forbidden}`)
  }
  assert.equal(sql.includes('user_id uuid'), false, '用户 ID 必须兼容 cloud_users BIGSERIAL')
  assert.match(sql, /user_id bigint NOT NULL REFERENCES public\.cloud_users\(id\)/)
})

test('量化控制面迁移支持双券商且不持久化提示词或凭据', async () => {
  const sql = await readFile(
    resolve(root, 'migrations/002_quant_trading_control_plane.sql'),
    'utf8',
  )
  for (const table of [
    'trading_catalog_versions',
    'research_entitlements',
    'research_pools',
    'research_pool_items',
    'trading_configs',
    'trading_config_versions',
    'trading_sessions',
    'candidate_pool_items',
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS changfu\\.${table} \\(`))
  }
  assert.match(sql, /broker IN \('FUTU', 'LONGBRIDGE'\)/)
  for (const forbidden of ['prompt_body text', 'access_token', 'app_secret', 'raw_context']) {
    assert.equal(sql.toLowerCase().includes(forbidden), false)
  }
})

test('订阅迁移按 Provider 隔离标的池并只保存脱敏支付元数据', async () => {
  const sql = await readFile(
    resolve(root, 'migrations/003_subscriptions_provider_pools.sql'),
    'utf8',
  )
  for (const table of [
    'subscription_catalog_releases',
    'broker_provider_catalog',
    'subscription_plan_versions',
    'subscription_prices',
    'user_subscriptions',
    'subscription_pending_provider_selections',
    'subscription_orders',
    'subscription_order_provider_selections',
    'payment_attempts',
    'payment_webhook_events',
    'subscription_events',
    'subscription_broker_slots',
    'subscription_broker_binding_history',
    'provider_research_pools',
    'provider_research_pool_items',
    'research_pool_mutation_events',
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS changfu\\.${table} \\(`))
  }
  assert.match(sql, /pool_capacity_per_provider integer/)
  assert.match(sql, /instrument_type IN \('STOCK', 'ETF', 'OPTION'\)/)
  assert.match(sql, /market IN \('US', 'HK', 'CN', 'SG'\)/)
  assert.match(sql, /provider_symbol varchar\(128\) NOT NULL/)
  assert.match(sql, /raw_body_hash char\(64\) NOT NULL/)
  for (const forbidden of [
    'raw_body text',
    'private_key text',
    'api_v3_key text',
    'merchant_secret text',
    'payer_account text',
  ]) {
    assert.equal(sql.toLowerCase().includes(forbidden), false)
  }
})

test('第三方模型迁移只保存 AES-GCM 密文和脱敏尾号', async () => {
  const sql = await readFile(
    resolve(root, 'migrations/004_third_party_model_configs.sql'),
    'utf8',
  )
  assert.match(sql, /CREATE TABLE IF NOT EXISTS changfu\.third_party_model_configs \(/)
  assert.match(sql, /api_key_ciphertext bytea NOT NULL/)
  assert.match(sql, /api_key_nonce bytea NOT NULL/)
  assert.match(sql, /api_key_auth_tag bytea NOT NULL/)
  assert.match(sql, /api_key_last_four varchar\(4\) NOT NULL/)
  assert.match(sql, /UNIQUE \(user_id\)/)
  for (const forbidden of ['api_key text', 'api_key varchar', 'authorization text']) {
    assert.equal(sql.toLowerCase().includes(forbidden), false)
  }
})

test('管理端迁移隔离管理员身份、人工授权和官方模型密钥', async () => {
  const sql = await readFile(
    resolve(root, 'migrations/010_admin_console.sql'),
    'utf8',
  )
  for (const table of [
    'admin_users',
    'admin_sessions',
    'audit_events',
    'subscription_grants',
    'official_model_config_versions',
  ]) {
    assert.match(
      sql,
      new RegExp(`CREATE TABLE IF NOT EXISTS changfu_admin\\.${table} \\(`),
    )
  }
  assert.match(sql, /session_token_hash char\(64\) NOT NULL UNIQUE/)
  assert.match(sql, /csrf_token_hash char\(64\) NOT NULL/)
  assert.match(sql, /api_key_ciphertext bytea NOT NULL/)
  assert.match(sql, /api_key_nonce bytea NOT NULL/)
  assert.match(sql, /api_key_auth_tag bytea NOT NULL/)
  assert.match(sql, /source IN \('PAYMENT', 'ADMIN_GRANT'\)/)
  assert.match(sql, /WHERE status = 'ACTIVE'/)
  for (const forbidden of [
    'session_token text',
    'csrf_token text',
    'api_key text',
    'authorization text',
  ]) {
    assert.equal(sql.toLowerCase().includes(forbidden), false)
  }
})

test('管理端写操作幂等键使用独立增量迁移且不保存响应正文', async () => {
  const sql = await readFile(
    resolve(root, 'migrations/011_admin_mutation_idempotency.sql'),
    'utf8',
  )
  assert.match(
    sql,
    /CREATE TABLE IF NOT EXISTS changfu_admin\.mutation_idempotency_keys \(/,
  )
  assert.match(sql, /PRIMARY KEY \(admin_user_id, operation, idempotency_key\)/)
  assert.equal(sql.includes('response_body'), false)
})

test('模型运行审计只新增请求标的而不保存原始上下文', async () => {
  const sql = await readFile(
    resolve(root, 'migrations/005_model_run_requested_symbols.sql'),
    'utf8',
  )
  assert.match(sql, /ADD COLUMN IF NOT EXISTS requested_symbols varchar\(32\)\[\]/)
  for (const forbidden of ['raw_context', 'quotes', 'positions', 'prompt']) {
    assert.equal(sql.toLowerCase().includes(forbidden), false)
  }
})

test('未显式选择组合策略的旧版默认配置迁移为单标的模式', async () => {
  const sql = await readFile(
    resolve(root, 'migrations/006_direct_shadow_default.sql'),
    'utf8',
  )
  assert.match(sql, /execution_mode = 'DIRECT'/)
  assert.match(sql, /jsonb_set\(config, '\{executionMode\}', '"DIRECT"'::jsonb\)/)
  assert.match(sql, /WHERE version = 1/)
  assert.match(sql, /candidate\.status IN \('PENDING', 'WATCH'\)/)
})

test('市场时段门禁迁移默认关闭美股夜盘量化评估', async () => {
  const sql = await readFile(
    resolve(root, 'migrations/007_market_session_evaluation_gate.sql'),
    'utf8',
  )
  assert.match(sql, /\{disableUsOvernightEvaluation\}/)
  assert.match(sql, /'true'::jsonb/)
  assert.match(sql, /version = version \+ 1/)
  assert.match(sql, /INSERT INTO changfu\.trading_config_versions/)
})

test('SELL PUT 研究迁移使用独立标的池并持久化逐标的审计结果', async () => {
  const sql = await readFile(
    resolve(root, 'migrations/008_sell_put_research.sql'),
    'utf8',
  )
  for (const table of [
    'sell_put_research_pools',
    'sell_put_research_pool_items',
    'sell_put_report_runs',
    'sell_put_report_items',
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS changfu\\.${table} \\(`))
  }
  assert.match(sql, /report_window_days smallint NOT NULL DEFAULT 30/)
  assert.match(sql, /source_snapshot jsonb NOT NULL/)
  assert.match(sql, /PRIMARY KEY \(user_id, provider_id\)/)
  assert.equal(sql.includes('provider_research_pool_items'), false)
})

test('Worker 第三方模型请求禁止重定向并设置独立超时', async () => {
  const source = await readFile(
    resolve(root, 'apps/decision-worker/src/server.ts'),
    'utf8',
  )
  assert.match(source, /redirect: 'error'/)
  assert.match(source, /AbortSignal\.timeout\(modelRequestTimeoutMs\)/)
  assert.match(source, /configuredModelTimeoutMs >= 1_000/)
  assert.match(source, /configuredModelTimeoutMs <= 300_000/)
  assert.match(source, /CHANGFU_MODEL_REQUEST_TIMEOUT_MS \?\? 300_000/)
  assert.equal(source.includes('safeLogger.info(selectedApiKey'), false)
  assert.equal(source.includes('safeLogger.error(selectedApiKey'), false)
})
