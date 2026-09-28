export const SELL_PUT_PROMPT_VERSION = 'top30-mega-cap-csp-v3'
export const SELL_PUT_POOL_CAPACITY = 30

export type SellPutOptionSnapshot = {
  code: string
  expiryDate: string
  strikePrice: number
  bid: number | null
  ask: number | null
  lastPrice: number | null
  delta: number | null
  impliedVolatility: number | null
  volume: number | null
  openInterest: number | null
  contractMultiplier: number
}

export type SellPutObservation = {
  requestId: string
  rank: number
  symbol: string
  displayName: string
  country: string
  capturedAt: string
  currentPrice: number | null
  marketCap: number | null
  peRatio: number | null
  rsi14: number | null
  ma50: number | null
  ma200: number | null
  ivRank: number | null
  iv30: number | null
  nextEarningsDate: string | null
  sevenDayNews: string[]
  trend20d: number | null
  trend60d: number | null
  trend120d: number | null
  distanceTo52wHigh: number | null
  distanceTo52wLow: number | null
  realizedVol30d: number | null
  change30dPercent: number | null
  option: SellPutOptionSnapshot | null
  dataGaps: string[]
}

export type SellPutItemAnalysis = {
  symbol: string
  displayName: string
  candidate: boolean
  score: number | null
  currentPrice: number | null
  change30dPercent: number | null
  optionCode: string | null
  expiryDate: string | null
  daysToExpiry: number | null
  strikePrice: number | null
  premium: number | null
  annualizedReturnPercent: number | null
  safetyMarginPercent: number | null
  cashRequired: number | null
  delta: number | null
  impliedVolatility: number | null
  bidAskSpreadPercent: number | null
  volume: number | null
  openInterest: number | null
  liquidity: '充足' | '有限' | '不可用'
  risks: string[]
  exitConditions: string[]
  dataGaps: string[]
  capturedAt: string
}

export type SellPutReportAnalysis = {
  generatedAt: string
  isUsableForAnalysis: boolean
  candidateCount: number
  dataGapCount: number
  items: SellPutItemAnalysis[]
  topOpportunities: SellPutItemAnalysis[]
  bottomRisks: SellPutItemAnalysis[]
  markdown: string
}

const requiredOptionFields: Array<keyof SellPutOptionSnapshot> = [
  'code',
  'expiryDate',
  'strikePrice',
  'delta',
  'impliedVolatility',
  'openInterest',
]

export function analyzeSellPutReport(
  observations: SellPutObservation[],
  now = new Date(),
): SellPutReportAnalysis {
  const items = observations.map(observation => analyzeObservation(observation, now))
  const candidates = items
    .filter(item => item.candidate)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  const bottomRisks = [...items]
    .sort((a, b) => riskScore(b) - riskScore(a))
    .slice(0, 5)
  const dataGapCount = items.reduce((total, item) => total + item.dataGaps.length, 0)
  const generatedAt = now.toISOString()
  const analysis = {
    generatedAt,
    isUsableForAnalysis: candidates.length > 0,
    candidateCount: candidates.length,
    dataGapCount,
    items,
    topOpportunities: candidates.slice(0, 5),
    bottomRisks,
  }
  return {
    ...analysis,
    markdown: renderMarkdown(analysis),
  }
}

function analyzeObservation(
  observation: SellPutObservation,
  now: Date,
): SellPutItemAnalysis {
  const gaps = [...new Set(observation.dataGaps.filter(Boolean))]
  if (!positive(observation.currentPrice)) gaps.push('正股现价不可用')
  if (!observation.option) {
    gaps.push('目标期限内无可用 PUT 期权链')
  } else {
    for (const field of requiredOptionFields) {
      const value = observation.option[field]
      if (value === null || value === '' || (typeof value === 'number' && !Number.isFinite(value))) {
        gaps.push(`${optionFieldLabel(field)}不可用`)
      }
    }
    if (!positive(observation.option.bid) && !positive(observation.option.ask)
      && !positive(observation.option.lastPrice)) {
      gaps.push('期权权利金不可用')
    }
    if (observation.option.volume === null) gaps.push('期权成交量不可用')
  }

  const option = observation.option
  const premium = option ? optionPremium(option) : null
  const dte = option ? daysToExpiry(option.expiryDate, now) : null
  const margin = positive(observation.currentPrice) && option && positive(option.strikePrice)
    ? ((observation.currentPrice! - option.strikePrice) / observation.currentPrice!) * 100
    : null
  const annualized = premium !== null && option && positive(option.strikePrice) && dte !== null
    ? (premium / (option.strikePrice - premium)) * (365 / dte) * 100
    : null
  const spread = option && positive(option.bid) && positive(option.ask)
    ? ((option.ask! - option.bid!) / ((option.ask! + option.bid!) / 2)) * 100
    : null
  const openInterest = option?.openInterest ?? null
  const liquidity = spread === null || openInterest === null
    ? '不可用'
    : spread <= 15 && openInterest >= 100
      ? '充足'
      : '有限'
  const complete = positive(observation.currentPrice)
    && option !== null
    && requiredOptionFields.every(field => {
      const value = option[field]
      return value !== null && value !== '' && !(typeof value === 'number' && !Number.isFinite(value))
    })
    && option.volume !== null
    && premium !== null
    && dte !== null
  const delta = option?.delta ?? null
  const candidate = complete
    && delta !== null
    && Math.abs(delta) >= 0.15
    && Math.abs(delta) <= 0.40
    && liquidity === '充足'
    && margin !== null
    && margin > 0
    && annualized !== null
    && annualized > 0
  const risks = risksFor({ observation, margin, annualized, spread, dte, liquidity })
  return {
    symbol: observation.symbol,
    displayName: observation.displayName,
    candidate,
    score: candidate
      ? round((margin ?? 0) * 2 + Math.min(annualized ?? 0, 60)
        + Math.max(0, 20 - Math.abs(Math.abs(delta ?? 0) - 0.25) * 100)
        - Math.min(spread ?? 100, 30))
      : null,
    currentPrice: observation.currentPrice,
    change30dPercent: observation.change30dPercent,
    optionCode: option?.code ?? null,
    expiryDate: option?.expiryDate ?? null,
    daysToExpiry: dte,
    strikePrice: option?.strikePrice ?? null,
    premium,
    annualizedReturnPercent: nullableRound(annualized),
    safetyMarginPercent: nullableRound(margin),
    cashRequired: option ? round(option.strikePrice * option.contractMultiplier) : null,
    delta,
    impliedVolatility: option?.impliedVolatility ?? null,
    bidAskSpreadPercent: nullableRound(spread),
    volume: option?.volume ?? null,
    openInterest: option?.openInterest ?? null,
    liquidity,
    risks,
    exitConditions: [
      '正股跌破关键支撑且基本面恶化时平仓或展期',
      '权利金回落至初始收取额的 20% 至 30% 时止盈',
      '到期前 7 天仍接近行权价时复核交割资金与展期条件',
    ],
    dataGaps: [...new Set(gaps)],
    capturedAt: observation.capturedAt,
  }
}

function risksFor(input: {
  observation: SellPutObservation
  margin: number | null
  annualized: number | null
  spread: number | null
  dte: number | null
  liquidity: SellPutItemAnalysis['liquidity']
}): string[] {
  const risks: string[] = []
  if (input.observation.change30dPercent !== null && input.observation.change30dPercent < -10) {
    risks.push('近 30 日跌幅较大，趋势风险偏高')
  }
  if (input.margin !== null && input.margin < 5) risks.push('安全边际低于 5%')
  if (input.annualized !== null && input.annualized > 50) risks.push('高年化收益可能对应异常波动或定价')
  if (input.spread !== null && input.spread > 15) risks.push('买卖价差超过 15%')
  if (input.liquidity === '有限') risks.push('期权流动性有限')
  if (input.dte !== null && (input.dte < 20 || input.dte > 45)) risks.push('到期日偏离 20 至 45 天目标区间')
  return risks
}

function optionPremium(option: SellPutOptionSnapshot): number | null {
  if (positive(option.bid) && positive(option.ask)) return round((option.bid! + option.ask!) / 2)
  if (positive(option.bid)) return option.bid
  if (positive(option.ask)) return option.ask
  return positive(option.lastPrice) ? option.lastPrice : null
}

function daysToExpiry(expiryDate: string, now: Date): number | null {
  const expiry = new Date(`${expiryDate}T00:00:00Z`)
  if (!Number.isFinite(expiry.getTime())) return null
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const days = Math.ceil((expiry.getTime() - today) / 86_400_000)
  return days > 0 ? days : null
}

function positive(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0
}

function optionFieldLabel(field: keyof SellPutOptionSnapshot): string {
  const labels: Record<keyof SellPutOptionSnapshot, string> = {
    code: '期权代码',
    expiryDate: '到期日',
    strikePrice: '行权价',
    bid: '买价',
    ask: '卖价',
    lastPrice: '最新价',
    delta: 'Delta',
    impliedVolatility: '隐含波动率',
    volume: '成交量',
    openInterest: '未平仓量',
    contractMultiplier: '合约乘数',
  }
  return labels[field]
}

function riskScore(item: SellPutItemAnalysis): number {
  return item.dataGaps.length * 20 + item.risks.length * 10
    + (item.liquidity === '不可用' ? 30 : item.liquidity === '有限' ? 15 : 0)
}

function nullableRound(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : round(value)
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function renderMarkdown(
  analysis: Omit<SellPutReportAnalysis, 'markdown'>,
): string {
  const lines = [
    '# SELL PUT 30 日研究报告',
    '',
    `生成时间：${analysis.generatedAt}`,
    `候选数量：${analysis.candidateCount}`,
    `数据缺口：${analysis.dataGapCount}`,
    '',
    '## Top 5 候选',
    '',
  ]
  if (analysis.topOpportunities.length === 0) {
    lines.push('没有满足完整数据与风险门槛的候选。')
  } else {
    for (const item of analysis.topOpportunities) {
      lines.push(
        `- ${item.symbol}：行权价 ${item.strikePrice}，安全边际 ${item.safetyMarginPercent}%`
          + `，年化收益 ${item.annualizedReturnPercent}%`,
      )
    }
  }
  lines.push('', '## 数据缺口与风险', '')
  for (const item of analysis.items.filter(value => value.dataGaps.length || value.risks.length)) {
    lines.push(`- ${item.symbol}：${[...item.dataGaps, ...item.risks].join('；')}`)
  }
  return lines.join('\n')
}
