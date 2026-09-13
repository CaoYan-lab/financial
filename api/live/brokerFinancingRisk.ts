import type { AccountSummary, LiveAccountDashboardResponse, LiveOrderIntent, LivePendingOrder } from '../../shared/types.js'
import type { TradingPromptBroker } from '../../shared/tradingPromptTypes.js'
import { longbridgeFinancingOpeningRestricted, parseMoney } from '../longbridge/longbridgeRiskService.js'

export type OpeningRisk = 'ALLOWED' | 'BLOCKED' | 'UNKNOWN'

export function financingOpeningStatus(broker: TradingPromptBroker, summary: AccountSummary): OpeningRisk {
  if (broker === 'longbridge') {
    const level = summary.financingRiskLevel
    if (typeof level !== 'number' || !Number.isInteger(level) || level < 0 || level > 3) return 'UNKNOWN'
    return longbridgeFinancingOpeningRestricted(summary) ? 'BLOCKED' : 'ALLOWED'
  }
  // Securities use ExposureLevel/CltRiskStatus, not the futures-only CltRiskLevel.
  const exposure = summary.futuExposureLevel
  const status = summary.futuRiskStatus
  const match = typeof status === 'string' ? /^LEVEL([1-9])$/.exec(status) : null
  if (exposure === 'WARNING' || exposure === 'MARGIN_CALL' || (match && Number(match[1]) >= 7)) return 'BLOCKED'
  if (!summary.financingCurrency || summary.financingCurrency !== summary.currency) return 'UNKNOWN'
  const equity = parseMoney(summary.financingEquity)
  const initial = parseMoney(summary.initialMargin)
  const maintenance = parseMoney(summary.maintenanceMargin)
  if (equity === undefined || initial === undefined || maintenance === undefined || initial < 0 || maintenance < 0) return 'UNKNOWN'
  if (equity !== undefined && ((initial !== undefined && equity < initial) || (maintenance !== undefined && equity < maintenance))) return 'BLOCKED'
  if (exposure && !['SAFE', 'MODERATE', 'NONE', 'N/A'].includes(exposure)) return 'UNKNOWN'
  if (status && !['NONE', 'N/A'].includes(status) && !match) return 'UNKNOWN'
  if (exposure === 'SAFE' || exposure === 'MODERATE' || match) return 'ALLOWED'
  return 'UNKNOWN'
}

export function verifiedCloseQuantity(raw: unknown, quantity: number | null): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 &&
    quantity !== null && Number.isFinite(quantity) && raw <= Math.abs(quantity) ? raw : null
}

export function finalAccountOrderFailure(
  broker: TradingPromptBroker,
  account: LiveAccountDashboardResponse,
  intent: LiveOrderIntent,
  expectedCurrency: string,
): string | undefined {
  if (!account.ok || !account.selectedAccountId || account.selectedAccountId === 'unavailable'
    || account.summary.accountId !== account.selectedAccountId) return '账户快照读取失败或账户不匹配，禁止提交。'
  const age = Date.now() - Date.parse(account.summary.source?.accessedAt ?? '')
  if (!Number.isFinite(age) || age < -5000 || age > 60_000) return '账户快照过期或时间未知，禁止提交。'
  if (account.summary.tradingCurrency !== expectedCurrency) return '交易币种与账户快照不匹配，禁止提交。'
  if (!['BUY', 'SELL_SHORT', 'SELL_TO_CLOSE'].includes(intent.side)
    || !Number.isSafeInteger(intent.quantity) || intent.quantity <= 0
    || !Number.isFinite(intent.limitPrice) || intent.limitPrice <= 0) return '订单方向、数量或价格无效。'
  const symbol = (ticker: string) => ticker.toUpperCase().replace(/^(US|HK)\./, '').replace(/\.(US|HK)$/, '').replace(/^0+(?=\d)/, '')
  const positions = account.positions.filter(p => ['STOCK', 'ETF'].includes(p.assetType)
    && symbol(p.ticker) === symbol(intent.ticker))
  if (positions.some(p => p.currency !== expectedCurrency || parseMoney(p.quantity) === undefined)) return '持仓数量或币种未知，禁止提交。'
  if (positions.length > 1) return '存在多条同标的持仓，需核验账户持仓归属。'
  const position = positions[0], quantity = parseMoney(position?.quantity) ?? 0
  const closing = intent.side === 'SELL_TO_CLOSE' || (intent.side === 'BUY' && quantity < 0)
  if (closing) {
    if (intent.side === 'SELL_TO_CLOSE' && quantity <= 0) return '没有可平多头持仓，禁止反向开仓。'
    const available = verifiedCloseQuantity(position?.availableToClose, quantity)
    if (available === null || intent.quantity > available) return '可平量未知或平仓数量超限，禁止反向开仓。'
    return undefined
  }
  if (intent.side === 'SELL_SHORT' && quantity > 0) return '持有多头时不得以卖空指令替代平仓。'
  if (financingOpeningStatus(broker, account.summary) !== 'ALLOWED') return '融资风险预警或未知，禁止新增仓位。'
  const equity = parseMoney(account.summary.totalAssetsInTradingCurrency)
  const power = parseMoney(account.summary.buyingPowerInTradingCurrency)
  if (equity === undefined || equity <= 0 || power === undefined || power <= 0) return '同币种权益或购买力不可用。'
  if (intent.quantity * intent.limitPrice > power) return '订单名义金额超过可用购买力。'
  if (broker === 'futu' && intent.side === 'SELL_SHORT') return '卖空方向最大可卖数量尚未核验，禁止新增空头。'
}

export function shadowOrderExecutionFailure(order: LivePendingOrder): string | undefined {
  const audit = order.llmDecision.promptAudit
  if (!audit) return undefined
  if (audit.mode !== 'live' || !audit.ordersEnabled) return '新版提示词影子建议禁止提交。'
  if (!audit.contractValid || !audit.policyValid || !audit.contextUsableAtResponse) {
    return '新版提示词实盘建议未通过契约、政策或时效校验，禁止提交。'
  }
  if (!audit.sourceValidUntil || Date.now() > Date.parse(audit.sourceValidUntil)) {
    return '新版提示词所依据的行情或账户快照已过期，禁止提交。'
  }
  return undefined
}

export function livePromptMarketFailure(
  order: LivePendingOrder,
  currentPrice: number | undefined,
  updatedAt: string | undefined,
): string | undefined {
  if (order.llmDecision.promptAudit?.mode !== 'live') return undefined
  const age = Date.now() - Date.parse(updatedAt ?? '')
  if (!(currentPrice && currentPrice > 0) || !Number.isFinite(age) || age < -5000 || age > 60_000) {
    return '新版提示词提交前行情重新采样失败或已过期，禁止提交。'
  }
  const drift = Math.abs(currentPrice - order.intent.limitPrice) / order.intent.limitPrice
  if (!Number.isFinite(drift) || drift > 0.02) return '新版提示词提交前价格偏离超过2%，禁止提交。'
  return undefined
}
