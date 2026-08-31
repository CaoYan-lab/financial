import type { UiLanguage } from '@/stores/uiStore'

export function displayValue(value: unknown, language: UiLanguage): string {
  const text = value === undefined || value === null || value === '' ? 'unavailable' : String(value)
  if (language === 'zh' && text.toLowerCase() === 'unavailable') {
    return '不可用'
  }
  return text
}

export function maskAssetValue(): string {
  return '••••••'
}

export function displayVerdict(verdict: string, language: UiLanguage): string {
  if (language === 'en') return verdict
  if (verdict.includes('Buy')) return '买入'
  if (verdict.includes('Add')) return '加仓'
  if (verdict.includes('Trim')) return '减仓'
  if (verdict.includes('Hold')) return '持有'
  return displayValue(verdict, language)
}

export function displayTrack(track: string, language: UiLanguage): string {
  if (language === 'en') return `Track ${track}`
  if (track === 'Both') return '双轨兼具'
  if (track === 'A') return '权利金效率'
  if (track === 'B') return '底仓构建'
  return displayValue(track, language)
}

export function displayAssetType(assetType: string | undefined, language: UiLanguage): string {
  if (language === 'en') return assetType ?? 'OTHER'
  if (assetType === 'STOCK') return '正股'
  if (assetType === 'OPTION') return '期权'
  if (assetType === 'ETF') return 'ETF'
  return '其他'
}

export type ProfitTone = 'profit' | 'loss' | 'neutral'

export function parseSignedNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  const text = String(value).trim()
  if (!text || text.toLowerCase() === 'unavailable' || text === '不可用') return undefined

  const negativeByParentheses = /^\(.*\)$/.test(text)
  const normalized = text
    .replace(/[,$%\s]/g, '')
    .replace(/[()]/g, '')
    .replace(/^\$([+-])/, '$1')
    .replace(/^([+-])\$/, '$1')
    .replace(/^\$/, '')

  const parsed = Number(normalized)
  if (!Number.isFinite(parsed)) return undefined
  return negativeByParentheses ? -Math.abs(parsed) : parsed
}

export function profitTone(value: unknown): ProfitTone {
  const parsed = parseSignedNumber(value)
  if (parsed === undefined || parsed === 0) return 'neutral'
  return parsed > 0 ? 'profit' : 'loss'
}
