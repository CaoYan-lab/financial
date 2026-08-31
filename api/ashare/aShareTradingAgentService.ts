import { existsSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { AShareTradingAgentRun, LlmTradingDecision } from '../../shared/types.js'
import type { AShareDecisionPromptInput } from './aShareLiveDecisionService.js'
import { getAshareTradingAgentLlmConfig } from './aShareRuntimeConfigService.js'
import { buildAshareTradingAgentDataContext } from './aShareTradingAgentDataContextService.js'
import { aShareTradingAgentRunService } from './aShareTradingAgentRunService.js'
import type { AShareTradingAgentContextBridgeResponse } from './aShareTradingAgentTypes.js'
import { findAsharePositionQuantity, normalizeAshareOrderQuantity } from './aShareRiskService.js'

const BRIDGE_PATH = resolve(process.cwd(), 'api', 'futu_bridge', 'ashare_trading_agents_bridge.py')
const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000
const STATUS_TTL_MS = 30_000
let statusCache: { checkedAt: number; status: AShareTradingAgentRuntimeStatus } | undefined

export type AShareTradingAgentRuntimeStatus = {
  enabled: boolean
  source: 'TauricResearch/TradingAgents'
  repoPath: string
  repoReady: boolean
  pythonBin: string
  pythonReady: boolean
  adapterReady: boolean
  error?: string
}

type BridgeResponse = {
  ok: boolean
  source?: string
  repoPath?: string
  ticker?: string
  tradeDate?: string
  action?: LlmTradingDecision['action']
  decision?: string
  rawDecision?: string
  roleReports?: AShareTradingAgentContextBridgeResponse['roleReports']
  finalDecision?: Record<string, unknown>
  error?: string
}

export function getAshareTradingAgentRuntimeStatus(): AShareTradingAgentRuntimeStatus {
  const now = Date.now()
  if (statusCache && now - statusCache.checkedAt < STATUS_TTL_MS) return statusCache.status
  const repoPath = resolveTradingAgentsRepoPath()
  const pythonBin = resolveTradingAgentsPythonBin()
  const repoReady = existsSync(repoPath)
  if (!repoReady) {
    const status: AShareTradingAgentRuntimeStatus = {
      enabled: false,
      source: 'TauricResearch/TradingAgents',
      repoPath,
      repoReady,
      pythonBin,
      pythonReady: false,
      adapterReady: false,
      error: `TradingAgents repo not found: ${repoPath}`,
    }
    statusCache = { checkedAt: now, status }
    return status
  }
  const result = spawnSync(pythonBin, [BRIDGE_PATH], {
    input: JSON.stringify({ repoPath, checkOnly: true }),
    encoding: 'utf8',
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    timeout: 10000,
  })
  const response = parseBridgeJson(result.stdout)
  const error = response?.ok === false ? response.error : result.error?.message || result.stderr || undefined
  const status: AShareTradingAgentRuntimeStatus = {
    enabled: response?.ok === true,
    source: 'TauricResearch/TradingAgents',
    repoPath,
    repoReady,
    pythonBin,
    pythonReady: response?.ok === true || !String(error ?? '').includes('Python >= 3.10') && result.status !== 127,
    adapterReady: response?.ok === true,
    error,
  }
  statusCache = { checkedAt: now, status }
  return status
}

export async function requestAshareTradingAgentDecision(input: AShareDecisionPromptInput): Promise<LlmTradingDecision> {
  const agentRunId = `ashare-agent-${input.instrument.ticker}-${Date.now()}`
  const llmConfig = getAshareTradingAgentLlmConfig().config
  const startedAt = new Date().toISOString()
  const dataContext = await buildAshareTradingAgentDataContext(input)
  const response = await runTradingAgentsBridge({
    contextAgentRun: true,
    ticker: input.instrument.ticker,
    tradeDate: new Date().toISOString().slice(0, 10),
    repoPath: process.env.TRADINGAGENTS_REPO_PATH,
    dataContext,
    llmProvider: llmConfig.provider,
    backendUrl: llmConfig.backendUrl,
    quickThinkLlm: llmConfig.quickThinkLlm,
    deepThinkLlm: llmConfig.deepThinkLlm,
    maxDebateRounds: llmConfig.maxDebateRounds,
    maxRiskRounds: llmConfig.maxRiskRounds,
    outputLanguage: llmConfig.outputLanguage,
    openaiCompatibleApiKey: process.env[llmConfig.apiKeyEnv],
  })
  if (!response.ok) {
    const decision = blockedAgentDecision(input, agentRunId, response.error ?? 'TradingAgents adapter 调用失败。')
    aShareTradingAgentRunService.append(buildAgentRun({
      agentRunId,
      input,
      startedAt,
      response,
      dataContext,
      llmConfig,
      decision,
      status: 'FAILED',
    }))
    return decision
  }

  const decisionText = response.decision || response.rawDecision || ''
  const action = response.action ?? normalizeAgentAction(decisionText)
  const finalDecision = response.finalDecision ?? {}
  if (typeof finalDecision.sizingFailure === 'string' && finalDecision.sizingFailure) {
    return sizingFailureDecision(input, agentRunId, `Trading Agent 规模决策失败：${finalDecision.sizingFailure}`, response, dataContext, llmConfig, startedAt)
  }
  const limitPrice = normalizePositiveNumber(finalDecision.limitPrice) ?? numericPrice(input.marketData.quote?.price) ?? 0
  const rawOrderQuantity = normalizePositiveNumber(finalDecision.orderQuantity)
  const positionQuantity = findAsharePositionQuantity(input.positions ?? [], input.instrument.ticker)
  const lotSize = Number(process.env.ASHARE_LOT_SIZE ?? 100)
  const orderQuantity = action === 'HOLD' ? 0 : normalizeAshareOrderQuantity(action, rawOrderQuantity ?? 0, positionQuantity, lotSize)
  if (action !== 'HOLD' && orderQuantity <= 0) {
    const error = rawOrderQuantity === undefined
      ? 'Trading Agent 规模决策失败：最终裁决缺少合法 orderQuantity，不能用固定默认数量兜底。'
      : `Trading Agent 规模决策失败：orderQuantity=${rawOrderQuantity} 不满足 A 股交易单位或持仓约束。`
    const decision = sizingFailureDecision(input, agentRunId, error, response, dataContext, llmConfig, startedAt)
    return decision
  }
  const targetNotional = orderQuantity * limitPrice
  const estimatedFee = estimateFee(targetNotional)
  const sizingReason = typeof finalDecision.sizingReason === 'string'
    ? finalDecision.sizingReason
    : action === 'HOLD'
      ? 'Trading Agent 最终裁决为观望，不生成订单规模。'
      : `Trading Agent 建议 ${orderQuantity} 股，预计名义金额 ${targetNotional.toFixed(2)} CNY，预计费用 ${estimatedFee.toFixed(2)} CNY；Node 已按 A 股交易单位和持仓约束归一化。`
  const sourceSummary = `${response.source ?? 'TauricResearch/TradingAgents'} ${response.ticker ?? input.instrument.ticker} ${response.tradeDate ?? ''}`.trim()
  const agentReports = response.roleReports?.length ? response.roleReports : [
    {
      role: 'tradingagents_upstream',
      status: 'OK' as const,
      summary: `通过外部 TradingAgents 仓库生成裁决；preset=${llmConfig.presetLabel}；repoPath=${response.repoPath ?? 'unavailable'}。`,
      raw: response.rawDecision,
    },
    {
      role: 'ashare_adapter',
      status: action === 'HOLD' ? 'WATCH' as const : 'OK' as const,
      summary: `Adapter 将上游裁决映射为 ${action}，数量 ${orderQuantity}，限价 ${limitPrice || 'unavailable'}，预计名义金额 ${targetNotional.toFixed(2)} CNY。`,
    },
  ]
  const decision: LlmTradingDecision = {
    ok: true,
    approved: action !== 'HOLD',
    action,
    ticker: input.instrument.ticker,
    orderQuantity,
    limitPrice,
    confidence: inferConfidence(decisionText),
    reason: `Trading Agent 裁决：${compact(decisionText, 700) || '上游未返回文字裁决。'}`,
    riskAssessment: `来源：${sourceSummary}；模型预设：${llmConfig.presetLabel}；A 股 adapter 仍会执行本地 SELL_SHORT 禁止、RTH、100股交易单位、资金/持仓和人工确认校验。`,
    trendAlignment: inferTrendAlignment(action, input.marketData.klineBars),
    tradeHorizon: 'INTRADAY',
    whyNotNoise: 'TradingAgents 上游多 Agent 研究链输出，A 股 adapter 第一版暂不拆分噪声指标。',
    dataWindowUsed: {
      kline1mBars: Math.min(120, input.marketData.klineBars.length),
      tickerPoints: Math.min(240, input.marketData.tickerPoints.length),
      orderBookDepth: Math.min(5, Math.max(input.marketData.asks.length, input.marketData.bids.length)),
    },
    rawText: JSON.stringify(response, null, 2),
    agentRunId,
    agentReports,
    finalAgentDecision: {
      ...finalDecision,
      action,
      orderQuantity,
      limitPrice,
      targetNotional,
      estimatedFee,
      cashImpact: action === 'BUY' ? -targetNotional - estimatedFee : action === 'SELL_TO_CLOSE' ? targetNotional - estimatedFee : 0,
      positionImpact: action === 'BUY' ? orderQuantity : action === 'SELL_TO_CLOSE' ? -orderQuantity : 0,
      sizingReason,
      minLotSatisfied: action === 'HOLD' ? true : orderQuantity > 0 && (action !== 'BUY' || orderQuantity % (Number.isFinite(lotSize) && lotSize > 0 ? lotSize : 100) === 0),
      source: response.source,
      upstreamTicker: response.ticker,
      tradeDate: response.tradeDate,
      llmPresetId: llmConfig.presetId,
      llmPresetLabel: llmConfig.presetLabel,
      llmProvider: llmConfig.provider,
      quickThinkLlm: llmConfig.quickThinkLlm,
      deepThinkLlm: llmConfig.deepThinkLlm,
    },
  }
  aShareTradingAgentRunService.append(buildAgentRun({
    agentRunId,
    input,
    startedAt,
    response,
    dataContext,
    llmConfig,
    decision,
    status: response.roleReports?.some((report) => report.status === 'ERROR') ? 'PARTIAL' : 'SUCCESS',
  }))
  return decision
}

function sizingFailureDecision(
  input: AShareDecisionPromptInput,
  agentRunId: string,
  error: string,
  response: BridgeResponse,
  dataContext: Awaited<ReturnType<typeof buildAshareTradingAgentDataContext>>,
  llmConfig: ReturnType<typeof getAshareTradingAgentLlmConfig>['config'],
  startedAt: string,
): LlmTradingDecision {
  const action = response.action ?? normalizeAgentAction(response.decision || response.rawDecision || '')
  const decision: LlmTradingDecision = {
    ok: false,
    approved: false,
    action: 'HOLD',
    ticker: input.instrument.ticker,
    orderQuantity: 0,
    limitPrice: numericPrice(input.marketData.quote?.price) ?? 0,
    confidence: 'low',
    reason: error,
    riskAssessment: error,
    trendAlignment: inferTrendAlignment('HOLD', input.marketData.klineBars),
    tradeHorizon: 'INTRADAY',
    whyNotNoise: error,
    dataWindowUsed: {
      kline1mBars: Math.min(120, input.marketData.klineBars.length),
      tickerPoints: Math.min(240, input.marketData.tickerPoints.length),
      orderBookDepth: Math.min(5, Math.max(input.marketData.asks.length, input.marketData.bids.length)),
    },
    rawText: JSON.stringify(response, null, 2),
    error,
    agentRunId,
    agentReports: response.roleReports ?? [],
    finalAgentDecision: {
      ...(response.finalDecision ?? {}),
      requestedAction: action,
      action: 'HOLD',
      orderQuantity: 0,
      limitPrice: numericPrice(input.marketData.quote?.price) ?? 0,
      sizingFailure: error,
    },
    agentFailureReason: error,
  }
  aShareTradingAgentRunService.append(buildAgentRun({
    agentRunId,
    input,
    startedAt,
    response,
    dataContext,
    llmConfig,
    decision,
    status: 'FAILED',
  }))
  return decision
}

function buildAgentRun(input: {
  agentRunId: string
  input: AShareDecisionPromptInput
  startedAt: string
  response: BridgeResponse
  dataContext: Awaited<ReturnType<typeof buildAshareTradingAgentDataContext>>
  llmConfig: ReturnType<typeof getAshareTradingAgentLlmConfig>['config']
  decision: LlmTradingDecision
  status: AShareTradingAgentRun['status']
}): AShareTradingAgentRun {
  return {
    agentRunId: input.agentRunId,
    ticker: input.input.instrument.ticker,
    decisionMode: 'trading_agent',
    executionMode: 'trading_agent',
    startedAt: input.startedAt,
    completedAt: new Date().toISOString(),
    status: input.status,
    llmPresetId: input.llmConfig.presetId,
    llmPresetLabel: input.llmConfig.presetLabel,
    llmProvider: input.llmConfig.provider,
    quickThinkLlm: input.llmConfig.quickThinkLlm,
    deepThinkLlm: input.llmConfig.deepThinkLlm,
    marketDataContext: input.dataContext.marketDataContext as unknown as Record<string, unknown>,
    futuStockContext: input.dataContext.futuStockContext as unknown as Record<string, unknown>,
    stockNewsContext: input.dataContext.stockNewsContext as unknown as Record<string, unknown>,
    macroNewsContext: input.dataContext.macroNewsContext as unknown as Record<string, unknown>,
    aShareRulesContext: input.dataContext.aShareRulesContext,
    sizingContext: input.dataContext.sizingContext as unknown as Record<string, unknown>,
    universeContext: input.dataContext.universeContext as unknown as Record<string, unknown>,
    dataQualityContext: input.dataContext.dataQualityContext,
    roleReports: input.decision.agentReports ?? [],
    finalDecision: input.decision.finalAgentDecision ?? { action: input.decision.action, reason: input.decision.reason },
    rawUpstreamOutput: input.response,
    adapterWarnings: [
      ...input.dataContext.dataQualityContext.warnings,
      ...(input.response.error ? [input.response.error] : []),
    ],
  }
}

function runTradingAgentsBridge(payload: Record<string, unknown>): Promise<BridgeResponse> {
  return new Promise((resolveResponse) => {
    const pythonBin = resolveTradingAgentsPythonBin()
    const child = spawn(pythonBin, [BRIDGE_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      resolveResponse({ ok: false, error: `TradingAgents adapter timeout after ${DEFAULT_TIMEOUT_MS}ms` })
    }, DEFAULT_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolveResponse({ ok: false, error: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const jsonLine = latestJsonLine(stdout)
      if (!jsonLine) {
        resolveResponse({ ok: false, error: stderr || stdout || `TradingAgents adapter exited with code ${code}` })
        return
      }
      try {
        resolveResponse(JSON.parse(jsonLine) as BridgeResponse)
      } catch (error) {
        resolveResponse({ ok: false, error: error instanceof Error ? error.message : 'TradingAgents adapter JSON parse failed' })
      }
    })
    child.stdin.end(JSON.stringify(payload))
  })
}

function inferTrendAlignment(action: LlmTradingDecision['action'], bars: AShareDecisionPromptInput['marketData']['klineBars']): LlmTradingDecision['trendAlignment'] {
  if (bars.length < 2) return 'UNAVAILABLE'
  const firstClose = Number(bars[0]?.close)
  const lastClose = Number(bars[bars.length - 1]?.close)
  if (!firstClose || !lastClose) return 'UNAVAILABLE'
  const changeRatio = (lastClose - firstClose) / firstClose
  if (Math.abs(changeRatio) < 0.001) return 'NO_TREND'
  if (action === 'HOLD') return 'NO_TREND'
  if (action === 'BUY') return changeRatio > 0 ? 'WITH_TREND' : 'REVERSAL_ATTEMPT'
  if (action === 'SELL_TO_CLOSE') return changeRatio < 0 ? 'WITH_TREND' : 'AGAINST_TREND'
  return 'UNAVAILABLE'
}

function blockedAgentDecision(input: AShareDecisionPromptInput, agentRunId: string, error: string): LlmTradingDecision {
  return {
    ok: false,
    approved: false,
    action: 'HOLD',
    ticker: input.instrument.ticker,
    orderQuantity: 0,
    limitPrice: numericPrice(input.marketData.quote?.price) ?? 0,
    confidence: 'low',
    reason: error,
    riskAssessment: error,
    trendAlignment: 'UNAVAILABLE',
    tradeHorizon: 'INTRADAY',
    whyNotNoise: error,
    dataWindowUsed: {
      kline1mBars: Math.min(120, input.marketData.klineBars.length),
      tickerPoints: Math.min(240, input.marketData.tickerPoints.length),
      orderBookDepth: Math.min(5, Math.max(input.marketData.asks.length, input.marketData.bids.length)),
    },
    rawText: error,
    error,
    agentRunId,
    agentFailureReason: error,
    agentReports: [{ role: 'tradingagents_adapter', status: 'ERROR', summary: error }],
  }
}

function resolveTradingAgentsRepoPath(): string {
  return resolve(process.env.TRADINGAGENTS_REPO_PATH || resolve(process.cwd(), 'third_party', 'TradingAgents'))
}

function resolveTradingAgentsPythonBin(): string {
  return process.env.TRADINGAGENTS_PYTHON_BIN || process.env.FUTU_PYTHON_BIN || 'python3'
}

function parseBridgeJson(stdout: string): BridgeResponse | undefined {
  const jsonLine = latestJsonLine(stdout)
  if (!jsonLine) return undefined
  try {
    return JSON.parse(jsonLine) as BridgeResponse
  } catch {
    return undefined
  }
}

function latestJsonLine(stdout: string): string | undefined {
  const candidates: string[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < stdout.length; index += 1) {
    const char = stdout[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      if (depth === 0) start = index
      depth += 1
      continue
    }
    if (char === '}' && depth > 0) {
      depth -= 1
      if (depth === 0 && start >= 0) candidates.push(stdout.slice(start, index + 1))
    }
  }
  return candidates.at(-1)
}

function normalizeAgentAction(text: string): LlmTradingDecision['action'] {
  const upper = text.toUpperCase()
  if (upper.includes('SELL_TO_CLOSE') || upper.includes('SELL') || text.includes('卖出')) return 'SELL_TO_CLOSE'
  if (upper.includes('BUY') || text.includes('买入')) return 'BUY'
  return 'HOLD'
}

function inferConfidence(text: string): string {
  const upper = text.toUpperCase()
  if (upper.includes('STRONG') || text.includes('强')) return 'high'
  if (upper.includes('LOW') || text.includes('弱')) return 'low'
  return 'medium'
}

function numericPrice(value?: string): number | undefined {
  if (!value) return undefined
  const parsed = Number(value.replace(/[$,¥￥,]/g, ''))
  return Number.isFinite(parsed) ? parsed : undefined
}

function normalizePositiveNumber(value: unknown): number | undefined {
  const parsed = Number(String(value ?? '').replace(/[¥￥$,%\s,]/g, ''))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function estimateFee(notional: number): number {
  const rate = Number(process.env.ASHARE_ESTIMATED_FEE_RATE ?? 0.001)
  return notional * (Number.isFinite(rate) && rate > 0 ? rate : 0)
}

function compact(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized
}
