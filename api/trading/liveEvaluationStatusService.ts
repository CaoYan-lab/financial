import type {
  LiveEvaluationStatus,
  LiveEvaluationTickerStatus,
} from '../../shared/types.js'
import { llmMarketSessionSkipReason } from '../simulation/usOvernightLlmGate.js'

type EvaluationMarketState = {
  ticker: string
  marketState?: string
  updatedAt?: string
  evaluationError?: string
}

export function liveEvaluationSkipReason(input: {
  ticker: string
  marketState?: string
  disableUsOvernightLlm: boolean
  now?: Date
}): string | undefined {
  const marketState = String(input.marketState ?? '').trim().toUpperCase()
  if (!marketState || marketState === 'UNAVAILABLE') {
    return '市场状态暂时无法确认，本轮不发送大模型请求。'
  }
  return llmMarketSessionSkipReason(input)
}

export function buildLiveEvaluationStatus(input: {
  running: boolean
  items: EvaluationMarketState[]
  disableUsOvernightLlm: boolean
  lastError?: string
  updatedAt?: string
}): LiveEvaluationStatus {
  const updatedAt = input.updatedAt || newestTimestamp(input.items) || new Date().toISOString()
  const items = input.items.map((item) => buildTickerStatus(item, input))
  const activeCount = items.filter((item) => item.evaluationState === 'ACTIVE').length
  const waitingCount = items.filter((item) =>
    item.evaluationState === 'WAITING_MARKET' || item.evaluationState === 'DISABLED').length
  const errorCount = items.filter((item) => item.evaluationState === 'ERROR').length
  const totalCount = items.length

  if (!input.running) {
    return {
      state: 'STOPPED',
      title: '实盘评估已停止',
      summary: `当前股票池共 ${totalCount} 个标的，启动后将按市场时段自动评估。`,
      activeCount: 0,
      waitingCount: totalCount,
      totalCount,
      updatedAt,
      items,
    }
  }
  if (input.lastError || errorCount > 0) {
    return {
      state: 'ERROR',
      title: '实盘评估状态异常',
      summary: input.lastError || `${errorCount} 个标的的市场状态暂时无法确认，已按休市保护。`,
      activeCount,
      waitingCount,
      totalCount,
      updatedAt,
      items,
    }
  }
  if (activeCount === 0) {
    return {
      state: 'WAITING_MARKET',
      title: '实盘评估运行中，当前等待开市',
      summary: `股票池共 ${totalCount} 个标的，当前均不进入模型评估，也不会生成策略信号。`,
      activeCount,
      waitingCount,
      totalCount,
      updatedAt,
      items,
    }
  }
  if (waitingCount > 0) {
    return {
      state: 'PARTIAL',
      title: '实盘评估运行中，部分市场等待开市',
      summary: `${activeCount} 个标的正在评估，${waitingCount} 个标的等待市场开放。`,
      activeCount,
      waitingCount,
      totalCount,
      updatedAt,
      items,
    }
  }
  return {
    state: 'RUNNING',
    title: '实盘评估运行中',
    summary: `股票池 ${totalCount} 个标的均处于可评估时段。`,
    activeCount,
    waitingCount,
    totalCount,
    updatedAt,
    items,
  }
}

function buildTickerStatus(
  item: EvaluationMarketState,
  input: {
    running: boolean
    disableUsOvernightLlm: boolean
  },
): LiveEvaluationTickerStatus {
  const ticker = normalizeTicker(item.ticker)
  const marketState = String(item.marketState || 'UNAVAILABLE').toUpperCase()
  const marketLabel = marketStateLabel(marketState)
  const market = /^\d{5}$/.test(ticker) ? '港股' : '美股'

  if (!input.running) {
    return {
      ticker,
      market,
      marketState,
      marketLabel,
      evaluationState: 'DISABLED',
      reason: '实盘评估尚未启动。',
    }
  }
  if (marketState === 'UNAVAILABLE') {
    return {
      ticker,
      market,
      marketState,
      marketLabel,
      evaluationState: 'ERROR',
      reason: '市场状态暂时无法确认，已按休市保护。',
    }
  }
  const reason = liveEvaluationSkipReason({
    ticker,
    marketState,
    disableUsOvernightLlm: input.disableUsOvernightLlm,
  })
  if (reason) {
    return {
      ticker,
      market,
      marketState,
      marketLabel,
      evaluationState: marketState === 'OVERNIGHT' ? 'DISABLED' : 'WAITING_MARKET',
      reason: readableReason(reason),
    }
  }
  if (item.evaluationError) {
    return {
      ticker,
      market,
      marketState,
      marketLabel,
      evaluationState: 'ERROR',
      reason: item.evaluationError,
    }
  }
  return {
    ticker,
    market,
    marketState,
    marketLabel,
    evaluationState: 'ACTIVE',
    reason: '当前处于策略允许的评估时段。',
  }
}

function normalizeTicker(value: string): string {
  const upper = value.trim().toUpperCase()
  const hk = upper.match(/^(?:HK\.)?(\d{1,5})(?:\.HK)?$/)
  if (hk) return hk[1].padStart(5, '0')
  return upper.replace(/\.US$/, '')
}

function marketStateLabel(state: string): string {
  if (state === 'PRE_MARKET_BEGIN' || state === 'PRE_MARKET_END') return '盘前'
  if (state === 'MORNING' || state === 'AFTERNOON' || state === 'AUCTION' || state === 'TRADE_AT_LAST' || state === 'RTH') return '盘中'
  if (state === 'AFTER_HOURS_BEGIN' || state === 'AFTER_HOURS_END') return '盘后'
  if (state === 'OVERNIGHT' || state === 'NIGHT' || state === 'NIGHT_OPEN') return '夜盘'
  if (state === 'WAITING_OPEN') return '等待开市'
  if (state === 'REST') return '午间休市'
  if (state === 'CLOSED' || state === 'NONE') return '休市'
  return '状态不可用'
}

function readableReason(reason: string): string {
  return reason
    .replace(/\s*LLM\s*/g, '大模型')
    .replace(/\s*CLOSED\s*/g, '休市')
    .replace(/\s*UNAVAILABLE\s*/g, '不可用')
}

function newestTimestamp(items: EvaluationMarketState[]): string | undefined {
  return items
    .map((item) => item.updatedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1)
}
