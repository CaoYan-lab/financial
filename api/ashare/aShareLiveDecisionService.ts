import type { AShareRealtimeSnapshot } from './aShareRealtimeStore.js'
import type { AShareUniverseItem } from './types.js'
import type { AccountSummary, LlmTradingDecision, Position } from '../../shared/types.js'
import { callArkResponses, parseJsonObject } from '../simulation/llmResponseUtils.js'
import { getAshareActiveArkModel, getAshareActiveLlmModelOption } from './aShareRuntimeConfigService.js'

export type AShareDecisionPromptInput = {
  instrument: AShareUniverseItem
  marketData: AShareRealtimeSnapshot
  session: string
  positions?: Position[]
  accountSummary?: AccountSummary
}

export function buildAshareDecisionPrompt(input: AShareDecisionPromptInput): string {
  const { instrument, marketData, session } = input
  return [
    '你是 A 股多头量化交易研究员，只能输出 HOLD、BUY、SELL_TO_CLOSE。',
    '硬约束：禁止 SELL_SHORT；币种固定 CNY；只允许连续竞价时段评估可交易订单；必须考虑 T+1、涨跌停、午休、流动性和盘口风险。',
    `标的：${instrument.name} (${instrument.futuCode})，交易所：${instrument.exchange}，当前 session：${session}。`,
    `当前账户该标的多头持仓：${summarizeTargetPosition(instrument.ticker, input.positions ?? [])}。没有多头持仓时禁止输出 SELL_TO_CLOSE。`,
    `最近价格：${marketData.quote?.price ?? 'unavailable'}，marketState：${marketData.quote?.marketState ?? 'unavailable'}。`,
    `数据窗口：1m K线 ${marketData.klineBars.length} 根，tickerPoints ${marketData.tickerPoints.length} 个，卖盘 ${marketData.asks.length} 档，买盘 ${marketData.bids.length} 档。`,
    '输出 JSON 字段：action, confidence, quantityHint, riskNotes, rationale。',
  ].join('\n')
}

function summarizeTargetPosition(ticker: string, positions: Position[]): string {
  const normalized = normalizeTicker(ticker)
  const matches = positions.filter((position) => [position.ticker, position.underlyingTicker, position.code].map(normalizeTicker).includes(normalized))
  if (!matches.length) return '0 股'
  return matches.map((position) => `${position.ticker} ${position.quantity} 股 ${position.assetType}`).join('；')
}

function normalizeTicker(value?: string): string {
  const normalized = String(value ?? '').trim().toUpperCase()
  if (/^(SH|SZ)\.\d{6}$/.test(normalized)) return normalized
  if (/^\d{6}\.(SH|SZ)$/.test(normalized)) {
    const [code, exchange] = normalized.split('.')
    return `${exchange}.${code}`
  }
  if (/^\d{6}$/.test(normalized)) return normalized.startsWith('6') ? `SH.${normalized}` : `SZ.${normalized}`
  return normalized
}

export async function requestAshareDecision(input: AShareDecisionPromptInput): Promise<LlmTradingDecision> {
  const response = await callArkResponses(
    [
      {
        role: 'system',
        content: '你是 A 股多头量化交易研究员。只能返回 JSON，不要 Markdown。',
      },
      {
        role: 'user',
        content: buildAshareDecisionPrompt(input),
      },
    ],
    { model: getAshareActiveArkModel(), modelOption: getAshareActiveLlmModelOption() },
  )
  if (response.ok === false) return blockedDecision(input, `A 股 LLM 调用失败：${response.error}`)
  return parseAshareDecision(response.text, input)
}

function parseAshareDecision(text: string, input: AShareDecisionPromptInput): LlmTradingDecision {
  const parsed = parseJsonObject(text)
  if (!parsed) return blockedDecision(input, 'A 股 LLM 未返回可解析 JSON。', text)
  const action = String(parsed.action ?? 'HOLD').toUpperCase()
  if (!['HOLD', 'BUY', 'SELL_TO_CLOSE', 'SELL_SHORT'].includes(action)) {
    return blockedDecision(input, `非法 A 股交易动作：${action}`, text)
  }
  const quantity = Number(parsed.orderQuantity ?? parsed.quantityHint ?? 0)
  const limitPrice = Number(parsed.limitPrice ?? numericPrice(input.marketData.quote?.price) ?? 0)
  return {
    ok: true,
    approved: parsed.approved === true || action !== 'HOLD',
    action: action as LlmTradingDecision['action'],
    ticker: input.instrument.ticker,
    orderQuantity: Number.isFinite(quantity) ? Math.max(0, Math.floor(quantity)) : 0,
    limitPrice: Number.isFinite(limitPrice) ? limitPrice : 0,
    confidence: typeof parsed.confidence === 'string' ? parsed.confidence : 'low',
    reason: typeof parsed.rationale === 'string' ? parsed.rationale : typeof parsed.reason === 'string' ? parsed.reason : 'A 股 LLM 未提供理由。',
    riskAssessment: typeof parsed.riskNotes === 'string' ? parsed.riskNotes : typeof parsed.riskAssessment === 'string' ? parsed.riskAssessment : 'A 股 LLM 未提供风险说明。',
    trendAlignment: parseTrendAlignment(parsed.trendAlignment),
    tradeHorizon: parseTradeHorizon(parsed.tradeHorizon),
    whyNotNoise: typeof parsed.whyNotNoise === 'string' ? parsed.whyNotNoise : 'A 股 LLM 未说明噪声过滤依据。',
    dataWindowUsed: {
      kline1mBars: Math.min(120, input.marketData.klineBars.length),
      tickerPoints: Math.min(240, input.marketData.tickerPoints.length),
      orderBookDepth: Math.min(5, Math.max(input.marketData.asks.length, input.marketData.bids.length)),
    },
    rawText: text,
  }
}

function blockedDecision(input: AShareDecisionPromptInput, error: string, rawText?: string): LlmTradingDecision {
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
    rawText,
    error,
  }
}

function numericPrice(value?: string): number | undefined {
  if (!value) return undefined
  const parsed = Number(value.replace(/[$,¥￥]/g, ''))
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseTrendAlignment(value: unknown): LlmTradingDecision['trendAlignment'] {
  const normalized = String(value ?? 'UNAVAILABLE').toUpperCase()
  if (['WITH_TREND', 'AGAINST_TREND', 'REVERSAL_ATTEMPT', 'NO_TREND', 'UNAVAILABLE'].includes(normalized)) return normalized as LlmTradingDecision['trendAlignment']
  return 'UNAVAILABLE'
}

function parseTradeHorizon(value: unknown): LlmTradingDecision['tradeHorizon'] {
  const normalized = String(value ?? 'INTRADAY').toUpperCase()
  if (['SCALP', 'INTRADAY', 'SWING_1_TO_7_DAYS'].includes(normalized)) return normalized as LlmTradingDecision['tradeHorizon']
  return 'INTRADAY'
}
