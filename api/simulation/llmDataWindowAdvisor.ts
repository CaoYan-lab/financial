import type { LlmDataWindowRecommendation, SimulationAccountDashboardResponse, SimulationUniverseItem } from '../../shared/types.js'
import { callArkResponses, parseJsonObject } from './llmResponseUtils.js'

export type DataWindowAvailability = {
  minKline1mBars: number
  minTickerPoints: number
  minOrderBookDepth: number
}

const DEFAULT_RECOMMENDATION: LlmDataWindowRecommendation = {
  kline1mBars: 120,
  tickerPoints: 240,
  orderBookDepth: 5,
  pollIntervalSeconds: 60,
  trendLookbackTradingDays: 7,
  trendBarInterval: '30m',
  strategyHorizon: 'SWING_1_TO_7_DAYS',
  reason: '大模型窗口建议不可用，使用默认数据窗口。',
  source: 'fallback',
}

export async function adviseDataWindow(universe: SimulationUniverseItem[], account: SimulationAccountDashboardResponse, availability?: DataWindowAvailability): Promise<LlmDataWindowRecommendation> {
  const bounds = recommendationBounds(availability)
  const response = await callArkResponses([
    {
      role: 'system',
      content:
        '你是量化交易数据窗口顾问。任务是为 Futu SIMULATE 美股正股/ETF大模型交易选择输入数据窗口。必须只返回 JSON，不要 Markdown。',
    },
    {
      role: 'user',
      content: JSON.stringify({
        task: '为大模型自主交易选择每轮输入数据窗口',
        universe,
        account: {
          accountId: account.selectedAccountId,
          totalAssets: account.summary.totalAssets,
          buyingPower: account.summary.buyingPower,
          positions: account.positions.map((position) => ({
            ticker: position.ticker,
            assetType: position.assetType,
            quantity: position.quantity,
            marketValue: position.marketValue,
          })),
        },
        availableData: {
          kline1mBars: { min: bounds.kline1mBars.min, max: bounds.kline1mBars.max, description: '1 分钟 K 线 OHLC；上限已按当前实时缓存可用数量约束' },
          tickerPoints: { min: bounds.tickerPoints.min, max: bounds.tickerPoints.max, description: '分时/逐笔价格点；上限已按当前实时缓存可用数量约束' },
          orderBookDepth: { min: bounds.orderBookDepth.min, max: bounds.orderBookDepth.max, description: '买卖盘深度档位；上限已按当前实时缓存可用数量约束' },
          pollIntervalSeconds: { min: 30, max: 300, description: '策略轮询间隔' },
        },
        requiredJson: {
          kline1mBars: 120,
          tickerPoints: 240,
          orderBookDepth: 5,
          pollIntervalSeconds: 60,
          trendLookbackTradingDays: 7,
          trendBarInterval: '30m',
          strategyHorizon: 'SWING_1_TO_7_DAYS',
          reason: '中文理由',
        },
      }),
    },
  ])

  if (response.ok === false) return clampRecommendation({ ...DEFAULT_RECOMMENDATION, reason: `大模型窗口建议失败：${response.error}` }, bounds, 'fallback')
  return parseRecommendation(response.text, availability)
}

export function parseRecommendation(text: string, availability?: DataWindowAvailability): LlmDataWindowRecommendation {
  const bounds = recommendationBounds(availability)
  const parsed = parseJsonObject(text)
  if (!parsed) return clampRecommendation(DEFAULT_RECOMMENDATION, bounds, 'fallback')
  return clampRecommendation({
    kline1mBars: Number(parsed.kline1mBars),
    tickerPoints: Number(parsed.tickerPoints),
    orderBookDepth: Number(parsed.orderBookDepth),
    pollIntervalSeconds: clampNumber(parsed.pollIntervalSeconds, 30, 300, DEFAULT_RECOMMENDATION.pollIntervalSeconds),
    trendLookbackTradingDays: clampNumber(parsed.trendLookbackTradingDays, 3, 20, DEFAULT_RECOMMENDATION.trendLookbackTradingDays),
    trendBarInterval: parseTrendBarInterval(parsed.trendBarInterval),
    strategyHorizon: parseStrategyHorizon(parsed.strategyHorizon),
    reason: typeof parsed.reason === 'string' ? parsed.reason : DEFAULT_RECOMMENDATION.reason,
    source: 'llm',
  }, bounds, 'llm')
}

function clampRecommendation(recommendation: LlmDataWindowRecommendation, bounds: ReturnType<typeof recommendationBounds>, source: LlmDataWindowRecommendation['source']): LlmDataWindowRecommendation {
  return {
    ...recommendation,
    kline1mBars: clampNumber(recommendation.kline1mBars, bounds.kline1mBars.min, bounds.kline1mBars.max, DEFAULT_RECOMMENDATION.kline1mBars),
    tickerPoints: clampNumber(recommendation.tickerPoints, bounds.tickerPoints.min, bounds.tickerPoints.max, DEFAULT_RECOMMENDATION.tickerPoints),
    orderBookDepth: clampNumber(recommendation.orderBookDepth, bounds.orderBookDepth.min, bounds.orderBookDepth.max, DEFAULT_RECOMMENDATION.orderBookDepth),
    trendLookbackTradingDays: clampNumber(recommendation.trendLookbackTradingDays, 3, 20, DEFAULT_RECOMMENDATION.trendLookbackTradingDays),
    trendBarInterval: parseTrendBarInterval(recommendation.trendBarInterval),
    strategyHorizon: parseStrategyHorizon(recommendation.strategyHorizon),
    source,
  }
}

function recommendationBounds(availability?: DataWindowAvailability) {
  return {
    kline1mBars: { min: 30, max: Math.max(30, Math.min(240, availability?.minKline1mBars || 240)) },
    tickerPoints: { min: 60, max: Math.max(60, Math.min(720, availability?.minTickerPoints || 720)) },
    orderBookDepth: { min: 1, max: Math.max(1, Math.min(10, availability?.minOrderBookDepth || 10)) },
  }
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(Math.max(Math.round(numeric), min), max)
}

function parseTrendBarInterval(value: unknown): LlmDataWindowRecommendation['trendBarInterval'] {
  return value === '15m' || value === '30m' || value === '1d' ? value : DEFAULT_RECOMMENDATION.trendBarInterval
}

function parseStrategyHorizon(value: unknown): LlmDataWindowRecommendation['strategyHorizon'] {
  return value === 'INTRADAY' || value === 'SWING_1_TO_7_DAYS' ? value : DEFAULT_RECOMMENDATION.strategyHorizon
}
