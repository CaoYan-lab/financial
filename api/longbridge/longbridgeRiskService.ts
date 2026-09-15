import type { LiveAccountDashboardResponse, LlmTradingDecision, Position, TradeStrategyConfig } from '../../shared/types.js'
import { estimateLongbridgePreTradeFee } from './longbridgeFeeService.js'
import { longbridgeOpeningLotSizeFailureReason } from './longbridgeLotSizeService.js'

export function longbridgeOpeningRiskRejectionReason(
  account: LiveAccountDashboardResponse,
  decision: Pick<LlmTradingDecision, 'action' | 'ticker' | 'orderQuantity'>,
  limitPrice: number,
  tradeStrategy: TradeStrategyConfig,
  symbol = decision.ticker,
  lotSize?: number,
  options: { blockOpeningWhenCashNegative?: boolean } = {},
): string | undefined {
  const positionQuantityFailure = longbridgePositionQuantityFailureReason(
    account.positions,
    decision,
  )
  if (positionQuantityFailure) return positionQuantityFailure
  if (!isOpeningTrade(account.positions, decision)) return undefined
  const accountDataFailure = longbridgeOpeningAccountDataFailureReason(
    account,
    options.blockOpeningWhenCashNegative !== false,
  )
  if (accountDataFailure) return accountDataFailure
  const financingRiskReason = longbridgeMarginRiskOpeningFailureReason(account, decision)
  if (financingRiskReason) return financingRiskReason
  const lotSizeFailure = longbridgeOpeningLotSizeFailureReason({
    symbol,
    action: decision.action,
    quantity: decision.orderQuantity,
    lotSize,
  })
  if (lotSizeFailure) return `长桥开仓风控被拦截：${lotSizeFailure}`
  const equity = parseMoney(account.summary.totalAssetsInTradingCurrency) ?? parseMoney(account.summary.totalAssets) ?? parseMoney(account.summary.buyingPowerInTradingCurrency) ?? parseMoney(account.summary.buyingPower)
  const buyingPower = parseMoney(account.summary.buyingPowerInTradingCurrency) ?? parseMoney(account.summary.availableFundsInTradingCurrency) ?? parseMoney(account.summary.buyingPower) ?? equity
  const tradingCurrency = account.summary.tradingCurrency ?? 'USD'
  const notional = decision.orderQuantity * limitPrice
  const controls = tradeStrategy.riskControls
  const buyingPowerPct = controls.buyingPowerProtection?.maxPctBuyingPower ?? 0.95
  const estimatedFee = estimateLongbridgePreTradeFee(decision.orderQuantity, limitPrice, symbol).feeAmount ?? Infinity
  const feeRatio = estimatedFee / notional
  const maxFeeRatio = controls.feeDrag?.maxRoundTripFeePctNotional

  if (!equity || !buyingPower) {
    return `长桥开仓风控被拦截：${tradingCurrency} 账户权益或最大购买力不可用。`
  }
  if (
    options.blockOpeningWhenCashNegative !== false
    && decision.action === 'BUY'
  ) {
    const accountCash = parseMoney(
      account.summary.cashInTradingCurrency
        ?? account.summary.cash,
    )
    const requiredCash = notional + estimatedFee
    if (
      accountCash !== undefined
      && (accountCash <= 0 || !Number.isFinite(requiredCash) || requiredCash > accountCash)
    ) {
      return [
        `长桥账户现金开仓上限已拦截：折算账户现金 ${formatMoney(accountCash, tradingCurrency)}`,
        `订单金额与预估费用合计 ${formatMoney(requiredCash, tradingCurrency)}`,
        '允许跨币种融资，但买入不得超过账户总现金。',
      ].join('；')
    }
  }
  if (controls.buyingPowerProtection?.mode !== 'off' && notional > buyingPower * buyingPowerPct) {
    return `长桥开仓风控被拦截：名义金额 ${formatMoney(notional, tradingCurrency)} 超过 ${tradingCurrency} 最大购买力保护线 ${formatMoney(buyingPower * buyingPowerPct, tradingCurrency)}（当前最大购买力 ${formatMoney(buyingPower, tradingCurrency)}）。`
  }
  if (maxFeeRatio !== undefined && controls.feeDrag?.mode !== 'off' && feeRatio > maxFeeRatio) {
    return `长桥开仓风控被拦截：估算费用 ${formatMoney(estimatedFee, tradingCurrency)} 占名义金额 ${(feeRatio * 100).toFixed(2)}%，超过当前策略上限 ${(maxFeeRatio * 100).toFixed(2)}%。`
  }
  return undefined
}

export function longbridgeOpeningAccountDataFailureReason(
  account: LiveAccountDashboardResponse,
  requireAccountCash = true,
): string | undefined {
  const summary = account.summary
  const equity = parseMoney(
    summary.totalAssetsInTradingCurrency ?? summary.totalAssets,
  )
  const buyingPower = parseMoney(
    summary.buyingPowerInTradingCurrency ?? summary.buyingPower,
  )
  const accountCash = parseMoney(
    summary.cashInTradingCurrency ?? summary.cash,
  )
  if (!account.ok) {
    return '长桥开仓风控被拦截：账户快照读取失败，无法确认融资风险和购买力。'
  }
  if (parseLongbridgeRiskLevel(summary.financingRiskLevel) === undefined) {
    return '长桥开仓风控被拦截：融资风险等级不可用，禁止在未知风险状态下新增仓位。'
  }
  if (equity === undefined || equity <= 0 || buyingPower === undefined || buyingPower <= 0) {
    return '长桥开仓风控被拦截：账户权益或最大购买力不可用。'
  }
  if (requireAccountCash && accountCash === undefined) {
    return '长桥开仓风控被拦截：折算账户现金不可用，无法执行账户现金开仓上限。'
  }
  return undefined
}

export function longbridgePositionQuantityFailureReason(
  positions: Position[],
  order: Pick<LlmTradingDecision, 'action' | 'ticker' | 'orderQuantity'>,
): string | undefined {
  const position = findPosition(positions, order.ticker)
  const quantity = parseMoney(position?.quantity)
  if (order.action === 'SELL_TO_CLOSE') {
    if (quantity === undefined || quantity <= 0) {
      return `长桥持仓保护已拦截：${order.ticker} 没有可平多头持仓，禁止提交 SELL_TO_CLOSE。`
    }
    if (order.orderQuantity > quantity) {
      return `长桥持仓保护已拦截：${order.ticker} 平仓数量 ${order.orderQuantity} 股超过多头持仓 ${quantity} 股，禁止超量卖出形成空头。`
    }
  }
  if (order.action === 'BUY' && quantity !== undefined && quantity < 0 && order.orderQuantity > Math.abs(quantity)) {
    return `长桥持仓保护已拦截：${order.ticker} 回补数量 ${order.orderQuantity} 股超过空头持仓 ${Math.abs(quantity)} 股，禁止超量买入反向开多。`
  }
  return undefined
}

export function longbridgeMarginRiskOpeningFailureReason(
  account: LiveAccountDashboardResponse,
  order: Pick<LlmTradingDecision, 'action' | 'ticker' | 'orderQuantity'>,
): string | undefined {
  if (!isOpeningTrade(account.positions, order) || !longbridgeFinancingOpeningRestricted(account.summary)) {
    return undefined
  }
  const summary = account.summary
  const currency = summary.tradingCurrency ?? 'USD'
  return [
    `长桥融资风险开仓保护已拦截：账户风险等级为 ${summary.financingRiskLabel ?? longbridgeFinancingRiskLabel(summary.financingRiskLevel)}`,
    `（原始等级 ${summary.financingRiskLevel ?? '未知'}）`,
    `初始保证金 ${summary.initialMargin ?? '不可用'}`,
    `维持保证金 ${summary.maintenanceMargin ?? '不可用'}`,
    `应追缴保证金 ${summary.marginCall ?? formatMoney(0, currency)}`,
    '当前只允许减仓或平仓，禁止新增多头、空头或融资杠杆。',
  ].join('；')
}

export function longbridgeFinancingRiskLabel(value: unknown): string {
  const level = parseLongbridgeRiskLevel(value)
  if (level === 0) return '安全'
  if (level === 1) return '中等'
  if (level === 2) return '预警'
  if (level === 3) return '危险'
  return '未知'
}

export function parseLongbridgeRiskLevel(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[0-3]$/.test(value))) return undefined
  const level = Number(value)
  return Number.isInteger(level) && level >= 0 && level <= 3 ? level : undefined
}

export function longbridgeFinancingOpeningRestricted(
  summary: {
    financingRiskLevel?: number
    financingOpeningRestricted?: boolean
    marginCall?: string
    totalAssets: string
    totalAssetsInTradingCurrency?: string
    initialMargin?: string
  },
): boolean {
  const riskLevel = Number(summary.financingRiskLevel)
  const marginCall = parseMoney(summary.marginCall)
  const totalAssets = parseMoney(summary.totalAssetsInTradingCurrency ?? summary.totalAssets)
  const initialMargin = parseMoney(summary.initialMargin)
  return summary.financingOpeningRestricted === true
    || (Number.isFinite(riskLevel) && riskLevel >= 2)
    || (marginCall !== undefined && marginCall > 0)
    || (
      totalAssets !== undefined
      && initialMargin !== undefined
      && initialMargin > 0
      && totalAssets <= initialMargin
    )
}

export function parseMoney(value: string | undefined): number | undefined {
  if (!value) return undefined
  const normalized = value.replace(/[^0-9.+-]/g, '')
  if (!/\d/.test(normalized)) return undefined
  const numeric = Number(normalized)
  return Number.isFinite(numeric) ? numeric : undefined
}

function isOpeningTrade(
  positions: Position[],
  decision: Pick<LlmTradingDecision, 'action' | 'ticker' | 'orderQuantity'>,
) {
  if (decision.action === 'SELL_SHORT') return true
  const position = findPosition(positions, decision.ticker)
  const quantity = parseMoney(position?.quantity)
  if (decision.action === 'BUY') {
    return quantity === undefined
      || quantity >= 0
      || decision.orderQuantity > Math.abs(quantity)
  }
  if (decision.action === 'SELL_TO_CLOSE') {
    return quantity === undefined
      || quantity <= 0
      || decision.orderQuantity > quantity
  }
  return false
}

function findPosition(positions: Position[], ticker: string): Position | undefined {
  const targetTicker = comparableTicker(ticker)
  return positions.find((item) =>
    (item.assetType === 'STOCK' || item.assetType === 'ETF')
    && comparableTicker(item.ticker) === targetTicker)
}

function comparableTicker(value: string): string {
  return value.trim().toUpperCase()
    .replace(/\.(US|HK)$/, '')
    .replace(/^0+(?=\d)/, '')
}

function formatMoney(value: number, currency = 'USD') {
  const prefix = currency === 'HKD' ? 'HK$' : '$'
  return Number.isFinite(value) ? `${prefix}${value.toFixed(2)}` : 'unavailable'
}
