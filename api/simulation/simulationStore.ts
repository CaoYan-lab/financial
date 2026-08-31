import type {
  QuantSignal,
  QuantStrategyName,
  SimulatedOrderResult,
  SimulationEngineStatus,
  SimulationSkippedTicker,
} from '../../shared/types.js'
import { simulationPersistence } from './simulationPersistence.js'

const MAX_ITEMS = 500
const ORDER_COOLDOWN_MS = 15 * 60 * 1000
const STRATEGY: QuantStrategyName = 'LLM_AUTONOMOUS_STOCK_TRADER'

class SimulationStore {
  private engine: SimulationEngineStatus = emptyEngineStatus()
  private readonly signals: QuantSignal[] = simulationPersistence.readLatest('signals', MAX_ITEMS)
  private readonly orders: SimulatedOrderResult[] = simulationPersistence.readLatest('orders', MAX_ITEMS)
  private readonly skipped = new Map<string, SimulationSkippedTicker>()
  private readonly lastOrderAt = new Map<string, number>()

  constructor() {
    for (const skipped of simulationPersistence.readLatest('skipped', MAX_ITEMS)) {
      if (!this.skipped.has(skipped.ticker.toUpperCase())) this.skipped.set(skipped.ticker.toUpperCase(), skipped)
    }
    for (const order of this.orders) {
      if (order.ok) this.lastOrderAt.set(orderKey(order.ticker, order.side, order.strategy), Date.parse(order.submittedAt) || Date.now())
    }
    this.engine = {
      ...this.engine,
      signalCount: this.signals.length,
      submittedOrderCount: this.orders.filter((order) => order.ok).length,
    }
  }

  getEngine(): SimulationEngineStatus {
    return { ...this.engine, universe: [...this.engine.universe] }
  }

  setRunning(accountId: string, universe: string[], runIntervalMs: number) {
    const now = new Date()
    this.engine = {
      ...this.engine,
      running: true,
      accountId,
      startedAt: now.toISOString(),
      nextRunAt: new Date(now.getTime() + runIntervalMs).toISOString(),
      universe,
      runIntervalMs,
      lastError: '',
    }
  }

  setDataWindow(dataWindow: SimulationEngineStatus['dataWindow']) {
    this.engine = {
      ...this.engine,
      dataWindow,
      runIntervalMs: dataWindow ? dataWindow.pollIntervalSeconds * 1000 : this.engine.runIntervalMs,
    }
  }

  setStopped() {
    this.engine = {
      ...this.engine,
      running: false,
      nextRunAt: '',
    }
  }

  markRun(runIntervalMs: number) {
    const now = new Date()
    this.engine = {
      ...this.engine,
      lastRunAt: now.toISOString(),
      nextRunAt: this.engine.running ? new Date(now.getTime() + runIntervalMs).toISOString() : '',
    }
  }

  setError(error: string) {
    this.engine = {
      ...this.engine,
      lastError: error,
    }
  }

  addSignal(signal: QuantSignal) {
    this.signals.unshift(signal)
    this.signals.splice(MAX_ITEMS)
    simulationPersistence.appendSignal(signal)
    this.engine = {
      ...this.engine,
      signalCount: this.engine.signalCount + 1,
    }
  }

  addOrder(order: SimulatedOrderResult) {
    this.orders.unshift(order)
    this.orders.splice(MAX_ITEMS)
    simulationPersistence.appendOrder(order)
    if (order.ok) {
      this.lastOrderAt.set(orderKey(order.ticker, order.side, order.strategy), Date.now())
      this.engine = {
        ...this.engine,
        submittedOrderCount: this.engine.submittedOrderCount + 1,
      }
    }
  }

  recordSkipped(ticker: string, reason: string) {
    const skipped = {
      ticker: ticker.toUpperCase(),
      reason,
      updatedAt: new Date().toISOString(),
    }
    this.skipped.set(ticker.toUpperCase(), skipped)
    simulationPersistence.appendSkipped(skipped)
  }

  clearSkipped() {
    this.skipped.clear()
  }

  canSubmit(ticker: string, side: string, strategy: QuantStrategyName): boolean {
    const submittedAt = this.lastOrderAt.get(orderKey(ticker, side, strategy))
    return !submittedAt || Date.now() - submittedAt > ORDER_COOLDOWN_MS
  }

  latestSignals(): QuantSignal[] {
    return [...this.signals]
  }

  latestOrders(): SimulatedOrderResult[] {
    return [...this.orders]
  }

  skippedTickers(): SimulationSkippedTicker[] {
    return [...this.skipped.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_ITEMS)
  }

  resetForTests() {
    this.engine = emptyEngineStatus()
    this.signals.splice(0)
    this.orders.splice(0)
    this.skipped.clear()
    this.lastOrderAt.clear()
    simulationPersistence.clearForTests()
  }
}

export const simulationStore = new SimulationStore()

export function emptyEngineStatus(): SimulationEngineStatus {
  return {
    running: false,
    mode: 'SIMULATE',
    accountId: '',
    startedAt: '',
    lastRunAt: '',
    nextRunAt: '',
    universe: [],
    strategy: STRATEGY,
    runIntervalMs: 60_000,
    submittedOrderCount: 0,
    signalCount: 0,
    lastError: '',
    dataWindow: undefined,
  }
}

function orderKey(ticker: string, side: string, strategy: QuantStrategyName): string {
  return `${ticker.toUpperCase()}:${side}:${strategy}`
}
