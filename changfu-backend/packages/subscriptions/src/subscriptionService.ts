import type { BillingPeriod } from './billingClock.js'
import type { SubscriptionPlan } from './catalog.js'

export type SubscriptionStatus = 'ACTIVE' | 'FROZEN' | 'CANCELLED'
export type SubscriptionOrderType = 'NEW' | 'RENEW' | 'UPGRADE'
export type SubscriptionOrderStatus =
  | 'CREATED'
  | 'PAYING'
  | 'PAID'
  | 'FAILED'
  | 'CLOSED'
  | 'REFUNDED'

export class SubscriptionRuleError extends Error {
  constructor(readonly code: string) {
    super('订阅状态或请求不符合规则')
    this.name = 'SubscriptionRuleError'
  }
}

const orderTransitions: Record<SubscriptionOrderStatus, SubscriptionOrderStatus[]> = {
  CREATED: ['PAYING', 'CLOSED'],
  PAYING: ['PAID', 'FAILED', 'CLOSED'],
  PAID: ['REFUNDED'],
  FAILED: ['PAYING', 'CLOSED'],
  CLOSED: [],
  REFUNDED: [],
}

export function transitionSubscriptionOrder(
  current: SubscriptionOrderStatus,
  next: SubscriptionOrderStatus,
): SubscriptionOrderStatus {
  if (!orderTransitions[current].includes(next)) {
    throw new SubscriptionRuleError('ORDER_TRANSITION_INVALID')
  }
  return next
}

export function isSubscriptionEffective(
  subscription: {
    status: SubscriptionStatus
    startsAt: Date
    expiresAt: Date
  },
  now: Date,
): boolean {
  return subscription.status === 'ACTIVE'
    && subscription.startsAt.getTime() <= now.getTime()
    && now.getTime() < subscription.expiresAt.getTime()
}

export function validateProviderSelections(
  providerIds: string[],
  brokerSlotLimit: number,
): string[] {
  if (
    providerIds.length < 1
    || providerIds.length > brokerSlotLimit
    || new Set(providerIds).size !== providerIds.length
    || providerIds.some(providerId => !/^[A-Z][A-Z0-9_]{1,31}$/.test(providerId))
  ) throw new SubscriptionRuleError('PROVIDER_SELECTION_INVALID')
  return [...providerIds]
}

export function planRank(planCode: SubscriptionPlan['planCode']): number {
  return planCode === 'LITE' ? 1 : planCode === 'PRO' ? 2 : 3
}

export function validateOrderType(input: {
  orderType: SubscriptionOrderType
  targetPlan: SubscriptionPlan
  currentPlan: SubscriptionPlan | null
  currentEffective: boolean
}): void {
  if (input.orderType === 'NEW' && input.currentEffective) {
    throw new SubscriptionRuleError('ACTIVE_SUBSCRIPTION_EXISTS')
  }
  if (input.orderType === 'RENEW' && !input.currentPlan) {
    throw new SubscriptionRuleError('SUBSCRIPTION_NOT_FOUND')
  }
  if (
    input.orderType === 'RENEW'
    && input.currentPlan
    && input.targetPlan.planVersionId !== input.currentPlan.planVersionId
  ) throw new SubscriptionRuleError('RENEW_PLAN_MISMATCH')
  if (
    input.orderType === 'UPGRADE'
    && (
      !input.currentPlan
      || !input.currentEffective
      || planRank(input.targetPlan.planCode) <= planRank(input.currentPlan.planCode)
    )
  ) throw new SubscriptionRuleError('UPGRADE_INVALID')
}

export function validateScheduledChange(input: {
  currentPlan: SubscriptionPlan
  targetPlan: SubscriptionPlan
  targetBillingPeriod: BillingPeriod
  currentBillingPeriod: BillingPeriod
  retainedProviderIds: string[]
  boundProviderIds: string[]
}): void {
  const isDowngrade = planRank(input.targetPlan.planCode) < planRank(input.currentPlan.planCode)
  const isPeriodChange = input.targetBillingPeriod !== input.currentBillingPeriod
  if (!isDowngrade && !isPeriodChange) {
    throw new SubscriptionRuleError('SCHEDULED_CHANGE_INVALID')
  }
  const retained = validateProviderSelections(
    input.retainedProviderIds,
    input.targetPlan.brokerSlotLimit,
  )
  if (retained.some(provider => !input.boundProviderIds.includes(provider))) {
    throw new SubscriptionRuleError('RETAINED_PROVIDER_NOT_BOUND')
  }
  if (
    input.boundProviderIds.length > input.targetPlan.brokerSlotLimit
    && retained.length !== input.targetPlan.brokerSlotLimit
  ) throw new SubscriptionRuleError('RETAINED_PROVIDER_SELECTION_REQUIRED')
}
