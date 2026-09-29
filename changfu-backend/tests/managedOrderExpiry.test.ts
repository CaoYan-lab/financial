import assert from 'node:assert/strict'
import test from 'node:test'
import {
  managedOrderCancellationReason,
  type ManagedOrderPolicyInput,
} from '../packages/domain/src/managedOrderPolicy.js'

const now = new Date('2026-09-29T14:00:00.000Z')

function validInput(): ManagedOrderPolicyInput {
  return {
    now,
    signalValidUntil: new Date(now.getTime() + 60_000),
    intentExpiresAt: new Date(now.getTime() + 60_000),
    submittedAt: new Date(now.getTime() - 30_000),
    orderType: 'MARKETABLE_LIMIT',
    limitPrice: 200,
    latestReferencePrice: 200.1,
    marketDataFresh: true,
    marketSessionOpen: true,
    securityHalted: false,
    brokerMarketable: true,
    accountRiskValid: true,
    leaseValid: true,
    connectionActive: true,
    filledQuantity: 0,
    lastFilledQuantity: 0,
    lastFillProgressAt: null,
  }
}

test('有效且仍可成交的系统订单继续监管', () => {
  assert.equal(managedOrderCancellationReason(validInput()), null)
})

test('信号和 intent 过期触发安全撤单', () => {
  assert.equal(managedOrderCancellationReason({
    ...validInput(),
    signalValidUntil: now,
  }), 'SIGNAL_EXPIRED')
  assert.equal(managedOrderCancellationReason({
    ...validInput(),
    intentExpiresAt: now,
  }), 'INTENT_EXPIRED')
})

test('MARKETABLE_LIMIT 90 秒和 LIMIT 600 秒未成交触发撤单', () => {
  assert.equal(managedOrderCancellationReason({
    ...validInput(),
    submittedAt: new Date(now.getTime() - 90_000),
  }), 'FILL_TIMEOUT')
  assert.equal(managedOrderCancellationReason({
    ...validInput(),
    orderType: 'LIMIT',
    submittedAt: new Date(now.getTime() - 600_000),
  }), 'FILL_TIMEOUT')
})

test('价格漂移、行情过期、休市和风险变化按优先级撤单', () => {
  assert.equal(managedOrderCancellationReason({
    ...validInput(),
    latestReferencePrice: 201,
  }), 'PRICE_DRIFT')
  assert.equal(managedOrderCancellationReason({
    ...validInput(),
    marketDataFresh: false,
  }), 'MARKET_DATA_STALE')
  assert.equal(managedOrderCancellationReason({
    ...validInput(),
    marketSessionOpen: false,
  }), 'SESSION_ENDED')
  assert.equal(managedOrderCancellationReason({
    ...validInput(),
    accountRiskValid: false,
  }), 'ACCOUNT_RISK_CHANGED')
})

test('自动提交关闭不参与撤单判断，租约丢失仍触发撤单', () => {
  assert.equal(managedOrderCancellationReason({
    ...validInput(),
    leaseValid: false,
  }), 'LEASE_LOST')
})
