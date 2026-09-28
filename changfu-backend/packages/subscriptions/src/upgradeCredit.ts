export type UpgradeCreditInput = {
  sourceOrderPaidAmountMinor: number
  sourcePeriodStart: Date
  sourcePeriodEnd: Date
  calculatedAt: Date
}

export type UpgradeCredit = {
  amountMinor: number
  sourceOrderPaidAmountMinor: number
  remainingSeconds: number
  sourcePeriodSeconds: number
  calculatedAt: string
}

export function calculateUpgradeCredit(input: UpgradeCreditInput): UpgradeCredit {
  const sourcePeriodSeconds = Math.max(
    1,
    Math.floor((input.sourcePeriodEnd.getTime() - input.sourcePeriodStart.getTime()) / 1_000),
  )
  const remainingSeconds = Math.max(
    0,
    Math.floor((input.sourcePeriodEnd.getTime() - input.calculatedAt.getTime()) / 1_000),
  )
  const paid = Math.max(0, Math.floor(input.sourceOrderPaidAmountMinor))
  return {
    amountMinor: Math.min(paid, Math.floor(paid * remainingSeconds / sourcePeriodSeconds)),
    sourceOrderPaidAmountMinor: paid,
    remainingSeconds,
    sourcePeriodSeconds,
    calculatedAt: input.calculatedAt.toISOString(),
  }
}
