import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { LlmModelOption, LlmRuntimeConfig, LlmRuntimeConfigResponse, UpdateLlmRuntimeConfigRequest } from '../../shared/types.js'
import { logger } from '../utils/logger.js'
import { llmSimulationTickers } from './simulationUniverse.js'

const CONFIG_KEY = 'llm_runtime_config'
const DEFAULT_MODEL = 'ep-20260616231829-mnq2t'
const DEFAULT_CONCURRENCY = 12
const DEFAULT_ARK_RESPONSES_URL = 'https://ark.cn-beijing.volces.com/api/v3/responses'
const DEFAULT_GLM_RESPONSES_URL = 'https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions'
const DEFAULT_DB_PATH = resolve(process.cwd(), '.data', 'simulation-history.sqlite3')
const PYTHON_SCRIPT_PATH = resolve(process.cwd(), 'api', 'futu_bridge', 'simulation_history_db.py')

export const LLM_MODEL_OPTIONS: LlmModelOption[] = [
  { id: 'ep-20260616231829-mnq2t', label: 'DeepSeek-v4-Pro', provider: 'ark', apiKeyEnv: 'ARK_API_KEY', urlEnv: 'ARK_RESPONSES_URL', defaultUrl: DEFAULT_ARK_RESPONSES_URL, requestProtocol: 'responses' },
  { id: 'ep-20260410101451-dq9sg', label: 'Doubao-2.0-pro', provider: 'ark', apiKeyEnv: 'ARK_API_KEY', urlEnv: 'ARK_RESPONSES_URL', defaultUrl: DEFAULT_ARK_RESPONSES_URL, requestProtocol: 'responses' },
  { id: 'glm-5.2', label: 'GLM5.2', provider: 'ark', apiKeyEnv: 'GLM_API_KEY', urlEnv: 'GLM_RESPONSES_URL', defaultUrl: DEFAULT_GLM_RESPONSES_URL, requestProtocol: 'chat_completions' },
]

type StoredLlmRuntimeConfig = {
  model?: string
  concurrency?: number
  disableUsOvernightLlm?: boolean
  updatedAt?: string
}

let cachedConfig: LlmRuntimeConfig | undefined
let cacheLoaded = false
let lastWarning: string | undefined

export function getLlmRuntimeConfig(): LlmRuntimeConfigResponse {
  const config = getCachedConfig()
  return {
    ok: true,
    config,
    modelOptions: publicModelOptions(),
    warnings: lastWarning ? [lastWarning] : [],
  }
}

export function updateLlmRuntimeConfig(input: UpdateLlmRuntimeConfigRequest): LlmRuntimeConfigResponse {
  const previous = getCachedConfig()
  const updatedAt = new Date().toISOString()
  const nextModel = input.model && modelOption(input.model) ? input.model : previous.model
  const next = normalizeConfig(
    {
      model: nextModel,
      concurrency: input.concurrency ?? previous.concurrency,
      disableUsOvernightLlm: input.disableUsOvernightLlm ?? previous.disableUsOvernightLlm,
      updatedAt,
    },
    updatedAt,
  )
  const stored = runConfigBridge<{ ok: true }>({ action: 'set_config', key: CONFIG_KEY, value: next, updatedAt })
  if (stored?.ok !== true) {
    lastWarning = '大模型运行配置保存到 SQLite 失败，本次仅在当前后端进程内生效。'
    logger.warn(
      {
        event: 'llm.config.persist_failed',
        previousModel: previous.model,
        nextModel: next.model,
        previousConcurrency: previous.concurrency,
        nextConcurrency: next.concurrency,
        maxConcurrency: next.maxConcurrency,
        disableUsOvernightLlm: next.disableUsOvernightLlm,
        error: stored?.ok === false ? stored.error : 'unknown persistence error',
      },
      'LLM runtime config persistence failed; in-memory config is active',
    )
  } else {
    lastWarning = undefined
  }
  cachedConfig = next
  cacheLoaded = true
  logger.info(
    {
      event: 'llm.config.updated',
      previousModel: previous.model,
      nextModel: next.model,
      previousConcurrency: previous.concurrency,
      nextConcurrency: next.concurrency,
      maxConcurrency: next.maxConcurrency,
      disableUsOvernightLlm: next.disableUsOvernightLlm,
    },
    'LLM runtime config updated',
  )
  return getLlmRuntimeConfig()
}

export function getActiveArkModel(): string {
  return getCachedConfig().model
}

export function getActiveLlmModelOption(): LlmModelOption {
  return modelOption(getCachedConfig().model) ?? modelOption(DEFAULT_MODEL)!
}

export function getActiveDecisionConcurrency(maxConcurrency = llmSimulationTickers().length): number {
  const config = getCachedConfig()
  return clampInteger(config.concurrency, 1, Math.max(1, maxConcurrency), DEFAULT_CONCURRENCY)
}

export function resetLlmRuntimeConfigCacheForTests() {
  cachedConfig = undefined
  cacheLoaded = false
  lastWarning = undefined
}

function getCachedConfig(): LlmRuntimeConfig {
  if (cacheLoaded && cachedConfig) return normalizeConfig(cachedConfig, cachedConfig.updatedAt)
  const fallback = defaultConfig()
  const stored = runConfigBridge<{ ok: true; found?: boolean; value?: StoredLlmRuntimeConfig }>({ action: 'get_config', key: CONFIG_KEY })
  if (stored?.ok && stored.found && stored.value) {
    cachedConfig = normalizeConfig(stored.value, stored.value.updatedAt ?? fallback.updatedAt)
    lastWarning = undefined
  } else {
    cachedConfig = fallback
    lastWarning = stored?.ok === false ? '大模型运行配置读取失败，使用默认配置。' : undefined
    if (stored?.ok === false) {
      logger.warn({ event: 'llm.config.load_failed', error: stored.error }, 'LLM runtime config load failed; default config is active')
    }
  }
  cacheLoaded = true
  return cachedConfig
}

function defaultConfig(): LlmRuntimeConfig {
  return normalizeConfig(
    {
      model: process.env.ARK_MODEL || DEFAULT_MODEL,
      concurrency: Number(process.env.LLM_DECISION_CONCURRENCY || DEFAULT_CONCURRENCY),
      disableUsOvernightLlm: process.env.DISABLE_US_OVERNIGHT_LLM !== 'false',
      updatedAt: new Date().toISOString(),
    },
    new Date().toISOString(),
  )
}

function normalizeConfig(input: StoredLlmRuntimeConfig, fallbackUpdatedAt: string): LlmRuntimeConfig {
  const maxConcurrency = llmSimulationTickers().length
  const model = modelOption(input.model)?.id ?? DEFAULT_MODEL
  return {
    model,
    modelLabel: modelOption(model)?.label ?? model,
    concurrency: clampInteger(Number(input.concurrency), 1, Math.max(1, maxConcurrency), DEFAULT_CONCURRENCY),
    maxConcurrency,
    disableUsOvernightLlm: input.disableUsOvernightLlm !== false,
    updatedAt: input.updatedAt || fallbackUpdatedAt,
  }
}

function modelOption(model?: string): LlmModelOption | undefined {
  return LLM_MODEL_OPTIONS.find((option) => option.id === model)
}

function publicModelOptions(): LlmModelOption[] {
  return LLM_MODEL_OPTIONS.map(({ id, label, provider }) => ({ id, label, provider }))
}

function clampInteger(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return Math.max(min, Math.min(max, fallback))
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function runConfigBridge<T>(payload: Record<string, unknown>): ({ ok: true } & T) | { ok: false; error?: string } | undefined {
  const pythonBin = process.env.FUTU_PYTHON_BIN || 'python3'
  const dbPath = process.env.SIMULATION_HISTORY_DB_PATH || DEFAULT_DB_PATH
  const result = spawnSync(pythonBin, [PYTHON_SCRIPT_PATH], {
    input: JSON.stringify({ dbPath, ...payload }),
    encoding: 'utf8',
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    maxBuffer: 20 * 1024 * 1024,
  })
  if (result.status !== 0) {
    return { ok: false, error: result.stderr || result.stdout || 'SQLite config bridge failed.' }
  }
  const jsonLine = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{') && line.endsWith('}'))
    .at(-1)
  if (!jsonLine) return { ok: false, error: 'SQLite config bridge returned empty output.' }
  return JSON.parse(jsonLine) as ({ ok: true } & T) | { ok: false; error?: string }
}
