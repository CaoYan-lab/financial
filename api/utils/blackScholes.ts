export function estimateCashSecuredPutPremium(params: {
  stockPrice: number
  strike: number
  dte: number
  iv: number
  riskFreeRate?: number
}): number {
  const { stockPrice, strike, dte, iv, riskFreeRate = 0.045 } = params
  const time = dte / 365
  const sigmaRootT = iv * Math.sqrt(time)

  if (stockPrice <= 0 || strike <= 0 || dte <= 0 || iv <= 0) {
    return 0
  }

  const d1 = (Math.log(stockPrice / strike) + (riskFreeRate + (iv * iv) / 2) * time) / sigmaRootT
  const d2 = d1 - sigmaRootT
  const put = strike * Math.exp(-riskFreeRate * time) * normalCdf(-d2) - stockPrice * normalCdf(-d1)

  return Math.max(0, put)
}

function normalCdf(value: number): number {
  return (1 + erf(value / Math.sqrt(2))) / 2
}

function erf(value: number): number {
  const sign = value >= 0 ? 1 : -1
  const x = Math.abs(value)
  const t = 1 / (1 + 0.3275911 * x)
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x))

  return sign * y
}

