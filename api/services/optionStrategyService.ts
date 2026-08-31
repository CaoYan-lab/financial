import {
  HIGH_CAPITAL_REQUIREMENT,
  LOW_IV_RANK_THRESHOLD,
  SPECIAL_FLAGS,
  UNAVAILABLE,
} from '../../shared/constants.js'
import type { CompanyAnalysis, OptionStrategy, RawCompanyData } from '../../shared/types.js'

export function buildOptionStrategy(row: RawCompanyData, analysis: Pick<CompanyAnalysis, 'verdict' | 'track'>): OptionStrategy | undefined {
  if (analysis.verdict === 'Trim') {
    return undefined
  }

  const ivRank = parsePercent(row.ivRank)
  const strike = row.selectedOptionStrike ?? UNAVAILABLE
  const expirationDate = normalizeFutuDate(row.selectedOptionExpiry)
  const premium = row.selectedOptionPremium ?? UNAVAILABLE
  const dte = calculateDte(expirationDate)
  const flags: string[] = []

  if (ivRank !== undefined && ivRank < LOW_IV_RANK_THRESHOLD) {
    flags.push(analysis.track === 'B' || analysis.track === 'Both' ? SPECIAL_FLAGS.lowIvCore : SPECIAL_FLAGS.lowIvWait)
  }

  if (row.nextEarningsDate !== UNAVAILABLE && row.nextEarningsDate <= expirationDate) {
    flags.push(`Spans Earnings ${row.nextEarningsDate}`)
  }

  if (strike === UNAVAILABLE || expirationDate === UNAVAILABLE || premium === UNAVAILABLE || dte === undefined) {
    flags.push(SPECIAL_FLAGS.optionChainUnavailable)
    return {
      ticker: row.ticker,
      strike,
      expirationDate,
      dte: dte ?? 0,
      premium,
      annualizedReturn: UNAVAILABLE,
      supportLevel: supportLevel(row),
      capitalPerContract: row.capitalPerContract,
      earningsFlag: earningsFlag(row, expirationDate),
      flags,
      rationale: 'Option chain or option snapshot fields are unavailable from Futu OpenD; no formula-based strike, expiry or premium is generated.',
    }
  }

  const strikeValue = parseMoney(strike)
  const premiumValue = parseMoney(premium)
  const capitalPerContract = strikeValue ? strikeValue * 100 : undefined
  if (capitalPerContract !== undefined && capitalPerContract > HIGH_CAPITAL_REQUIREMENT) {
    flags.push(SPECIAL_FLAGS.highCapital)
  }

  const annualizedReturn =
    premiumValue !== undefined && strikeValue !== undefined ? `${((premiumValue / strikeValue) * (365 / dte) * 100).toFixed(2)}%` : UNAVAILABLE
  const premiumSource = row.selectedOptionPremiumSource && row.selectedOptionPremiumSource !== UNAVAILABLE ? row.selectedOptionPremiumSource : 'Futu option snapshot'
  const deltaText = row.selectedOptionDelta && row.selectedOptionDelta !== UNAVAILABLE ? `; delta ${row.selectedOptionDelta}` : ''
  const codeText = row.selectedOptionCode && row.selectedOptionCode !== UNAVAILABLE ? `; contract ${row.selectedOptionCode}` : ''

  return {
    ticker: row.ticker,
    strike,
    expirationDate,
    dte,
    premium: `${premium} (${premiumSource})`,
    annualizedReturn,
    supportLevel: supportLevel(row),
    capitalPerContract:
      row.capitalPerContract !== UNAVAILABLE
        ? row.capitalPerContract
        : capitalPerContract
          ? `$${capitalPerContract.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
          : UNAVAILABLE,
    earningsFlag: earningsFlag(row, expirationDate),
    flags,
    rationale: `Strike, expiration and premium are selected from Futu OpenD option chain and option snapshot${deltaText}${codeText}.`,
  }
}

function supportLevel(row: RawCompanyData): string {
  if (row.ma200 !== UNAVAILABLE) return row.ma200
  if (row.ma50 !== UNAVAILABLE) return row.ma50
  return UNAVAILABLE
}

function earningsFlag(row: RawCompanyData, expirationDate: string): string {
  if (row.nextEarningsDate === UNAVAILABLE) return 'unavailable'
  if (expirationDate === UNAVAILABLE) return 'unavailable'
  return row.nextEarningsDate <= expirationDate ? `Spans Earnings ${row.nextEarningsDate}` : 'No known earnings overlap'
}

function parseMoney(value: string): number | undefined {
  const parsed = Number(value.replace(/[$,]/g, ''))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function parsePercent(value: string): number | undefined {
  const parsed = Number(value.replace('%', ''))
  return Number.isFinite(parsed) ? parsed : undefined
}

function normalizeFutuDate(value: string | undefined): string {
  if (!value || value === UNAVAILABLE) return UNAVAILABLE
  const match = value.match(/\d{4}-\d{2}-\d{2}/)
  return match?.[0] ?? value
}

function calculateDte(expirationDate: string): number | undefined {
  if (expirationDate === UNAVAILABLE) return undefined
  const [year, month, day] = expirationDate.split('-').map(Number)
  if (!year || !month || !day) return undefined
  const expiryUtc = Date.UTC(year, month - 1, day)
  const now = new Date()
  const todayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  const dte = Math.round((expiryUtc - todayUtc) / 86_400_000)
  return dte > 0 ? dte : undefined
}
