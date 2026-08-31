import { LOW_IV_RANK_THRESHOLD, UNAVAILABLE } from '../../shared/constants.js'
import type { AnalysisResult, CompanyAnalysis, RawCompanyData, Verdict } from '../../shared/types.js'
import { buildOptionStrategy } from './optionStrategyService.js'

export function analyzeCompanies(batchId: string, generatedAt: string, rows: RawCompanyData[]): AnalysisResult {
  const companyAnalyses = rows.map((row) => analyzeCompany(row))
  const topOpportunities = rankTopOpportunities(companyAnalyses).slice(0, 5)
  const bottomLosers = [...companyAnalyses].sort((a, b) => loserScore(b) - loserScore(a)).slice(0, 5)
  const topTickers = new Set(topOpportunities.map((item) => item.ticker))
  const bottomTickers = new Set(bottomLosers.map((item) => item.ticker))
  const remaining = companyAnalyses.filter((item) => !topTickers.has(item.ticker) && !bottomTickers.has(item.ticker))

  return {
    batchId,
    generatedAt,
    companyAnalyses,
    topOpportunities,
    bottomLosers,
    groupedSummary: {
      attractiveButNotTop5: remaining.filter((item) => item.verdict === 'Buy / Add'),
      neutralHold: remaining.filter((item) => item.verdict === 'Hold'),
      trimWatchlistRisk: remaining.filter((item) => item.verdict === 'Trim'),
    },
  }
}

function analyzeCompany(row: RawCompanyData): CompanyAnalysis {
  const rsi = parseNumber(row.rsi14)
  const ivRank = parseNumber(row.ivRank)
  const pe = parseNumber(row.peRatio)
  const price = parseNumber(row.currentPrice)
  const ma50 = parseNumber(row.ma50)
  const ma200 = parseNumber(row.ma200)
  const dataMissing = [row.currentPrice, row.peRatio, row.rsi14, row.ivRank, row.iv30].some((value) =>
    value.toLowerCase().includes(UNAVAILABLE),
  )
  const verdict: Verdict = chooseVerdict({ rsi, ivRank, pe, price, ma50, ma200, dataMissing })
  const track = chooseTrack({ row, ivRank, verdict, price, ma50, ma200 })
  const base: CompanyAnalysis = {
    rank: row.rank,
    ticker: row.ticker,
    companyName: row.companyName,
    country: row.country,
    currentPrice: row.currentPrice,
    ivRank: row.ivRank,
    verdict,
    track,
    rationale: buildRationale(row, verdict, dataMissing),
    supportLevel: row.ma200 !== UNAVAILABLE ? row.ma200 : row.ma50 !== UNAVAILABLE ? row.ma50 : UNAVAILABLE,
    earningsFlag: row.nextEarningsDate === UNAVAILABLE ? 'unavailable' : `Next earnings ${row.nextEarningsDate}`,
    riskFactor: dataMissing ? 'Material market and option fields are unavailable.' : riskFactor(row, rsi, ivRank, pe),
    putSellingView: verdict === 'Trim' ? 'Avoid' : ivRank !== undefined && ivRank < LOW_IV_RANK_THRESHOLD ? 'Low IV - Wait' : 'Only at much lower strike',
  }

  return {
    ...base,
    optionStrategy: buildOptionStrategy(row, base),
  }
}

function chooseVerdict(input: {
  rsi?: number
  ivRank?: number
  pe?: number
  price?: number
  ma50?: number
  ma200?: number
  dataMissing: boolean
}): Verdict {
  if (input.dataMissing) return 'Hold'
  if ((input.rsi ?? 0) > 70 || (input.pe ?? 0) > 45) return 'Trim'
  if (input.price && input.ma200 && input.price <= input.ma200 * 1.05) return 'Buy / Add'
  if (input.ivRank && input.ivRank >= 55) return 'Buy / Add'
  return 'Hold'
}

function chooseTrack(input: {
  row: RawCompanyData
  ivRank?: number
  verdict: Verdict
  price?: number
  ma50?: number
  ma200?: number
}) {
  if (input.verdict === 'Trim') return 'None'
  const trackA = input.ivRank !== undefined && input.ivRank >= 50
  const trackB =
    isMoatName(input.row.ticker) &&
    (input.ivRank === undefined || input.ivRank >= LOW_IV_RANK_THRESHOLD || input.row.ivRank === UNAVAILABLE)

  if (trackA && trackB) return 'Both'
  if (trackA) return 'A'
  if (trackB) return 'B'
  return 'None'
}

function rankTopOpportunities(items: CompanyAnalysis[]): CompanyAnalysis[] {
  return [...items].sort((a, b) => opportunityScore(b) - opportunityScore(a))
}

function opportunityScore(item: CompanyAnalysis): number {
  const trackScore = item.track === 'Both' ? 50 : item.track === 'A' || item.track === 'B' ? 30 : 5
  const verdictScore = item.verdict === 'Buy / Add' ? 35 : item.verdict === 'Hold' ? 15 : -30
  const rankScore = Math.max(0, 31 - item.rank) / 2
  return trackScore + verdictScore + rankScore
}

function loserScore(item: CompanyAnalysis): number {
  const verdictScore = item.verdict === 'Trim' ? 60 : 10
  const missingPenalty = item.riskFactor?.includes('unavailable') ? 25 : 0
  return verdictScore + missingPenalty + item.rank / 2
}

function buildRationale(row: RawCompanyData, verdict: Verdict, dataMissing: boolean): string {
  if (dataMissing) {
    return `${verdict}: key market, valuation or option fields are unavailable; keep judgment conservative until Futu OpenD data is connected.`
  }
  return `${verdict}: supported by available valuation, technical and option-volatility inputs from the same data batch.`
}

function riskFactor(row: RawCompanyData, rsi?: number, ivRank?: number, pe?: number): string {
  if ((rsi ?? 0) > 70) return 'RSI is above 70, suggesting an extended setup.'
  if ((pe ?? 0) > 45) return 'Valuation appears elevated relative to CSP downside risk.'
  if (ivRank !== undefined && ivRank < LOW_IV_RANK_THRESHOLD) return 'Low IV may not compensate put-selling risk.'
  return row.sevenDayNews || 'No specific risk factor identified from available fields.'
}

function isMoatName(ticker: string): boolean {
  return ['NVDA', 'MSFT', 'AAPL', 'GOOG', 'AMZN', 'META', 'AVGO', 'TSM', 'BRK.B', 'LLY', 'JPM', 'V', 'MA', 'ASML'].includes(
    ticker,
  )
}

function parseNumber(value: string): number | undefined {
  const parsed = Number(value.replace(/[$,%x]/gi, '').replace(/,/g, ''))
  return Number.isFinite(parsed) ? parsed : undefined
}
