import { describe, expect, it } from 'vitest'
import { simulationStore } from '../api/simulation/simulationStore'
import type { QuantSignal, SimulatedOrderResult } from '../shared/types'

describe('simulationStore', () => {
  it('维护引擎 start/stop 状态', () => {
    simulationStore.resetForTests()
    simulationStore.setRunning('12345', ['AAPL', 'MSFT'], 60_000)

    expect(simulationStore.getEngine().running).toBe(true)
    expect(simulationStore.getEngine().accountId).toBe('12345')
    expect(simulationStore.getEngine().universe).toEqual(['AAPL', 'MSFT'])

    simulationStore.setStopped()
    expect(simulationStore.getEngine().running).toBe(false)
  })

  it('最近信号和订单最多保留 500 条', () => {
    simulationStore.resetForTests()
    for (let index = 0; index < 505; index += 1) {
      simulationStore.addSignal(signal(index))
      simulationStore.addOrder(order(index))
    }

    expect(simulationStore.latestSignals()).toHaveLength(500)
    expect(simulationStore.latestOrders()).toHaveLength(500)
    expect(simulationStore.latestSignals()[0].ticker).toBe('T504')
    expect(simulationStore.latestSignals()[0].modelLabel).toBe('GLM5.2')
  })

  it('成功订单进入 15 分钟去重窗口', () => {
    simulationStore.resetForTests()
    expect(simulationStore.canSubmit('AAPL', 'BUY', 'LLM_AUTONOMOUS_STOCK_TRADER')).toBe(true)
    simulationStore.addOrder({ ...order(1), ticker: 'AAPL', side: 'BUY', ok: true })
    expect(simulationStore.canSubmit('AAPL', 'BUY', 'LLM_AUTONOMOUS_STOCK_TRADER')).toBe(false)
  })
})

function signal(index: number): QuantSignal {
  return {
    id: `signal-${index}`,
    ticker: `T${index}`,
    strategy: 'LLM_AUTONOMOUS_STOCK_TRADER',
    model: 'glm-5.2',
    modelLabel: 'GLM5.2',
    side: 'HOLD',
    confidence: 'low',
    reason: 'test',
    price: '$100.00',
    quantity: '0',
    limitPrice: '$100.00',
    riskAssessment: 'test risk',
    generatedAt: '2026-06-16T10:00:00',
    dataWindow: '30 x 1m bars',
    source: 'futu-callback',
  }
}

function order(index: number): SimulatedOrderResult {
  return {
    ok: true,
    orderId: `order-${index}`,
    ticker: `T${index}`,
    side: 'BUY',
    quantity: '1',
    orderType: 'LIMIT',
    limitPrice: '$100.00',
    submittedAt: '2026-06-16T10:00:00',
    strategy: 'LLM_AUTONOMOUS_STOCK_TRADER',
    signalId: `signal-${index}`,
  }
}
