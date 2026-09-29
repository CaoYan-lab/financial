import { readFile, readdir } from 'node:fs/promises'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const schemasDir = join(root, 'schemas')
const fixturesDir = join(root, 'fixtures')
const expectedSchemas = [
  'admin-plan.schema.json',
  'admin-subscription.schema.json',
  'admin-user.schema.json',
  'broker-event.schema.json',
  'candidate-pool.schema.json',
  'context-envelope.schema.json',
  'instrument-search.schema.json',
  'model-provider-config.schema.json',
  'model-result.schema.json',
  'model-run-event.schema.json',
  'official-model-config.schema.json',
  'provider-research-pool.schema.json',
  'research-pool.schema.json',
  'signed-order-intent.schema.json',
  'subscription-catalog.schema.json',
  'subscription-order.schema.json',
  'trading-catalog.schema.json',
  'trading-config.schema.json',
  'trading-session.schema.json',
  'user-subscription.schema.json',
]
const forbiddenPersistentFields = [
  'account_snapshots',
  'minute_bars_json',
  'order_books_json',
  'prompt_body',
  'raw_context',
  'ticker_points_json',
]

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

const schemaFiles = (await readdir(schemasDir)).filter(name => name.endsWith('.json')).sort()
assert(JSON.stringify(schemaFiles) === JSON.stringify(expectedSchemas), 'Schema 文件集合与预期不一致')

for (const name of schemaFiles) {
  const schema = JSON.parse(await readFile(join(schemasDir, name), 'utf8'))
  assert(schema.$schema === 'https://json-schema.org/draft/2020-12/schema', `${name} 未使用 JSON Schema 2020-12`)
  assert(schema.additionalProperties === false, `${name} 顶层必须禁止额外字段`)
}

const context = JSON.parse(await readFile(join(fixturesDir, 'context-envelope.valid.json'), 'utf8'))
assert(context.schemaVersion === '2.0', '交易上下文必须使用 2.0')
assert(['FUTU', 'LONGBRIDGE'].includes(context.provider), '上下文 provider 错误')
assert(Number.isInteger(context.researchPoolVersion), '上下文缺少研究池版本')
assert(Number.isInteger(context.tradingConfigVersion), '上下文缺少交易配置版本')
assert(context.purpose === 'SINGLE_DECISION', '黄金样例用途错误')
assert(Array.isArray(context.dataGaps), 'dataGaps 必须是数组')
assert(/^[a-f0-9]{64}$/.test(context.contentHash), 'contentHash 必须是 SHA-256 十六进制')
const unsignedContext = { ...context }
delete unsignedContext.contentHash
delete unsignedContext.deviceSignature
const expectedHash = createHash('sha256').update(canonicalize(unsignedContext)).digest('hex')
assert(context.contentHash === expectedHash, '黄金样例 contentHash 与规范化内容不匹配')
const fixturePublicKey = createPublicKey(await readFile(join(fixturesDir, 'device-public-key.pem'), 'utf8'))
assert(
  verify(
    null,
    Buffer.from(context.contentHash, 'hex'),
    fixturePublicKey,
    Buffer.from(context.deviceSignature, 'base64url'),
  ),
  '黄金样例设备签名无效',
)
assert(Date.parse(context.expiresAt) > Date.parse(context.capturedAt), '上下文失效时间必须晚于采集时间')
assert(Date.parse(context.expiresAt) - Date.parse(context.capturedAt) <= 60_000, '可执行上下文有效期不得超过 60 秒')

const result = JSON.parse(await readFile(join(fixturesDir, 'model-result.hold.json'), 'utf8'))
assert(result.requestId === context.requestId, '模型结果 requestId 必须匹配上下文')
assert(result.responseType === 'HOLD' && result.orderIntent === null, '数据缺口样例必须 fail closed')
assert(result.evidence.length > 0, '模型结果必须提供证据')
assert(result.risks.length > 0, '模型结果必须提供风险')

const openapi = await readFile(join(root, 'openapi', 'changfu-v1.yaml'), 'utf8')
assert(openapi.includes('/v1/model/runs:'), 'OpenAPI 缺少模型请求接口')
assert(openapi.includes('/v1/model-provider/config:'), 'OpenAPI 缺少第三方模型配置接口')
assert(openapi.includes('/v1/subscription/catalog:'), 'OpenAPI 缺少订阅目录接口')
assert(openapi.includes('/v1/subscription/orders:'), 'OpenAPI 缺少订阅订单接口')
assert(openapi.includes('/v1/research/pools/{providerId}:'), 'OpenAPI 缺少 Provider 标的池接口')
assert(openapi.includes('/internal/v1/payments/{channel}/webhook:'), 'OpenAPI 缺少支付回调接口')
assert(openapi.includes('Idempotency-Key'), 'OpenAPI 缺少幂等键')
assert(!forbiddenPersistentFields.some(field => openapi.includes(field)), 'OpenAPI 暴露了禁止持久化字段')
assert(!openapi.includes('apiKeyLastFour'), 'OpenAPI 不得使用可误解为密钥值的字段名')

const adminOpenapi = await readFile(join(root, 'openapi', 'changfu-admin-v1.yaml'), 'utf8')
for (const path of [
  '/api/v1/admin/auth/login:',
  '/api/v1/admin/users:',
  '/api/v1/admin/users/{userId}/subscription:',
  '/api/v1/admin/plans:',
  '/api/v1/admin/official-model:',
]) {
  assert(adminOpenapi.includes(path), `Admin OpenAPI 缺少接口 ${path}`)
}
assert(adminOpenapi.includes('X-CSRF-Token'), 'Admin OpenAPI 缺少 CSRF 门禁')
assert(adminOpenapi.includes('Idempotency-Key'), 'Admin OpenAPI 缺少幂等键')
assert(adminOpenapi.includes('changfu_admin_session'), 'Admin OpenAPI 缺少会话 Cookie')
for (const forbidden of [
  'api_key_ciphertext',
  'api_key_nonce',
  'api_key_auth_tag',
  'password_hash',
  'session_token_hash',
]) {
  assert(!adminOpenapi.includes(forbidden), `Admin OpenAPI 暴露敏感字段 ${forbidden}`)
}

process.stdout.write(`长富协议检查通过：${schemaFiles.length} 个 Schema，2 个 OpenAPI 契约，2 个黄金样例。\n`)
