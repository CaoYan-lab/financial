import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { LiveCandidatePoolSnapshot, LlmRuntimeConfig, LlmRuntimeConfigResponse, LlmModelOption, TradeStrategyConfigResponse, UpdateLlmRuntimeConfigRequest, UpdateTradeStrategyConfigRequest } from '../../shared/types.js'
import { LLM_MODEL_OPTIONS } from '../simulation/llmRuntimeConfigService.js'
import { getActiveLivePortfolioReviewPrompt, getTradeStrategyRuntimeConfig, updateTradeStrategyRuntimeConfig } from '../trade_strategy/tradeStrategyConfigService.js'
import { getAshareUniverse } from './aShareUniverseService.js'
import { aShareCandidatePoolService } from './aShareCandidatePoolService.js'

const CONFIG_PATH = resolve(process.cwd(), '.data', 'a-share-live-config.json')
const DEFAULT_MODEL = LLM_MODEL_OPTIONS[0]?.id ?? 'ep-20260616231829-mnq2t'
const DEFAULT_CONCURRENCY = 4
const TRADE_CONFIG_NAMESPACE = 'ashare'

type StoredConfig = {
  llm?: {
    model?: string
    concurrency?: number
    disableUsOvernightLlm?: boolean
    updatedAt?: string
  }
  tradingAgent?: {
    presetId?: string
    maxDebateRounds?: number
    maxRiskRounds?: number
    outputLanguage?: string
    updatedAt?: string
  }
}

export type AShareTradingAgentLlmPreset = {
  id: string
  label: string
  provider: string
  backendUrl?: string
  quickThinkLlm: string
  deepThinkLlm: string
  apiKeyEnv: string
  apiKeyConfigured: boolean
}

export type AShareTradingAgentLlmConfig = {
  presetId: string
  presetLabel: string
  provider: string
  backendUrl?: string
  quickThinkLlm: string
  deepThinkLlm: string
  apiKeyEnv: string
  apiKeyConfigured: boolean
  maxDebateRounds: number
  maxRiskRounds: number
  outputLanguage: string
  updatedAt: string
}

export type AShareTradingAgentLlmConfigResponse = {
  ok: true
  config: AShareTradingAgentLlmConfig
  presets: AShareTradingAgentLlmPreset[]
  warnings: string[]
}

export type UpdateAshareTradingAgentLlmConfigRequest = {
  presetId?: string
  maxDebateRounds?: number
  maxRiskRounds?: number
  outputLanguage?: string
}

let cached: StoredConfig | undefined

export function getAshareLiveTradingConfig(): {
  ok: true
  llmRuntimeConfig: LlmRuntimeConfig
  modelOptions: LlmModelOption[]
  tradingAgentLlmConfig: AShareTradingAgentLlmConfig
  tradingAgentLlmPresets: AShareTradingAgentLlmPreset[]
  tradeStrategyConfig: TradeStrategyConfigResponse
  candidatePoolConfig: LiveCandidatePoolSnapshot
  warnings: string[]
} {
  const llm = getAshareLlmRuntimeConfig().config
  const tradingAgentLlm = getAshareTradingAgentLlmConfig()
  const tradeStrategyConfig = getAshareTradeStrategyConfig()
  return {
    ok: true,
    llmRuntimeConfig: llm,
    modelOptions: modelOptions(),
    tradingAgentLlmConfig: tradingAgentLlm.config,
    tradingAgentLlmPresets: tradingAgentLlm.presets,
    tradeStrategyConfig,
    candidatePoolConfig: buildAshareCandidatePoolConfig(),
    warnings: [],
  }
}

export function getAshareLlmRuntimeConfig(): LlmRuntimeConfigResponse {
  const stored = loadConfig().llm ?? {}
  return {
    ok: true,
    config: normalizeLlmConfig(stored, stored.updatedAt ?? new Date().toISOString()),
    modelOptions: modelOptions(),
    warnings: [],
  }
}

export function updateAshareLlmRuntimeConfig(input: UpdateLlmRuntimeConfigRequest): LlmRuntimeConfigResponse {
  const previous = getAshareLlmRuntimeConfig().config
  const updatedAt = new Date().toISOString()
  const next = normalizeLlmConfig(
    {
      model: input.model && modelOption(input.model) ? input.model : previous.model,
      concurrency: input.concurrency ?? previous.concurrency,
      disableUsOvernightLlm: input.disableUsOvernightLlm ?? previous.disableUsOvernightLlm,
      updatedAt,
    },
    updatedAt,
  )
  const config = loadConfig()
  config.llm = next
  saveConfig(config)
  return getAshareLlmRuntimeConfig()
}

export function getAshareDecisionConcurrency(activeCount: number): number {
  const config = getAshareLlmRuntimeConfig().config
  return clampInteger(config.concurrency, 1, Math.max(1, activeCount), 1)
}

export function getAshareActiveArkModel(): string {
  return getAshareLlmRuntimeConfig().config.model
}

export function getAshareActiveLlmModelOption(): LlmModelOption {
  const config = getAshareLlmRuntimeConfig().config
  return modelOption(config.model) ?? modelOptions()[0]
}

export function getAshareTradingAgentLlmConfig(): AShareTradingAgentLlmConfigResponse {
  const stored = loadConfig().tradingAgent ?? {}
  const presets = tradingAgentLlmPresets()
  const fallbackPreset = presets[0] ?? fallbackTradingAgentPreset()
  const preset = presets.find((item) => item.id === stored.presetId) ?? fallbackPreset
  const updatedAt = stored.updatedAt ?? new Date().toISOString()
  return {
    ok: true,
    config: {
      presetId: preset.id,
      presetLabel: preset.label,
      provider: preset.provider,
      backendUrl: preset.backendUrl,
      quickThinkLlm: preset.quickThinkLlm,
      deepThinkLlm: preset.deepThinkLlm,
      apiKeyEnv: preset.apiKeyEnv,
      apiKeyConfigured: preset.apiKeyConfigured,
      maxDebateRounds: clampInteger(Number(stored.maxDebateRounds), 1, 5, 1),
      maxRiskRounds: clampInteger(Number(stored.maxRiskRounds), 1, 5, 1),
      outputLanguage: stored.outputLanguage || process.env.TRADINGAGENTS_OUTPUT_LANGUAGE || 'Chinese',
      updatedAt,
    },
    presets,
    warnings: presets.length === 0 ? ['未发现 Trading Agent LLM 预设，请检查 .env.local。'] : [],
  }
}

export function updateAshareTradingAgentLlmConfig(input: UpdateAshareTradingAgentLlmConfigRequest): AShareTradingAgentLlmConfigResponse {
  const previous = getAshareTradingAgentLlmConfig().config
  const presets = tradingAgentLlmPresets()
  const presetId = input.presetId && presets.some((item) => item.id === input.presetId) ? input.presetId : previous.presetId
  const updatedAt = new Date().toISOString()
  const config = loadConfig()
  config.tradingAgent = {
    presetId,
    maxDebateRounds: input.maxDebateRounds ?? previous.maxDebateRounds,
    maxRiskRounds: input.maxRiskRounds ?? previous.maxRiskRounds,
    outputLanguage: input.outputLanguage ?? previous.outputLanguage,
    updatedAt,
  }
  saveConfig(config)
  return getAshareTradingAgentLlmConfig()
}

export function getAshareTradeStrategyConfig(): TradeStrategyConfigResponse {
  return getTradeStrategyRuntimeConfig('live', TRADE_CONFIG_NAMESPACE)
}

export function updateAshareTradeStrategyConfig(input: UpdateTradeStrategyConfigRequest): TradeStrategyConfigResponse {
  const next = updateTradeStrategyRuntimeConfig('live', input, TRADE_CONFIG_NAMESPACE)
  if (next.selection.executionMode !== 'candidate_pool') aShareCandidatePoolService.disableForModeSwitch()
  return next
}

export function buildAshareCandidatePoolConfig(): LiveCandidatePoolSnapshot {
  const tradeStrategyConfig = getAshareTradeStrategyConfig()
  const prompt = getActiveLivePortfolioReviewPrompt(TRADE_CONFIG_NAMESPACE)
  const presetId = tradeStrategyConfig.selection.portfolioTimingPresetId ?? prompt.defaultPresetId
  const preset = prompt.timingPresets.find((item) => item.id === presetId) ?? prompt.timingPresets[0]
  return {
    executionMode: tradeStrategyConfig.selection.executionMode,
    enabled: tradeStrategyConfig.selection.executionMode === 'candidate_pool',
    promptVersion: prompt.id,
    promptLabel: prompt.label,
    promptSummary: prompt.summary,
    promptConfigVersion: prompt.version,
    promptRawYaml: prompt.rawYaml,
    presetId: preset?.id ?? prompt.defaultPresetId,
    presetLabel: preset?.label ?? 'DeepSeek 平衡版 v1',
    timingPresets: prompt.timingPresets,
    decisionRuleCount: prompt.decisionRules.length,
    requiredJsonKeys: Object.keys(prompt.requiredJson ?? {}),
    candidates: aShareCandidatePoolService.visibleCandidates(tradeStrategyConfig.selection.executionMode),
  }
}

function normalizeLlmConfig(input: NonNullable<StoredConfig['llm']>, fallbackUpdatedAt: string): LlmRuntimeConfig {
  const maxConcurrency = Math.max(1, getAshareUniverse().universe.length)
  const model = modelOption(input.model)?.id ?? DEFAULT_MODEL
  return {
    model,
    modelLabel: modelOption(model)?.label ?? model,
    concurrency: clampInteger(Number(input.concurrency), 1, maxConcurrency, DEFAULT_CONCURRENCY),
    maxConcurrency,
    disableUsOvernightLlm: input.disableUsOvernightLlm !== false,
    updatedAt: input.updatedAt ?? fallbackUpdatedAt,
  }
}

function loadConfig(): StoredConfig {
  if (cached) return cached
  if (!existsSync(CONFIG_PATH)) {
    cached = {}
    return cached
  }
  try {
    cached = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as StoredConfig
  } catch {
    cached = {}
  }
  return cached
}

function saveConfig(config: StoredConfig) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8')
  cached = config
}

function modelOptions(): LlmModelOption[] {
  return LLM_MODEL_OPTIONS.map(({ id, label, provider }) => ({ id, label, provider }))
}

function modelOption(model?: string): LlmModelOption | undefined {
  return LLM_MODEL_OPTIONS.find((option) => option.id === model)
}

function tradingAgentLlmPresets(): AShareTradingAgentLlmPreset[] {
  const presets = [
    envTradingAgentPreset('deepseek_v4', 'DeepSeek v4', {
      provider: 'openai_compatible',
      backendUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      quickThinkLlm: process.env.ARK_MODEL || 'deepseek-v4',
      deepThinkLlm: process.env.ARK_MODEL || 'deepseek-v4',
      apiKeyEnv: 'ARK_API_KEY',
    }),
    envTradingAgentPreset('glm', 'GLM', {
      provider: 'openai_compatible',
      backendUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
      quickThinkLlm: process.env.TRADINGAGENTS_LLM_PRESET_GLM_QUICK_THINK_LLM || process.env.GLM_MODEL || 'glm-5.2',
      deepThinkLlm: process.env.TRADINGAGENTS_LLM_PRESET_GLM_DEEP_THINK_LLM || process.env.GLM_MODEL || 'glm-5.2',
      apiKeyEnv: 'GLM_API_KEY',
    }),
  ]
  return presets
}

function envTradingAgentPreset(id: string, label: string, fallback: {
  provider: string
  backendUrl: string
  quickThinkLlm: string
  deepThinkLlm: string
  apiKeyEnv: string
}): AShareTradingAgentLlmPreset {
  const prefix = `TRADINGAGENTS_LLM_PRESET_${id.toUpperCase()}`
  const provider = process.env[`${prefix}_PROVIDER`] || fallback.provider
  const backendUrl = process.env[`${prefix}_BACKEND_URL`] || fallback.backendUrl
  const quickThinkLlm = process.env[`${prefix}_QUICK_THINK_LLM`] || fallback.quickThinkLlm
  const deepThinkLlm = process.env[`${prefix}_DEEP_THINK_LLM`] || fallback.deepThinkLlm
  const apiKeyEnv = process.env[`${prefix}_API_KEY_ENV`] || fallback.apiKeyEnv
  return {
    id,
    label: process.env[`${prefix}_LABEL`] || label,
    provider,
    backendUrl,
    quickThinkLlm,
    deepThinkLlm,
    apiKeyEnv,
    apiKeyConfigured: Boolean(process.env[apiKeyEnv]),
  }
}

function fallbackTradingAgentPreset(): AShareTradingAgentLlmPreset {
  return {
    id: 'deepseek_v4',
    label: 'DeepSeek v4',
    provider: 'openai_compatible',
    backendUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    quickThinkLlm: process.env.ARK_MODEL || 'deepseek-v4',
    deepThinkLlm: process.env.ARK_MODEL || 'deepseek-v4',
    apiKeyEnv: 'ARK_API_KEY',
    apiKeyConfigured: Boolean(process.env.ARK_API_KEY),
  }
}

function clampInteger(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return Math.max(min, Math.min(max, fallback))
  return Math.max(min, Math.min(max, Math.floor(value)))
}
