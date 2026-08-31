import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { parse } from 'yaml'
import type {
  LivePortfolioReviewPromptConfig,
  TradePromptPackConfig,
  TradeRuntimeMode,
  TradeStrategyConfig,
  TradeStrategyConfigResponse,
  TradeStrategyOption,
  TradeStrategyRuntimeSelection,
  UpdateTradeStrategyConfigRequest,
} from '../../shared/types.js'
import { logger } from '../utils/logger.js'

const ROOT = resolve(process.cwd(), 'trade_strategy')
const STRATEGY_DIR = resolve(ROOT, 'strategies')
const PROMPT_PACK_DIR = resolve(ROOT, 'prompt_packs')
const PORTFOLIO_REVIEW_PACK_DIR = resolve(ROOT, 'portfolio_review_packs')
const DEFAULT_DB_PATH = resolve(process.cwd(), '.data', 'simulation-history.sqlite3')
const PYTHON_SCRIPT_PATH = resolve(process.cwd(), 'api', 'futu_bridge', 'simulation_history_db.py')
const DEFAULT_STRATEGY_ID = 'institutional_risk_guard_v1'
const DEFAULT_PROMPT_PACK_ID = 'llm_autonomous_stock_trader_v1'
const DEFAULT_PORTFOLIO_REVIEW_PROMPT_ID = 'live_portfolio_candidate_review_v1'

type StoredSelection = {
  strategyId?: string
  promptPackId?: string
  executionMode?: string
  portfolioTimingPresetId?: string
  updatedAt?: string
}

let catalogCache: { strategies: TradeStrategyConfig[]; promptPacks: TradePromptPackConfig[]; portfolioReviewPacks: LivePortfolioReviewPromptConfig[]; warnings: string[] } | undefined
let selectionCache = new Map<string, TradeStrategyRuntimeSelection>()
let activePortfolioReviewPromptLogKey = ''

export function getTradeStrategyRuntimeConfig(mode: TradeRuntimeMode, namespace = ''): TradeStrategyConfigResponse {
  const catalog = loadCatalog()
  const selection = getSelection(mode, catalog, namespace)
  const activeStrategy = findEnabled(catalog.strategies, selection.strategyId, mode) ?? failClosedStrategy(mode)
  const activePromptPack = findEnabled(catalog.promptPacks, selection.promptPackId, mode) ?? failClosedPromptPack(mode)
  return {
    ok: true,
    mode,
    selection,
    strategyOptions: catalog.strategies.filter((item) => item.enabledFor.includes(mode)).map(toOption),
    promptPackOptions: catalog.promptPacks.filter((item) => item.enabledFor.includes(mode)).map(toOption),
    activeStrategy,
    activePromptPack,
    warnings: catalog.warnings,
  }
}

export function updateTradeStrategyRuntimeConfig(mode: TradeRuntimeMode, input: UpdateTradeStrategyConfigRequest, namespace = ''): TradeStrategyConfigResponse {
  const catalog = loadCatalog()
  const previous = getSelection(mode, catalog, namespace)
  const strategyId = input.strategyId ?? previous.strategyId
  const promptPackId = input.promptPackId ?? previous.promptPackId
  const executionMode = normalizeExecutionMode(mode, input.executionMode ?? previous.executionMode, namespace)
  const portfolioTimingPresetId = normalizePortfolioTimingPresetId(input.portfolioTimingPresetId ?? previous.portfolioTimingPresetId, catalog)
  if (!findEnabled(catalog.strategies, strategyId, mode)) throw new Error(`策略 ${strategyId} 不支持 ${mode}。`)
  if (!findEnabled(catalog.promptPacks, promptPackId, mode)) throw new Error(`Prompt Pack ${promptPackId} 不支持 ${mode}。`)
  const updatedAt = new Date().toISOString()
  const next = { strategyId, promptPackId, executionMode, portfolioTimingPresetId, updatedAt }
  selectionCache.set(selectionCacheKey(mode, namespace), next)
  persistSelection(mode, next, updatedAt, namespace)
  logger.info({ event: 'trade_strategy.updated', mode, namespace, strategyId, promptPackId, executionMode, portfolioTimingPresetId }, 'Trade strategy selection updated')
  return getTradeStrategyRuntimeConfig(mode, namespace)
}

export function getActiveTradeStrategy(mode: TradeRuntimeMode): TradeStrategyConfig {
  return getTradeStrategyRuntimeConfig(mode).activeStrategy
}

export function getActivePromptPack(mode: TradeRuntimeMode): TradePromptPackConfig {
  return getTradeStrategyRuntimeConfig(mode).activePromptPack
}

export function getActiveLivePortfolioReviewPrompt(namespace = ''): LivePortfolioReviewPromptConfig {
  const catalog = loadCatalog()
  const prompt = catalog.portfolioReviewPacks.find((item) => item.id === DEFAULT_PORTFOLIO_REVIEW_PROMPT_ID && item.enabledFor.includes('live'))
  if (!prompt) {
    logger.error(
      {
        event: 'trade_strategy.portfolio_review_prompt.missing',
        requestedId: DEFAULT_PORTFOLIO_REVIEW_PROMPT_ID,
        configuredIds: catalog.portfolioReviewPacks.map((item) => item.id),
        configDir: PORTFOLIO_REVIEW_PACK_DIR,
      },
      'Live portfolio review prompt config missing; using fail-closed fallback',
    )
    return failClosedPortfolioReviewPrompt()
  }
  const selection = getSelection('live', catalog, namespace)
  const selectedPresetId = selection.portfolioTimingPresetId ?? prompt.defaultPresetId
  const preset = prompt.timingPresets.find((item) => item.id === selectedPresetId)
  if (!preset) {
    logger.error(
      {
        event: 'trade_strategy.portfolio_review_preset.missing',
        promptId: prompt.id,
        promptVersion: prompt.version,
        selectedPresetId,
        yamlDefaultPresetId: prompt.defaultPresetId,
        availablePresetIds: prompt.timingPresets.map((item) => item.id),
      },
      'Live portfolio review selected preset missing; YAML default or first preset will be used',
    )
  }
  const yamlDefaultPreset = prompt.timingPresets.find((item) => item.id === prompt.defaultPresetId)
  const selectedPreset = preset ?? yamlDefaultPreset ?? prompt.timingPresets[0]
  const activePrompt = { ...prompt, defaultPresetId: selectedPreset?.id ?? prompt.defaultPresetId }
  const logKey = `${namespace || 'default'}:${prompt.id}:${prompt.version}:${selection.portfolioTimingPresetId ?? 'unset'}:${activePrompt.defaultPresetId}`
  if (activePortfolioReviewPromptLogKey !== logKey) {
    activePortfolioReviewPromptLogKey = logKey
    logger.info(
      {
        event: 'trade_strategy.portfolio_review_prompt.active',
        namespace,
        promptId: prompt.id,
        promptVersion: prompt.version,
        label: prompt.label,
        yamlDefaultPresetId: prompt.defaultPresetId,
        configuredPresetId: selection.portfolioTimingPresetId,
        selectedPresetId: selectedPreset?.id,
        timingPresets: prompt.timingPresets.map((item) => ({
          id: item.id,
          version: item.version,
          scanMinutes: item.singleSignalScanIntervalMinutes,
          reviewMinutes: item.portfolioReviewIntervalMinutes,
          ttlMinutes: item.candidateTtlMinutes,
          leveragedEtfCooldownMinutes: item.leveragedEtfCooldownMinutes,
          minSignalConfirmations: item.minSignalConfirmations,
          maxPromotedOrdersPerReview: item.maxPromotedOrdersPerReview,
          maxActiveCandidates: item.maxActiveCandidates,
        })),
        decisionRuleCount: prompt.decisionRules.length,
        requiredJsonKeys: Object.keys(prompt.requiredJson ?? {}),
      },
      'Live portfolio review prompt config activated',
    )
  }
  return activePrompt
}

export function buildRiskModelDescription(mode: TradeRuntimeMode): string {
  const strategy = getActiveTradeStrategy(mode)
  const controls = strategy.riskControls
  const parts = [strategy.copy?.riskModelDescription ?? strategy.summary]
  if (controls.singleNameExposure) {
    const pct = (controls.singleNameExposure.maxPctEquity * 100).toFixed(2)
    parts.push(
      controls.singleNameExposure.mode === 'hard_block'
        ? `单票集中度硬上限 ${pct}% 权益。`
        : `单票集中度观察阈值 ${pct}% 权益，不是硬上限；不得因为超过固定百分比就自动禁止加仓或强制平仓，需按趋势、波动、流动性、可用资金和增量风险回报动态判断。`,
    )
  }
  if (controls.shortExposure) parts.push(`卖空单票上限 ${(controls.shortExposure.maxSingleNamePctEquity * 100).toFixed(2)}% 权益。`)
  if (mode === 'live') parts.push('Futu REAL 美股实盘账户不支持卖空美股杠杆做多 ETF（例如 2x/3x long daily ETF）；该限制不适用于允许卖空的港股杠杆产品（如 07709、07747）。')
  if (controls.buyingPowerProtection) parts.push(`购买力保护线 ${(controls.buyingPowerProtection.maxPctBuyingPower * 100).toFixed(2)}%。`)
  if (controls.feeDrag) parts.push(`费用拖累上限 ${(controls.feeDrag.maxRoundTripFeePctNotional * 100).toFixed(2)}% 名义金额。`)
  return parts.join(' ')
}

export function resetTradeStrategyConfigCacheForTests() {
  catalogCache = undefined
  selectionCache = new Map()
  activePortfolioReviewPromptLogKey = ''
}

export function warmTradeStrategyConfigCatalog() {
  loadCatalog()
}

function loadCatalog() {
  if (catalogCache) return catalogCache
  const warnings: string[] = []
  const strategies = loadYamlFiles<TradeStrategyConfig>(STRATEGY_DIR, validateStrategy, warnings)
  const promptPacks = loadYamlFiles<TradePromptPackConfig>(PROMPT_PACK_DIR, validatePromptPack, warnings)
  const portfolioReviewPacks = loadYamlFiles<LivePortfolioReviewPromptConfig>(PORTFOLIO_REVIEW_PACK_DIR, validatePortfolioReviewPrompt, warnings)
  catalogCache = { strategies, promptPacks, portfolioReviewPacks, warnings }
  logger.info(
    {
      event: 'trade_strategy.catalog.loaded',
      strategyDir: STRATEGY_DIR,
      promptPackDir: PROMPT_PACK_DIR,
      portfolioReviewPackDir: PORTFOLIO_REVIEW_PACK_DIR,
      strategyCount: strategies.length,
      promptPackCount: promptPacks.length,
      portfolioReviewPackCount: portfolioReviewPacks.length,
      portfolioReviewPackIds: portfolioReviewPacks.map((item) => item.id),
      warningCount: warnings.length,
    },
    'Trade strategy catalog loaded',
  )
  return catalogCache
}

function loadYamlFiles<T extends { id: string; rawYaml?: string }>(dir: string, validate: (value: unknown) => T, warnings: string[]): T[] {
  try {
    return readdirSync(dir)
      .filter((file) => file.endsWith('.yaml') || file.endsWith('.yml'))
      .map((file) => {
        const rawYaml = readFileSync(resolve(dir, file), 'utf8')
        return { ...validate(parse(rawYaml)), rawYaml }
      })
  } catch (error) {
    warnings.push(`读取 YAML 配置失败：${error instanceof Error ? error.message : String(error)}`)
    return []
  }
}

function validateStrategy(value: unknown): TradeStrategyConfig {
  const record = asRecord(value)
  if (!record.id || !record.label || !record.summary || !Array.isArray(record.enabledFor)) throw new Error('Invalid strategy YAML.')
  return record as TradeStrategyConfig
}

function validatePromptPack(value: unknown): TradePromptPackConfig {
  const record = asRecord(value)
  if (!record.id || !record.label || !record.summary || !Array.isArray(record.enabledFor) || !record.systemPrompts) throw new Error('Invalid prompt pack YAML.')
  return record as TradePromptPackConfig
}

function validatePortfolioReviewPrompt(value: unknown): LivePortfolioReviewPromptConfig {
  const record = asRecord(value)
  if (!record.id || !record.label || !record.summary || !Array.isArray(record.enabledFor) || !record.systemPrompt || !record.task || !Array.isArray(record.timingPresets)) {
    throw new Error('Invalid portfolio review prompt YAML.')
  }
  return record as LivePortfolioReviewPromptConfig
}

function getSelection(mode: TradeRuntimeMode, catalog: ReturnType<typeof loadCatalog>, namespace = ''): TradeStrategyRuntimeSelection {
  const cacheKey = selectionCacheKey(mode, namespace)
  const cached = selectionCache.get(cacheKey)
  if (cached) return normalizeSelection(mode, cached, catalog, namespace)
  const stored = runConfigBridge<{ ok: true; found?: boolean; value?: StoredSelection }>({ action: 'get_config', key: selectionKey(mode, namespace) })
  const fallback = {
    strategyId: DEFAULT_STRATEGY_ID,
    promptPackId: DEFAULT_PROMPT_PACK_ID,
    executionMode: 'legacy_direct',
    portfolioTimingPresetId: defaultPortfolioTimingPresetId(catalog),
    updatedAt: new Date().toISOString(),
  }
  const selection = stored?.ok && stored.found && stored.value ? normalizeSelection(mode, stored.value, catalog, namespace) : normalizeSelection(mode, fallback, catalog, namespace)
  selectionCache.set(cacheKey, selection)
  return selection
}

function normalizeSelection(mode: TradeRuntimeMode, input: StoredSelection, catalog: ReturnType<typeof loadCatalog>, namespace = ''): TradeStrategyRuntimeSelection {
  const strategyId = findEnabled(catalog.strategies, input.strategyId, mode)?.id ?? DEFAULT_STRATEGY_ID
  const promptPackId = findEnabled(catalog.promptPacks, input.promptPackId, mode)?.id ?? DEFAULT_PROMPT_PACK_ID
  return {
    strategyId,
    promptPackId: findEnabled(catalog.promptPacks, promptPackId, mode)?.id ?? failClosedPromptPack(mode).id,
    executionMode: normalizeExecutionMode(mode, input.executionMode, namespace),
    portfolioTimingPresetId: mode === 'live' ? normalizePortfolioTimingPresetId(input.portfolioTimingPresetId, catalog) : undefined,
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  }
}

function normalizeExecutionMode(mode: TradeRuntimeMode, value: unknown, namespace = ''): TradeStrategyRuntimeSelection['executionMode'] {
  if (mode !== 'live') return 'legacy_direct'
  if (namespace === 'ashare' && value === 'trading_agent') return 'trading_agent'
  return value === 'candidate_pool' ? 'candidate_pool' : 'legacy_direct'
}

function normalizePortfolioTimingPresetId(value: unknown, catalog: ReturnType<typeof loadCatalog>): TradeStrategyRuntimeSelection['portfolioTimingPresetId'] {
  const prompt = catalog.portfolioReviewPacks.find((item) => item.id === DEFAULT_PORTFOLIO_REVIEW_PROMPT_ID && item.enabledFor.includes('live'))
  if (!prompt) return 'deepseek_balanced_v1'
  return prompt.timingPresets.some((item) => item.id === value) ? value as TradeStrategyRuntimeSelection['portfolioTimingPresetId'] : prompt.defaultPresetId
}

function defaultPortfolioTimingPresetId(catalog: ReturnType<typeof loadCatalog>): TradeStrategyRuntimeSelection['portfolioTimingPresetId'] {
  const prompt = catalog.portfolioReviewPacks.find((item) => item.id === DEFAULT_PORTFOLIO_REVIEW_PROMPT_ID && item.enabledFor.includes('live'))
  return prompt?.defaultPresetId ?? 'deepseek_balanced_v1'
}

function findEnabled<T extends { id: string; enabledFor: TradeRuntimeMode[] }>(items: T[], id: string | undefined, mode: TradeRuntimeMode): T | undefined {
  return items.find((item) => item.id === id && item.enabledFor.includes(mode))
}

function toOption(item: TradeStrategyConfig | TradePromptPackConfig): TradeStrategyOption {
  return {
    id: item.id,
    label: item.label,
    version: item.version,
    summary: item.summary,
    enabledFor: item.enabledFor,
  }
}

function selectionKey(mode: TradeRuntimeMode, namespace = ''): string {
  return namespace ? `trade_strategy_runtime_config:${mode}:${namespace}` : `trade_strategy_runtime_config:${mode}`
}

function selectionCacheKey(mode: TradeRuntimeMode, namespace = ''): TradeRuntimeMode | string {
  return namespace ? `${mode}:${namespace}` : mode
}

function persistSelection(mode: TradeRuntimeMode, value: TradeStrategyRuntimeSelection, updatedAt: string, namespace = '') {
  const payload = { action: 'set_config', key: selectionKey(mode, namespace), value, updatedAt }
  if (process.env.NODE_ENV === 'test') {
    const stored = runConfigBridge<{ ok: true }>(payload)
    if (stored?.ok !== true) {
      logger.warn({ event: 'trade_strategy.persist_failed', mode, error: stored?.ok === false ? stored.error : 'unknown' }, 'Trade strategy selection persistence failed')
    }
    return
  }
  runConfigBridgeAsync(payload, (result) => {
    if (result?.ok !== true) {
      logger.warn({ event: 'trade_strategy.persist_failed', mode, error: result?.ok === false ? result.error : 'unknown' }, 'Trade strategy selection persistence failed')
    }
  })
}

function failClosedStrategy(mode: TradeRuntimeMode): TradeStrategyConfig {
  return {
    id: `fail_closed_${mode}`,
    version: 1,
    label: '配置失败保护策略',
    summary: '策略配置加载失败，禁止新开仓，仅允许降低风险动作。',
    enabledFor: [mode],
    riskControls: {
      singleNameExposure: { maxPctEquity: 0, mode: 'hard_block' },
      shortExposure: { maxSingleNamePctEquity: 0, maxPortfolioShortPctEquity: 0, mode: 'hard_block' },
      buyingPowerProtection: { maxPctBuyingPower: 0, mode: 'hard_block' },
      feeDrag: { maxRoundTripFeePctNotional: 0, mode: 'hard_block' },
    },
    trendFilters: { requireTrendForOpening: true, blockAgainstTrendOpening: true, blockScalpOpeningWhenFlat: true, minWhyNotNoiseLength: 999 },
    copy: { riskModelDescription: '策略配置加载失败，后端禁止新开仓，仅允许降低风险动作。' },
  }
}

function failClosedPromptPack(mode: TradeRuntimeMode): TradePromptPackConfig {
  return {
    id: `fail_closed_prompt_${mode}`,
    version: 1,
    label: '配置失败 Prompt',
    summary: 'Prompt 配置加载失败。',
    enabledFor: [mode],
    systemPrompts: { [mode]: '配置加载失败。只能返回 HOLD JSON。' },
    hardConstraints: { common: ['配置加载失败，只能 HOLD。'] },
    requiredJson: {},
  }
}

function failClosedPortfolioReviewPrompt(): LivePortfolioReviewPromptConfig {
  return {
    id: 'live_portfolio_candidate_review_v1',
    version: 1,
    label: '配置失败组合裁决 Prompt',
    summary: '组合裁决 Prompt 配置加载失败，禁止推进候选。',
    enabledFor: ['live'],
    systemPrompt: '配置加载失败。只能返回空 promotedCandidates JSON。',
    task: '组合裁决配置加载失败。',
    defaultPresetId: 'deepseek_balanced_v1',
    timingPresets: [
      {
        id: 'deepseek_balanced_v1',
        label: 'DeepSeek 平衡版 v1',
        version: 1,
        description: '配置失败 fallback，禁止推进候选。',
        singleSignalScanIntervalMinutes: 2,
        portfolioReviewIntervalMinutes: 5,
        candidateTtlMinutes: 15,
        leveragedEtfCooldownMinutes: 8,
        minSignalConfirmations: 2,
        maxPromotedOrdersPerReview: 0,
        maxActiveCandidates: 12,
      },
    ],
    decisionRules: ['配置加载失败，不推进任何候选。'],
    requiredJson: { ok: true, promotedCandidates: [], watchedCandidates: [], suppressedCandidates: [], expiredCandidates: [], portfolioRationale: '配置加载失败，不推进。' },
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new Error('YAML must be an object.')
  return value as Record<string, unknown>
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
  if (result.status !== 0) return { ok: false, error: result.stderr || result.stdout || 'SQLite config bridge failed.' }
  const jsonLine = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{') && line.endsWith('}'))
    .at(-1)
  if (!jsonLine) return { ok: false, error: 'SQLite config bridge returned empty output.' }
  return JSON.parse(jsonLine) as ({ ok: true } & T) | { ok: false; error?: string }
}

function runConfigBridgeAsync<T>(payload: Record<string, unknown>, onDone: (result: ({ ok: true } & T) | { ok: false; error?: string } | undefined) => void) {
  const pythonBin = process.env.FUTU_PYTHON_BIN || 'python3'
  const dbPath = process.env.SIMULATION_HISTORY_DB_PATH || DEFAULT_DB_PATH
  const child = spawn(pythonBin, [PYTHON_SCRIPT_PATH], {
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  let completed = false
  const finish = (result: ({ ok: true } & T) | { ok: false; error?: string } | undefined) => {
    if (completed) return
    completed = true
    onDone(result)
  }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  child.on('error', (error) => {
    finish({ ok: false, error: error.message })
  })
  child.on('close', (status) => {
    if (status !== 0) {
      finish({ ok: false, error: stderr || stdout || 'SQLite config bridge failed.' })
      return
    }
    const jsonLine = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('{') && line.endsWith('}'))
      .at(-1)
    if (!jsonLine) {
      finish({ ok: false, error: 'SQLite config bridge returned empty output.' })
      return
    }
    try {
      finish(JSON.parse(jsonLine) as ({ ok: true } & T) | { ok: false; error?: string })
    } catch (error) {
      finish({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })
  child.stdin.end(JSON.stringify({ dbPath, ...payload }))
}
