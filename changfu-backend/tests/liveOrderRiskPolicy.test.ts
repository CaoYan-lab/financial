import assert from 'node:assert/strict'
import test from 'node:test'
import {
  evaluateLiveOrderRisk,
  type LiveOrderRiskInput,
} from '../packages/domain/src/liveOrderRiskPolicy.js'

function input(): LiveOrderRiskInput {
  return {
    order: {
      broker: 'FUTU',
      environment: 'REAL',
      market: 'US',
      symbol: 'US.AAPL',
      side: 'BUY',
      positionEffect: 'OPEN_LONG',
      orderType: 'MARKETABLE_LIMIT',
      tradingSession: 'RTH',
      timeInForce: 'DAY',
      quantity: '1',
      limitPrice: '200',
      currency: 'USD',
      maxSlippageBps: 15,
    },
    instrumentType: 'STOCK',
    quoteFresh: true,
    marketOpen: true,
    hasOpenOrderConflict: false,
    availableBuyingPower: 10_000,
    longQuantity: 0,
    shortQuantity: 0,
    lotSize: 1,
    marginAccount: true,
    marginCallActive: false,
    shortRiskDisclosureAccepted: true,
    shortable: true,
    maxShortQuantity: 100,
  }
}

test('真实正股买入通过购买力和基础门禁', () => {
  assert.deepEqual(evaluateLiveOrderRisk(input()), { allowed: true })
  assert.deepEqual(evaluateLiveOrderRisk({
    ...input(),
    availableBuyingPower: 100,
  }), { allowed: false, code: 'INSUFFICIENT_BUYING_POWER' })
})

test('平多和回补不能穿透零仓位', () => {
  const close = input()
  close.order = { ...close.order, side: 'SELL', positionEffect: 'REDUCE_LONG' }
  close.longQuantity = 1
  assert.deepEqual(evaluateLiveOrderRisk(close), { allowed: true })
  assert.deepEqual(evaluateLiveOrderRisk({
    ...close,
    longQuantity: 0,
  }), { allowed: false, code: 'INSUFFICIENT_POSITION' })

  const cover = input()
  cover.order = { ...cover.order, positionEffect: 'COVER_SHORT' }
  cover.shortQuantity = 1
  assert.deepEqual(evaluateLiveOrderRisk(cover), { allowed: true })
  assert.deepEqual(evaluateLiveOrderRisk({
    ...cover,
    longQuantity: 1,
  }), { allowed: false, code: 'ZERO_POSITION_CROSS' })
})

test('卖空必须验证保证金、风险声明、券源和最大数量', () => {
  const short = input()
  short.order = { ...short.order, side: 'SELL', positionEffect: 'OPEN_SHORT' }
  assert.deepEqual(evaluateLiveOrderRisk(short), { allowed: true })
  assert.deepEqual(evaluateLiveOrderRisk({
    ...short,
    marginAccount: false,
  }), { allowed: false, code: 'SHORT_ACCOUNT_REQUIRED' })
  assert.deepEqual(evaluateLiveOrderRisk({
    ...short,
    shortRiskDisclosureAccepted: false,
  }), { allowed: false, code: 'SHORT_RISK_DISCLOSURE_REQUIRED' })
  assert.deepEqual(evaluateLiveOrderRisk({
    ...short,
    shortable: null,
  }), { allowed: false, code: 'SHORT_AVAILABILITY_UNKNOWN' })
  assert.deepEqual(evaluateLiveOrderRisk({
    ...short,
    maxShortQuantity: 0,
  }), { allowed: false, code: 'SHORT_QUANTITY_EXCEEDED' })
})

test('港股数量必须符合 lot size，期权始终拒绝', () => {
  const hk = input()
  hk.order = { ...hk.order, market: 'HK', quantity: '50', currency: 'HKD' }
  hk.lotSize = 100
  assert.deepEqual(evaluateLiveOrderRisk(hk), {
    allowed: false,
    code: 'HK_LOT_SIZE_INVALID',
  })
  assert.deepEqual(evaluateLiveOrderRisk({
    ...input(),
    instrumentType: 'OPTION',
  }), { allowed: false, code: 'UNSUPPORTED_INSTRUMENT' })
})
