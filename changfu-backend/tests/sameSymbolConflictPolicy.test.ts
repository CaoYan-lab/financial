import assert from 'node:assert/strict'
import test from 'node:test'
import type { OrderIntentState } from '../packages/domain/src/contracts.js'
import {
  decideSameSymbolConflict,
  type LatestSignalAction,
} from '../packages/domain/src/sameSymbolConflictPolicy.js'
import type { OrderSpec } from '../packages/domain/src/signedOrderIntent.js'

function order(positionEffect: OrderSpec['positionEffect']): OrderSpec {
  const side = positionEffect === 'OPEN_LONG'
    || positionEffect === 'ADD_LONG'
    || positionEffect === 'COVER_SHORT'
    ? 'BUY'
    : 'SELL'
  return {
    broker: 'FUTU',
    environment: 'REAL',
    market: 'US',
    symbol: 'US.AAPL',
    side,
    positionEffect,
    orderType: 'MARKETABLE_LIMIT',
    tradingSession: 'RTH',
    timeInForce: 'DAY',
    quantity: '1',
    limitPrice: '200.00',
    currency: 'USD',
    maxSlippageBps: 15,
  }
}

const orderActions: Array<[OrderSpec['positionEffect'], LatestSignalAction]> = [
  ['OPEN_LONG', 'BUY'],
  ['COVER_SHORT', 'BUY_TO_COVER'],
  ['REDUCE_LONG', 'SELL_TO_CLOSE'],
  ['OPEN_SHORT', 'SELL_SHORT'],
]
const latestActions: LatestSignalAction[] = [
  'HOLD',
  'BUY',
  'BUY_TO_COVER',
  'SELL_TO_CLOSE',
  'SELL_SHORT',
]

test('所有已提交方向遇到 HOLD 或反向信号均撤销剩余量', () => {
  for (const [effect, matchingAction] of orderActions) {
    for (const latestAction of latestActions) {
      const existing = order(effect)
      const result = decideSameSymbolConflict({
        state: 'TRACKING',
        order: existing,
        latestAction,
        proposedOrder: latestAction === matchingAction ? existing : null,
      })
      if (latestAction === matchingAction) {
        assert.equal(result.action, 'CONTINUE_EXISTING')
      } else {
        assert.equal(result.action, 'REQUEST_CANCEL')
      }
    }
  }
})

test('待确认与已 claim 的旧意图只 supersede，不调用券商撤单', () => {
  for (const state of ['PENDING_CONFIRMATION', 'CLAIMED'] satisfies OrderIntentState[]) {
    assert.equal(decideSameSymbolConflict({
      state,
      order: order('OPEN_LONG'),
      latestAction: 'HOLD',
    }).action, 'SUPERSEDE_PENDING')
  }
})

test('提交未知和撤单中的标的冻结新执行', () => {
  for (const state of [
    'SUBMITTING',
    'UNKNOWN',
    'CANCEL_REQUESTED',
    'CANCEL_PENDING',
    'CANCEL_UNCERTAIN',
  ] satisfies OrderIntentState[]) {
    assert.equal(decideSameSymbolConflict({
      state,
      order: order('OPEN_LONG'),
      latestAction: 'BUY',
      proposedOrder: order('OPEN_LONG'),
    }).action, 'BLOCK_RECONCILE')
  }
})

test('同向信号参数变化也先撤单，不叠单或补差额', () => {
  const existing = order('OPEN_LONG')
  const changed = { ...existing, quantity: '2' }
  assert.deepEqual(decideSameSymbolConflict({
    state: 'PARTIALLY_FILLED',
    order: existing,
    latestAction: 'BUY',
    proposedOrder: changed,
  }), {
    action: 'REQUEST_CANCEL',
    reason: 'ORDER_PARAMETERS_CHANGED',
  })
})

test('外部挂单只阻断，不自动撤销', () => {
  assert.equal(decideSameSymbolConflict({
    state: 'TRACKING',
    order: order('OPEN_LONG'),
    latestAction: 'HOLD',
    hasExternalOpenOrder: true,
  }).action, 'BLOCK_EXTERNAL_ORDER')
})

test('终态订单不阻断基于最新持仓产生的新意图', () => {
  for (const state of [
    'SUPERSEDED',
    'FILLED',
    'CANCELLED',
    'REJECTED',
    'FAILED',
    'EXPIRED',
  ] satisfies OrderIntentState[]) {
    assert.equal(decideSameSymbolConflict({
      state,
      order: order('OPEN_LONG'),
      latestAction: 'SELL_TO_CLOSE',
    }).action, 'ALLOW_NEW')
  }
})
