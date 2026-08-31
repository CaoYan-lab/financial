import { UNAVAILABLE } from './constants'
import type { RawCompanyData } from './types'

const requiredRawFields: Array<keyof RawCompanyData> = [
  'rank',
  'ticker',
  'companyName',
  'country',
  'currentPrice',
  'marketCap',
  'peRatio',
  'rsi14',
  'ma50',
  'ma200',
  'ivRank',
  'iv30',
  'nextEarningsDate',
  'capitalPerContract',
  'sevenDayNews',
  'source',
]

export function normalizeValue(value: unknown): string {
  if (value === undefined || value === null || value === '') {
    return UNAVAILABLE
  }
  return String(value)
}

export function isRawCompanyData(value: unknown): value is RawCompanyData {
  if (!value || typeof value !== 'object') {
    return false
  }

  return requiredRawFields.every((field) => field in value)
}

export function assertThirtyRows(rawData: RawCompanyData[]): void {
  if (rawData.length !== 30) {
    throw new Error(`Raw data table must contain exactly 30 rows, received ${rawData.length}.`)
  }
}

