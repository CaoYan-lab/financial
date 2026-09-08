import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { QuantSignal, SimulatedOrderResult, SimulationSkippedTicker } from '../shared/types'

process.env.SIMULATION_PERSIST_TEST = '1'
const tempDir = mkdtempSync(join(tmpdir(), 'simulation-history-'))
process.env.SIMULATION_HISTORY_DB_PATH = join(tempDir, 'history.sqlite3')

const { simulationPersistence } = await import('../api/simulation/simulationPersistence')

describe('simulationPersistence sqlite', { timeout: 30_000 }, () => {
  beforeEach(() => {
    simulationPersistence.clearForTests()
  })

  it('使用 SQLite 持久化并分页读取模拟盘历史', () => {
    simulationPersistence.appendSignal(signal('AAPL', '2026-06-17T01:00:00Z'))
    simulationPersistence.appendSignal(signal('GOOG', '2026-06-17T02:00:00Z'))
    simulationPersistence.appendOrder(order('GOOG', '2026-06-17T02:01:00Z'))
    simulationPersistence.appendSkipped(skipped('GOOG', '2026-06-17T02:02:00Z'))

    const signals = simulationPersistence.paginate('signals', 1, 1)
    const orders = simulationPersistence.paginate('orders', 1, 10)
    const skippedPage = simulationPersistence.paginate('skipped', 1, 10)

    expect(signals.total).toBe(2)
    expect(signals.items[0].ticker).toBe('GOOG')
    expect(signals.items[0].historyId).toEqual(expect.any(Number))
    expect(signals.items[0].model).toBe('glm-5.2')
    expect(signals.items[0].modelLabel).toBe('GLM5.2')
    expect(signals.totalPages).toBe(2)
    expect(orders.items[0].historyId).toEqual(expect.any(Number))
    expect(orders.items[0].orderId).toBe('order-GOOG')
    expect(skippedPage.items[0].reason).toBe('test skip')

    expect(simulationPersistence.getOrderByHistoryId(orders.items[0].historyId!)).toMatchObject({ orderId: 'order-GOOG' })
    expect(simulationPersistence.findOrderByOrderId('order-GOOG')).toMatchObject({ ticker: 'GOOG' })
    expect(simulationPersistence.findSignalById('signal-GOOG')).toMatchObject({ ticker: 'GOOG' })
  })

  it('按时间近邻 fallback 查找旧订单关联策略信号', () => {
    simulationPersistence.appendSignal({ ...signal('SPCX', '2026-06-17T02:00:00Z'), side: 'BUY' })
    const legacyOrder = {
      ...order('SPCX', '2026-06-17T02:00:03Z'),
      signalId: 'SPCX-LLM_AUTONOMOUS_STOCK_TRADER-old-mismatch',
    }
    simulationPersistence.appendOrder(legacyOrder)

    expect(simulationPersistence.findSignalById(legacyOrder.signalId)).toBeUndefined()
    expect(simulationPersistence.findNearestSignalForOrder(legacyOrder)).toMatchObject({
      ticker: 'SPCX',
      side: 'BUY',
      id: 'signal-SPCX',
    })
  })
})

function signal(ticker: string, generatedAt: string): QuantSignal {
  return {
    id: `signal-${ticker}`,
    ticker,
    strategy: 'LLM_AUTONOMOUS_STOCK_TRADER',
    model: 'glm-5.2',
    modelLabel: 'GLM5.2',
    side: 'HOLD',
    confidence: 'low',
    reason: 'test',
    price: '$100.00',
    quantity: '0',
    limitPrice: '$100.00',
    riskAssessment: 'test',
    generatedAt,
    dataWindow: 'test',
    source: 'futu-callback',
  }
}

function order(ticker: string, submittedAt: string): SimulatedOrderResult {
  return {
    ok: true,
    orderId: `order-${ticker}`,
    ticker,
    side: 'BUY',
    quantity: '1',
    orderType: 'MARKET',
    orderSession: 'RTH',
    limitPrice: 'MARKET',
    submittedAt,
    strategy: 'LLM_AUTONOMOUS_STOCK_TRADER',
    signalId: `signal-${ticker}`,
  }
}

function skipped(ticker: string, updatedAt: string): SimulationSkippedTicker {
  return { ticker, reason: 'test skip', updatedAt }
}

process.on('exit', () => {
  rmSync(tempDir, { recursive: true, force: true })
})
