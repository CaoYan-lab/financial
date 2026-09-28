export type BillingPeriod = 'MONTHLY' | 'QUARTERLY' | 'YEARLY'

const durationMonths: Record<BillingPeriod, number> = {
  MONTHLY: 1,
  QUARTERLY: 3,
  YEARLY: 12,
}

export function billingPeriodMonths(period: BillingPeriod): number {
  return durationMonths[period]
}

export function addCalendarMonths(value: Date, months: number): Date {
  if (!Number.isInteger(months)) throw new Error('BILLING_MONTHS_INVALID')
  const targetMonth = value.getUTCMonth() + months
  const targetYear = value.getUTCFullYear() + Math.floor(targetMonth / 12)
  const normalizedMonth = ((targetMonth % 12) + 12) % 12
  const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate()
  return new Date(Date.UTC(
    targetYear,
    normalizedMonth,
    Math.min(value.getUTCDate(), lastDay),
    value.getUTCHours(),
    value.getUTCMinutes(),
    value.getUTCSeconds(),
    value.getUTCMilliseconds(),
  ))
}

export function subscriptionExpiry(start: Date, period: BillingPeriod): Date {
  return addCalendarMonths(start, billingPeriodMonths(period))
}

export function renewalStart(currentExpiry: Date, paidAt: Date): Date {
  return currentExpiry.getTime() > paidAt.getTime() ? currentExpiry : paidAt
}

export function monthlyAnniversaryWindow(
  periodStart: Date,
  expiresAt: Date,
  now: Date,
): { start: Date; end: Date } | null {
  if (now.getTime() < periodStart.getTime() || now.getTime() >= expiresAt.getTime()) return null
  let monthOffset = (
    (now.getUTCFullYear() - periodStart.getUTCFullYear()) * 12
    + now.getUTCMonth()
    - periodStart.getUTCMonth()
  )
  let start = addCalendarMonths(periodStart, monthOffset)
  if (start.getTime() > now.getTime()) {
    monthOffset -= 1
    start = addCalendarMonths(periodStart, monthOffset)
  }
  const end = addCalendarMonths(periodStart, monthOffset + 1)
  return { start, end: end.getTime() < expiresAt.getTime() ? end : expiresAt }
}
