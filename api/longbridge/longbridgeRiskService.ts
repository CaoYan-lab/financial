import type { LiveAccountDashboardResponse, LlmTradingDecision, Position, TradeStrategyConfig } from '../../shared/types.js'
import { estimateLongbridgePreTradeFee } from './longbridgeFeeService.js'
import { longbridgeOpeningLotSizeFailureReason } from './longbridgeLotSizeService.js'

export function longbridgeOpeningRiskRejectionReason(
  account: LiveAccountDashboardResponse,
  decision: LlmTradingDecision,
  limitPrice: number,
  tradeStrategy: TradeStrategyConfig,
  symbol = decision.ticker,
  lotSize?: number,
): string | undefined {
  if (!isOpeningTrade(account.positions, decision)) return undefined
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
  if (controls.buyingPowerProtection?.mode !== 'off' && notional > buyingPower * buyingPowerPct) {
    return `长桥开仓风控被拦截：名义金额 ${formatMoney(notional, tradingCurrency)} 超过 ${tradingCurrency} 最大购买力保护线 ${formatMoney(buyingPower * buyingPowerPct, tradingCurrency)}（当前最大购买力 ${formatMoney(buyingPower, tradingCurrency)}）。`
  }
  if (maxFeeRatio !== undefined && controls.feeDrag?.mode !== 'off' && feeRatio > maxFeeRatio) {
    return `长桥开仓风控被拦截：估算费用 ${formatMoney(estimatedFee, tradingCurrency)} 占名义金额 ${(feeRatio * 100).toFixed(2)}%，超过当前策略上限 ${(maxFeeRatio * 100).toFixed(2)}%。`
  }
  return undefined
}

export function parseMoney(value: string | undefined): number | undefined {
  if (!value) return undefined
  const numeric = Number(value.replace(/[^0-9.+-]/g, ''))
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

function formatMoney(value: number, currency = 'USD') {
  const prefix = currency === 'HKD' ? 'HK$' : '$'
  return Number.isFinite(value) ? `${prefix}${value.toFixed(2)}` : 'unavailable'
}
