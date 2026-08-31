import type { LiveAccountDashboardResponse, LlmTradingDecision, Position, TradeStrategyConfig } from '../../shared/types.js'
import { estimateLongbridgePreTradeFee } from './longbridgeFeeService.js'

export function longbridgeOpeningRiskRejectionReason(
  account: LiveAccountDashboardResponse,
  decision: LlmTradingDecision,
  limitPrice: number,
  tradeStrategy: TradeStrategyConfig,
): string | undefined {
  if (!isOpeningTrade(account.positions, decision)) return undefined
  const equity = parseMoney(account.summary.totalAssetsInTradingCurrency) ?? parseMoney(account.summary.totalAssets) ?? parseMoney(account.summary.buyingPowerInTradingCurrency) ?? parseMoney(account.summary.buyingPower)
  const buyingPower = parseMoney(account.summary.buyingPowerInTradingCurrency) ?? parseMoney(account.summary.availableFundsInTradingCurrency) ?? parseMoney(account.summary.buyingPower) ?? equity
  const tradingCurrency = account.summary.tradingCurrency ?? 'USD'
  const notional = decision.orderQuantity * limitPrice
  const controls = tradeStrategy.riskControls
  const buyingPowerPct = controls.buyingPowerProtection?.maxPctBuyingPower ?? 0.95
  const estimatedFee = estimateLongbridgePreTradeFee(decision.orderQuantity, limitPrice, `${decision.ticker}.US`).feeAmount ?? Infinity
  const feeRatio = estimatedFee / notional
  const maxFeeRatio = controls.feeDrag?.maxRoundTripFeePctNotional

  if (!equity || !buyingPower) {
    return `长桥开仓风控被拦截：${tradingCurrency} 账户权益或最大购买力不可用。`
  }
  if (controls.buyingPowerProtection?.mode !== 'off' && notional > buyingPower * buyingPowerPct) {
    return `长桥开仓风控被拦截：名义金额 ${formatMoney(notional)} 超过 ${tradingCurrency} 最大购买力保护线 ${formatMoney(buyingPower * buyingPowerPct)}（当前最大购买力 ${formatMoney(buyingPower)}）。`
  }
  if (maxFeeRatio !== undefined && controls.feeDrag?.mode !== 'off' && feeRatio > maxFeeRatio) {
    return `长桥开仓风控被拦截：估算费用 ${formatMoney(estimatedFee)} 占名义金额 ${(feeRatio * 100).toFixed(2)}%，超过当前策略上限 ${(maxFeeRatio * 100).toFixed(2)}%。`
  }
  return undefined
}

export function parseMoney(value: string | undefined): number | undefined {
  if (!value) return undefined
  const numeric = Number(value.replace(/[$,%\s,]/g, ''))
  return Number.isFinite(numeric) ? numeric : undefined
}

function isOpeningTrade(positions: Position[], decision: LlmTradingDecision) {
  if (decision.action === 'SELL_SHORT') return true
  if (decision.action !== 'BUY') return false
  const position = positions.find((item) => {
    const ticker = (item.underlyingTicker || item.ticker).toUpperCase()
    return ticker === decision.ticker.toUpperCase()
  })
  const quantity = parseMoney(position?.quantity)
  return quantity === undefined || quantity >= 0
}

function formatMoney(value: number) {
  return Number.isFinite(value) ? `$${value.toFixed(2)}` : 'unavailable'
}
