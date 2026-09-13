import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import type { TradingPromptBroker, TradingPromptReleaseStatus, TradingPromptRole } from '../../shared/tradingPromptTypes.js'
import { isPgEnabled, queryOne } from '../cloud/db/pgClient.js'

const roles: TradingPromptRole[] = ['single', 'portfolio', 'managed']
type RecordValue = {
  revision: number
  mode: 'legacy' | 'shadow' | 'live'
  updatedAt: string
  history: Array<{ revision: number; mode: string; at: string }>
}

export class PromptModeError extends Error {
  constructor(message: string, readonly status = 409) { super(message) }
}

function override(broker: TradingPromptBroker, role: TradingPromptRole) {
  const key = [`${broker.toUpperCase()}_${role.toUpperCase()}_PROMPT_MODE`, `${broker.toUpperCase()}_PROMPT_MODE`, 'TRADING_PROMPT_MODE']
    .find(key => process.env[key] !== undefined)
  return key ? { key, value: process.env[key] } : undefined
}

function storageKey(broker: TradingPromptBroker, scope: string) {
  return `trading_prompt.${broker}.${createHash('sha256').update(scope).digest('hex')}`
}

async function sqlite(key: string, value?: RecordValue, expectedRevision?: number): Promise<RecordValue | null> {
  const stdout = await new Promise<string>((resolveOutput, reject) => {
    const child = spawn(process.env.FUTU_PYTHON_BIN || 'python3', [resolve('api/futu_bridge/prompt_mode_db.py')], { stdio: ['pipe', 'pipe', 'ignore'], timeout: 15_000 })
    let output = ''
    const fail = () => reject(new PromptModeError('提示词配置存储不可用，已阻断。', 503))
    child.on('error', fail)
    child.stdin.on('error', fail)
    child.stdout.setEncoding('utf8').on('data', chunk => {
      output += chunk
      if (output.length > 1024 * 1024) { child.kill(); fail() }
    })
    child.on('close', code => { if (code !== 0) fail(); else resolveOutput(output) })
    child.stdin.end(JSON.stringify({ path: resolve(process.env.TRADING_PROMPT_MODE_DB_PATH || '.data/trading-prompt-modes.sqlite3'), key, action: value ? 'save' : 'load', value, expectedRevision }))
  })
  const response = JSON.parse(stdout)
  if (response.conflict) throw new PromptModeError('配置已更新，请刷新后重试。')
  return response.value
}

async function load(broker: TradingPromptBroker, scope: string): Promise<RecordValue | null> {
  const key = storageKey(broker, scope)
  const record = isPgEnabled()
    ? (await queryOne<{ value: RecordValue }>('SELECT value FROM app_config WHERE key = $1', [key]))?.value ?? null
    : await sqlite(key)
  if (record && (!['legacy', 'shadow', 'live'].includes(record.mode) || !Number.isSafeInteger(record.revision) || record.revision < 1)) {
    throw new PromptModeError('提示词配置无效，已阻断。', 503)
  }
  return record
}

export async function resolveTradingPromptMode(broker: TradingPromptBroker, role: TradingPromptRole, scope = 'default'): Promise<'legacy' | 'shadow' | 'live'> {
  const env = override(broker, role)
  if (env) {
    if (env.value !== 'legacy' && env.value !== 'shadow' && env.value !== 'live') throw new PromptModeError('提示词环境配置无效。')
    return env.value
  }
  return (await load(broker, scope))?.mode ?? 'legacy'
}

export async function tradingPromptReleaseStatus(broker: TradingPromptBroker, scope = 'default'): Promise<TradingPromptReleaseStatus> {
  const record = await load(broker, scope)
  const environmentOverrides: TradingPromptReleaseStatus['environmentOverrides'] = {}
  const effectiveModes = {} as TradingPromptReleaseStatus['effectiveModes']
  for (const role of roles) {
    const env = override(broker, role)
    if (env) environmentOverrides[role] = env.key
    const mode = env?.value ?? record?.mode ?? 'legacy'
    effectiveModes[role] = mode === 'legacy' || mode === 'shadow' || mode === 'live' ? mode : 'blocked'
    if (scope !== 'default' && role === 'managed' && mode === 'shadow') effectiveModes[role] = 'blocked'
  }
  // These are implementation gaps, not evidence that can be cleared by a client.
  return {
    revision: record?.revision ?? 0, selectedMode: record?.mode ?? 'legacy', effectiveModes, environmentOverrides,
    updatedAt: record?.updatedAt ?? null, liveAvailable: scope === 'default',
    blockers: scope === 'default' ? [] : ['租户挂单模型监管链路尚未接入新版'],
  }
}

export async function saveTradingPromptMode(broker: TradingPromptBroker, scope: string, body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PromptModeError('模式请求格式无效。', 400)
  const input = body as Record<string, unknown>
  if (Object.keys(input).some(key => !['mode', 'expectedRevision', 'confirmed'].includes(key))
    || input.confirmed !== true || !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0
    || !['legacy', 'shadow', 'live'].includes(String(input.mode))) throw new PromptModeError('模式、版本或确认字段无效。', 400)
  if (input.mode === 'live' && scope !== 'default') throw new PromptModeError('租户新版挂单监管尚未完成，禁止切换。')
  if (roles.some(role => override(broker, role))) throw new PromptModeError('环境变量正在覆盖提示词模式，请先由部署配置解除覆盖。')
  const current = await load(broker, scope)
  if ((current?.revision ?? 0) !== input.expectedRevision) throw new PromptModeError('配置已更新，请刷新后重试。')
  const mode = input.mode as 'legacy' | 'shadow' | 'live', updatedAt = new Date().toISOString()
  const revision = Number(input.expectedRevision) + 1
  const next: RecordValue = { mode, revision, updatedAt, history: [...(current?.history ?? []), { mode, revision, at: updatedAt }].slice(-50) }
  const key = storageKey(broker, scope)
  if (isPgEnabled()) {
    const row = await queryOne(
      `INSERT INTO app_config(key,value,updated_at)
       SELECT $1,$2::jsonb,now() WHERE $3 = 0 OR EXISTS (SELECT 1 FROM app_config WHERE key=$1)
       ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()
       WHERE (app_config.value->>'revision')::bigint=$3 RETURNING key`,
      [key, JSON.stringify(next), input.expectedRevision],
    )
    if (!row) throw new PromptModeError('配置已更新，请刷新后重试。')
  } else await sqlite(key, next, Number(input.expectedRevision))
  return tradingPromptReleaseStatus(broker, scope)
}
