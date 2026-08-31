import { aShareRealtimeStore, emptyCallbackStatus, type AShareRealtimeSnapshot } from './aShareRealtimeStore.js'
import { aShareOrderQueueService } from './aShareOrderQueueService.js'
import { requestAshareTradingAgentDecision } from './aShareTradingAgentService.js'
import { updateAshareTradeStrategyConfig } from './aShareRuntimeConfigService.js'
import type { AShareUniverseItem } from './types.js'
import type { LlmTradingDecision, QuantSignal } from '../../shared/types.js'

export type AShareTradingAgentMockRunInput = {
  ticker?: string
  futuCode?: string
  name?: string
  price?: number
}

export async function runAshareTradingAgentMockRun(input: AShareTradingAgentMockRunInput = {}) {
  const instrument = mockInstrument(input)
  const liveSnapshot = aShareRealtimeStore.snapshot(instrument.ticker)
  const snapshot = supplementSnapshot(liveSnapshot, instrument, input.price)
  updateAshareTradeStrategyConfig({ executionMode: 'trading_agent' })
  const decision = await requestAshareTradingAgentDecision({ instrument, marketData: snapshot, session: 'RTH' })
  const signal = buildMockSignal(instrument.ticker, decision, snapshot)
  aShareOrderQueueService.addSignal(signal)
  return {
    ok: true,
    instrument,
    sourceSnapshot: {
      source: liveSnapshot.source,
      quoteReady: Boolean(liveSnapshot.quote),
      klineBars: liveSnapshot.klineBars.length,
      tickerPoints: liveSnapshot.tickerPoints.length,
      orderBookDepth: Math.max(liveSnapshot.asks.length, liveSnapshot.bids.length),
    },
    supplementedSnapshot: {
      source: snapshot.source,
      quoteReady: Boolean(snapshot.quote),
      klineBars: snapshot.klineBars.length,
      tickerPoints: snapshot.tickerPoints.length,
      orderBookDepth: Math.max(snapshot.asks.length, snapshot.bids.length),
    },
    decision,
    signal,
  }
}

function mockInstrument(input: AShareTradingAgentMockRunInput): AShareUniverseItem {
  const ticker = normalizeAshareTicker(input.ticker || input.futuCode || 'SZ.000001')
  const exchange = ticker.startsWith('SH.') ? 'SH' : 'SZ'
  return {
    ticker,
    futuCode: normalizeAshareTicker(input.futuCode || ticker),
    name: input.name || (ticker === 'SZ.000001' ? '平安银行' : 'A股Mock标的'),
    market: 'CN',
    exchange,
    tradingCurrency: 'CNY',
    assetType: 'STOCK',
    addedAt: new Date().toISOString(),
  }
}

function supplementSnapshot(snapshot: AShareRealtimeSnapshot, instrument: AShareUniverseItem, priceInput?: number): AShareRealtimeSnapshot {
  const now = new Date().toISOString()
  const basePrice = numericPrice(snapshot.quote?.price) ?? priceInput ?? 10.88
  const tickerPoints = snapshot.tickerPoints.length >= 240
    ? snapshot.tickerPoints.slice(-240)
    : Array.from({ length: 240 }, (_, index) => ({
      time: new Date(Date.now() - (239 - index) * 1000).toISOString(),
      price: Number((basePrice + Math.sin(index / 9) * 0.03 + index * 0.0002).toFixed(3)),
    }))
  const klineBars = snapshot.klineBars.length >= 120
    ? snapshot.klineBars.slice(-120)
    : Array.from({ length: 120 }, (_, index) => {
      const close = Number((basePrice + Math.sin(index / 7) * 0.04 + index * 0.0005).toFixed(3))
      return {
        time: new Date(Date.now() - (119 - index) * 60_000).toISOString(),
        open: Number((close - 0.02).toFixed(3)),
        high: Number((close + 0.04).toFixed(3)),
        low: Number((close - 0.05).toFixed(3)),
        close,
      }
    })
  return {
    ok: true,
    ticker: instrument.ticker,
    subscribed: snapshot.subscribed,
    source: 'futu-callback',
    quote: snapshot.quote ?? {
      ticker: instrument.ticker,
      code: instrument.futuCode,
      name: instrument.name,
      price: basePrice.toFixed(2),
      change: '+0.06',
      changePercent: '+0.55%',
      open: (basePrice - 0.08).toFixed(2),
      high: (basePrice + 0.12).toFixed(2),
      low: (basePrice - 0.16).toFixed(2),
      volume: '10000000',
      marketState: 'MORNING',
      updatedAt: now,
    },
    tickerPoints,
    klineBars,
    asks: snapshot.asks.length ? snapshot.asks.slice(0, 5) : [
      { price: (basePrice + 0.01).toFixed(2), size: '5000', depth: 1 },
      { price: (basePrice + 0.02).toFixed(2), size: '8000', depth: 2 },
    ],
    bids: snapshot.bids.length ? snapshot.bids.slice(0, 5) : [
      { price: (basePrice - 0.01).toFixed(2), size: '6200', depth: 1 },
      { price: (basePrice - 0.02).toFixed(2), size: '7000', depth: 2 },
    ],
    callbackStatus: snapshot.callbackStatus ?? emptyCallbackStatus(),
    updatedAt: snapshot.updatedAt || now,
  }
}

function buildMockSignal(ticker: string, decision: LlmTradingDecision, snapshot: AShareRealtimeSnapshot): QuantSignal {
  return {
    id: `ashare-agent-mock-signal-${ticker}-${Date.now()}`,
    ticker,
    strategy: 'LLM_AUTONOMOUS_STOCK_TRADER',
    model: String(decision.finalAgentDecision?.quickThinkLlm ?? 'TradingAgents'),
    modelLabel: String(decision.finalAgentDecision?.llmPresetLabel ?? 'Trading Agent Mock Run'),
    side: decision.action,
    confidence: decision.confidence,
    reason: decision.reason,
    price: snapshot.quote?.price ?? String(decision.limitPrice),
    quantity: String(decision.orderQuantity),
    limitPrice: String(decision.limitPrice),
    riskAssessment: decision.riskAssessment,
    generatedAt: new Date().toISOString(),
    dataWindow: `Mock A股窗口：${decision.dataWindowUsed.kline1mBars} 根 1m K线，${decision.dataWindowUsed.tickerPoints} 个 tickerPoints，${decision.dataWindowUsed.orderBookDepth} 档盘口。`,
    trendAlignment: decision.trendAlignment,
    tradeHorizon: decision.tradeHorizon,
    whyNotNoise: decision.whyNotNoise,
    source: 'futu-callback',
    rawModelOutput: decision.rawText,
    agentRunId: decision.agentRunId,
    agentReports: decision.agentReports,
    finalAgentDecision: decision.finalAgentDecision,
    agentFailureReason: decision.agentFailureReason,
  }
}

function normalizeAshareTicker(value: string): string {
  const normalized = value.trim().toUpperCase()
  if (/^(SH|SZ)\.\d{6}$/.test(normalized)) return normalized
  if (/^\d{6}$/.test(normalized)) return normalized.startsWith('6') ? `SH.${normalized}` : `SZ.${normalized}`
  return 'SZ.000001'
}

function numericPrice(value?: string): number | undefined {
  if (!value) return undefined
  const parsed = Number(value.replace(/[¥￥$,]/g, ''))
  return Number.isFinite(parsed) ? parsed : undefined
}
