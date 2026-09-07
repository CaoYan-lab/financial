import { randomUUID } from 'node:crypto'
import type { LiveOrderResult, LlmTradingDecision } from '../../shared/types.js'
import type {
  ManagedBroker,
  ManagedOrder,
  ManagedOrderDecision,
  ManagedOrderSupervisorSnapshot,
} from '../../shared/managedOrderTypes.js'
import {
  appendManagedOrderEvent,
  beginManagedOrderCancel,
  getManagedOrder,
  isManagedOrderTerminal,
  listManagedOrders,
  registerManagedOrder,
  updateManagedOrder,
} from '../cloud/state/managedOrderStore.js'
import { loadLongbridgeLiveAccountDashboard } from '../longbridge/longbridgeAdapter.js'
import { loadLongbridgeRealtimeStrategyMarketData } from '../longbridge/longbridgeRealtimeDataAdapter.js'
import { normalizeLongbridgeSymbol } from '../longbridge/longbridgeMarketDataService.js'
import { logger } from '../utils/logger.js'
import { loadLiveAccountDashboard } from './liveAccountService.js'
import { managedOrderBrokerAdapter } from './managedOrderBrokerAdapter.js'
import {
  requestManagedOrderDecisions,
  type ManagedOrderDecisionContext,
} from './managedOrderDecisionService.js'
import { hardRuleCancelDecision } from './managedOrderPolicy.js'
import {
  getFutuLiveSettings,
  hydrateFutuLiveSettings,
} from './liveSettings.js'
import {
  getLongbridgeLiveSettings,
  hydrateLongbridgeLiveSettings,
} from '../longbridge/longbridgeLiveSettings.js'
import { loadStrategyMarketData } from '../simulation/realtimeDataAdapter.js'
import { livePersistence } from './livePersistence.js'
import { longbridgePersistence } from '../longbridge/longbridgePersistence.js'

const LOOP_INTERVAL_MS = 5_000
const CANCEL_FLOW_STATUSES = new Set<ManagedOrder['status']>([
  'CANCEL_REQUESTED',
  'CANCEL_PENDING',
  'UNKNOWN',
])
const SUPERVISOR_OWNED_STATUSES = new Set<ManagedOrder['status']>([
  'CANCEL_RECOMMENDED',
  ...CANCEL_FLOW_STATUSES,
])
const DEFAULT_DATA_WINDOW = {
  kline1mBars: 30,
  tickerPoints: 60,
  orderBookDepth: 5,
  pollIntervalSeconds: 60,
  source: 'fallback' as const,
  reason: '挂单监管上下文',
}

class ManagedOrderSupervisor {
  private timer?: NodeJS.Timeout
  private running = false
  private inFlight = false
  private lastSyncByPlatform = new Map<ManagedBroker, number>()
  private lastModelReviewByPlatform = new Map<ManagedBroker, number>()
  private state: ManagedOrderSupervisorSnapshot = emptySnapshot()

  async start() {
    if (this.running) return
    await Promise.all([
      hydrateFutuLiveSettings(),
      hydrateLongbridgeLiveSettings(),
    ])
    await this.backfillSubmittedOrders()
    this.running = true
    this.state = { ...this.state, running: true, lastError: '' }
    void this.tick()
  }

  stop() {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.state = { ...this.state, running: false }
  }

  snapshot(): ManagedOrderSupervisorSnapshot {
    return { ...this.state }
  }

  private async backfillSubmittedOrders() {
    const cutoff = Date.now() - 48 * 60 * 60 * 1000
    const isRecent = (result: LiveOrderResult) => (Date.parse(result.submittedAt) || 0) >= cutoff
    const futu = livePersistence.readLatest('submitted_orders', 100).filter(isRecent)
    const longbridge = longbridgePersistence.latestSubmittedOrders().slice(0, 100).filter(isRecent)
    for (const result of futu) await registerSubmittedManagedOrder('futu', result, result.llmDecision)
    for (const result of longbridge) await registerSubmittedManagedOrder('longbridge', result, result.llmDecision)
  }

  private async tick() {
    if (!this.running) return
    if (!this.inFlight) {
      this.inFlight = true
      try {
        for (const platform of ['futu', 'longbridge'] as const) {
          await this.tickPlatform(platform)
        }
        await this.refreshCounts()
        this.state = { ...this.state, lastError: '' }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.state = { ...this.state, lastError: message }
        logger.error({ event: 'managed_order.supervisor.failed', error: message }, '挂单监管循环失败')
      } finally {
        this.inFlight = false
      }
    }
    this.timer = setTimeout(() => void this.tick(), LOOP_INTERVAL_MS)
  }

  private async tickPlatform(platform: ManagedBroker) {
    const now = Date.now()
    const settings = platform === 'futu' ? getFutuLiveSettings() : getLongbridgeLiveSettings()
    const lastSync = this.lastSyncByPlatform.get(platform) ?? 0
    if (now - lastSync >= settings.brokerSyncIntervalSeconds * 1000) {
      await this.syncPlatform(platform)
      this.lastSyncByPlatform.set(platform, now)
      this.state = { ...this.state, lastSyncAt: new Date().toISOString() }
    }
    const lastReview = this.lastModelReviewByPlatform.get(platform) ?? 0
    if (now - lastReview >= settings.modelReviewIntervalSeconds * 1000) {
      await this.reviewPlatform(platform)
      this.lastModelReviewByPlatform.set(platform, now)
      this.state = { ...this.state, lastModelReviewAt: new Date().toISOString() }
    }
  }

  private async syncPlatform(platform: ManagedBroker) {
    const orders = await listManagedOrders(platform, true)
    if (!orders.length) return
    const settings = platform === 'futu' ? getFutuLiveSettings() : getLongbridgeLiveSettings()
    const accountId = await resolveAccountId(platform)
    const adapter = managedOrderBrokerAdapter(platform)
    for (const order of orders) {
      const snapshot = await adapter.getOrderSnapshot({ order, accountId })
      if (!snapshot.ok) {
        await appendManagedOrderEvent({
          platform,
          orderId: order.orderId,
          eventType: 'sync_failed',
          source: 'reconcile',
          detail: { error: snapshot.error },
          createdAt: new Date().toISOString(),
        })
        continue
      }
      const preserveSupervisorState =
        !isManagedOrderTerminal(snapshot.status)
        && SUPERVISOR_OWNED_STATUSES.has(order.status)
      const preserveCancelState =
        preserveSupervisorState
        && Boolean(order.cancelRequestId)
        && CANCEL_FLOW_STATUSES.has(order.status)
      const reconciledStatus = preserveSupervisorState ? order.status : snapshot.status
      const changed =
        order.status !== reconciledStatus
        || order.executedQuantity !== snapshot.executedQuantity
        || order.remainingQuantity !== snapshot.remainingQuantity
      const next = await saveOrderPatch(order, {
        brokerStatus: snapshot.brokerStatus,
        status: reconciledStatus,
        canCancel: preserveCancelState ? false : snapshot.canCancel,
        submittedQuantity: snapshot.submittedQuantity,
        executedQuantity: snapshot.executedQuantity,
        remainingQuantity: snapshot.remainingQuantity,
        submittedPrice: snapshot.submittedPrice,
        executedPrice: snapshot.executedPrice,
        brokerUpdatedAt: snapshot.brokerUpdatedAt,
        lastCheckedAt: new Date().toISOString(),
        terminalAt: isManagedOrderTerminal(snapshot.status) ? new Date().toISOString() : undefined,
        rawBrokerSnapshot: snapshot.rawResponse,
      }, { preserveSupervisorState: true })
      if (!next) continue
      if (changed) {
        await appendManagedOrderEvent({
          platform,
          orderId: order.orderId,
          eventType: 'reconciled',
          source: 'reconcile',
          detail: {
            brokerStatus: snapshot.brokerStatus,
            status: snapshot.status,
            executedQuantity: snapshot.executedQuantity,
            remainingQuantity: snapshot.remainingQuantity,
          },
          createdAt: new Date().toISOString(),
        })
      }
      const decision = hardRuleCancelDecision(next, settings)
      if (!decision) continue
      await recordDecision(next, decision)
      if (settings.autoCancelEnabled) {
        await requestManagedOrderCancel({
          platform,
          orderId: order.orderId,
          requestId: `auto-rule-${platform}-${order.orderId}-${Date.now()}`,
          source: 'hard_rule',
          reason: decision.reason,
        })
      }
    }
  }

  private async reviewPlatform(platform: ManagedBroker) {
    const orders = (await listManagedOrders(platform, true)).filter(
      (order) =>
        !isManagedOrderTerminal(order.status)
        && order.status !== 'CANCEL_REQUESTED'
        && order.status !== 'CANCEL_PENDING'
        && !(order.status === 'CANCEL_RECOMMENDED' && order.hardRuleReasons.length > 0),
    )
    if (!orders.length) return
    const settings = platform === 'futu' ? getFutuLiveSettings() : getLongbridgeLiveSettings()
    const contexts = await buildDecisionContexts(platform, orders)
    const decisions = await requestManagedOrderDecisions({ platform, orders: contexts })
    for (const order of orders) {
      const decision = decisions.get(`${platform}:${order.orderId}`)
      if (!decision) continue
      await recordDecision(order, decision)
      if (
        settings.autoCancelEnabled
        && decision.action === 'CANCEL'
        && decision.confidence === 'high'
      ) {
        await requestManagedOrderCancel({
          platform,
          orderId: order.orderId,
          requestId: `auto-model-${platform}-${order.orderId}-${Date.now()}`,
          source: 'model',
          reason: decision.reason,
        })
      }
    }
  }

  private async refreshCounts() {
    const orders = await listManagedOrders(undefined, true)
    this.state = {
      ...this.state,
      running: this.running,
      managedOrderCount: orders.length,
      cancellableOrderCount: orders.filter((order) => order.canCancel).length,
      partiallyFilledOrderCount: orders.filter((order) => order.status === 'PARTIALLY_FILLED').length,
      cancelPendingCount: orders.filter((order) => order.status === 'CANCEL_PENDING' || order.status === 'CANCEL_REQUESTED').length,
    }
  }
}

export async function registerSubmittedManagedOrder(
  platform: ManagedBroker,
  result: LiveOrderResult,
  decision?: LlmTradingDecision,
): Promise<ManagedOrder | undefined> {
  if (
    !result.ok
    || !result.orderId
    || result.orderId === 'unavailable'
    || result.orderId.startsWith('blocked-')
  ) return undefined
  const now = new Date().toISOString()
  const quantity = numeric(result.quantity)
  const price = numericOrNull(result.limitPrice)
  return registerManagedOrder({
    platform,
    orderId: result.orderId,
    pendingOrderId: result.pendingOrderId,
    signalId: result.signalId,
    ticker: result.ticker,
    side: result.side,
    orderType: result.orderType,
    orderSession: result.orderSession,
    strategy: result.strategy,
    tradeHorizon: decision?.tradeHorizon,
    submittedQuantity: quantity,
    executedQuantity: 0,
    remainingQuantity: quantity,
    submittedPrice: price,
    executedPrice: null,
    latestPrice: null,
    priceDriftPct: null,
    brokerStatus: 'SUBMITTED',
    status: 'TRACKING',
    canCancel: true,
    submittedAt: result.submittedAt,
    ownershipVerified: true,
    hardRuleReasons: [],
    rawBrokerSnapshot: result.rawResponse,
    version: 1,
    createdAt: now,
    updatedAt: now,
  })
}

export async function requestManagedOrderCancel(input: {
  platform: ManagedBroker
  orderId: string
  requestId?: string
  source: 'hard_rule' | 'model' | 'manual'
  reason: string
}): Promise<{ ok: boolean; order?: ManagedOrder; error?: string; alreadyHandled?: boolean }> {
  const requestId = input.requestId || randomUUID()
  const begun = await beginManagedOrderCancel({ ...input, requestId })
  if (!begun.ok || begun.alreadyHandled) return begun
  const order = begun.order!
  const accountId = await resolveAccountId(order.platform)
  const adapter = managedOrderBrokerAdapter(order.platform)
  const before = await adapter.getOrderSnapshot({ order, accountId })
  if (!before.ok) {
    const failed = await saveOrderPatch(order, {
      status: 'UNKNOWN',
      canCancel: false,
      cancelError: before.error,
    })
    return { ok: false, order: failed, error: before.error }
  }
  if (isManagedOrderTerminal(before.status) || !before.canCancel) {
    const reconciled = await saveOrderPatch(order, {
      ...snapshotPatch(before),
      cancelRequestId: undefined,
      cancelError: before.canCancel ? undefined : '订单当前状态不可撤。',
    })
    return {
      ok: false,
      order: reconciled,
      error: isManagedOrderTerminal(before.status) ? '订单已进入终态，无需撤单。' : '订单当前状态不可撤。',
    }
  }
  const response = await adapter.cancelOrder({ order: { ...order, ...snapshotPatch(before) }, accountId })
  if (!response.ok || !response.accepted) {
    const failed = await saveOrderPatch(order, {
      status: before.status,
      canCancel: before.canCancel,
      cancelRequestId: undefined,
      cancelError: response.error ?? '券商未受理撤单。',
    })
    await appendManagedOrderEvent({
      requestId: `${requestId}:broker_rejected`,
      platform: order.platform,
      orderId: order.orderId,
      eventType: 'cancel_rejected',
      source: input.source,
      detail: { error: response.error, rawResponse: response.rawResponse },
      createdAt: new Date().toISOString(),
    })
    return { ok: false, order: failed, error: response.error ?? '券商未受理撤单。' }
  }
  let pending = await saveOrderPatch(order, {
    status: 'CANCEL_PENDING',
    canCancel: false,
    cancelError: undefined,
  })
  await appendManagedOrderEvent({
    requestId: `${requestId}:accepted`,
    platform: order.platform,
    orderId: order.orderId,
    eventType: 'cancel_accepted',
    source: input.source,
    detail: { rawResponse: response.rawResponse },
    createdAt: new Date().toISOString(),
  })
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await sleep(2_000)
    const snapshot = await adapter.getOrderSnapshot({ order: pending ?? order, accountId })
    if (!snapshot.ok) continue
    pending = await saveOrderPatch(pending ?? order, {
      ...snapshotPatch(snapshot),
      status: isManagedOrderTerminal(snapshot.status) ? snapshot.status : 'CANCEL_PENDING',
      canCancel: isManagedOrderTerminal(snapshot.status) ? snapshot.canCancel : false,
    })
    if (isManagedOrderTerminal(snapshot.status)) {
      await appendManagedOrderEvent({
        requestId: `${requestId}:terminal`,
        platform: order.platform,
        orderId: order.orderId,
        eventType: 'cancel_terminal',
        source: input.source,
        detail: {
          status: snapshot.status,
          executedQuantity: snapshot.executedQuantity,
          remainingQuantity: snapshot.remainingQuantity,
        },
        createdAt: new Date().toISOString(),
      })
      return { ok: snapshot.status === 'CANCELED' || snapshot.status === 'PARTIALLY_CANCELED', order: pending }
    }
  }
  const uncertain = await saveOrderPatch(pending ?? order, {
    status: 'UNKNOWN',
    canCancel: false,
    cancelError: '撤单请求已受理，但 20 秒内未确认终态。',
  })
  await appendManagedOrderEvent({
    requestId: `${requestId}:uncertain`,
    platform: order.platform,
    orderId: order.orderId,
    eventType: 'cancel_uncertain',
    source: input.source,
    detail: { error: uncertain?.cancelError },
    createdAt: new Date().toISOString(),
  })
  return { ok: false, order: uncertain, error: uncertain?.cancelError }
}

export const managedOrderSupervisor = new ManagedOrderSupervisor()

async function buildDecisionContexts(
  platform: ManagedBroker,
  orders: ManagedOrder[],
): Promise<ManagedOrderDecisionContext[]> {
  const account =
    platform === 'futu'
      ? await loadLiveAccountDashboard()
      : await loadLongbridgeLiveAccountDashboard()
  const contexts: ManagedOrderDecisionContext[] = []
  for (const order of orders) {
    let marketData: unknown
    try {
      marketData =
        platform === 'futu'
          ? loadStrategyMarketData(order.ticker, DEFAULT_DATA_WINDOW)
          : await loadLongbridgeRealtimeStrategyMarketData(
              normalizeLongbridgeSymbol(order.ticker),
              { klineCount: 30, includeDepth: true },
            )
    } catch (error) {
      marketData = { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
    contexts.push({
      order,
      account: {
        totalAssets: account.summary.totalAssets,
        buyingPower: account.summary.buyingPower,
        positions: account.positions.map((position) => ({
          ticker: position.ticker,
          quantity: position.quantity,
          marketValue: position.marketValue,
          unrealizedPnL: position.unrealizedPnL,
        })),
      },
      marketData,
    })
  }
  return contexts
}

async function resolveAccountId(platform: ManagedBroker): Promise<string | undefined> {
  if (platform !== 'futu') return undefined
  const account = await loadLiveAccountDashboard()
  return account.selectedAccountId === 'unavailable' ? undefined : account.selectedAccountId
}

async function recordDecision(order: ManagedOrder, decision: ManagedOrderDecision) {
  const current = (await getManagedOrder(order.platform, order.orderId)) ?? order
  if (
    isManagedOrderTerminal(current.status)
    || (Boolean(current.cancelRequestId) && CANCEL_FLOW_STATUSES.has(current.status))
  ) return
  const nextStatus =
    decision.action === 'CANCEL' && !isManagedOrderTerminal(current.status)
      ? 'CANCEL_RECOMMENDED'
      : current.status
  if (
    current.latestDecision?.action === decision.action
    && current.latestDecision.source === decision.source
    && current.latestDecision.reason === decision.reason
    && current.status === nextStatus
  ) return
  const saved = await saveOrderPatch(current, {
    status: nextStatus,
    latestDecision: decision,
    hardRuleReasons:
      decision.source === 'hard_rule'
        ? [...new Set([...current.hardRuleReasons, decision.reason])]
        : current.hardRuleReasons,
  }, { abortDuringCancelFlow: true })
  if (!saved) return
  await appendManagedOrderEvent({
    platform: current.platform,
    orderId: current.orderId,
    eventType: decision.source === 'model' ? 'model_decided' : 'rule_triggered',
    source: decision.source,
    detail: decision,
    createdAt: decision.decidedAt,
  })
}

async function saveOrderPatch(
  order: ManagedOrder,
  patch: Partial<ManagedOrder>,
  options: {
    preserveSupervisorState?: boolean
    abortDuringCancelFlow?: boolean
  } = {},
): Promise<ManagedOrder | undefined> {
  let current = (await getManagedOrder(order.platform, order.orderId)) ?? order
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (
      options.abortDuringCancelFlow === true
      && Boolean(current.cancelRequestId)
      && CANCEL_FLOW_STATUSES.has(current.status)
    ) return undefined
    const preserveSupervisorState =
      options.preserveSupervisorState === true
      && SUPERVISOR_OWNED_STATUSES.has(current.status)
      && (!patch.status || !isManagedOrderTerminal(patch.status))
    const effectivePatch = preserveSupervisorState
      ? {
          ...patch,
          status: current.status,
          canCancel:
            current.status === 'CANCEL_RECOMMENDED'
              ? patch.canCancel ?? current.canCancel
              : false,
          cancelRequestId: current.cancelRequestId,
          cancelError: current.cancelError,
          latestDecision: current.latestDecision,
        }
      : patch
    const next = { ...current, ...effectivePatch, version: current.version }
    const saved = await updateManagedOrder(next, current.version)
    if (saved) return saved
    const refreshed = await getManagedOrder(order.platform, order.orderId)
    if (!refreshed) return undefined
    current = refreshed
  }
  return undefined
}

function snapshotPatch(snapshot: {
  brokerStatus: string
  status: ManagedOrder['status']
  canCancel: boolean
  submittedQuantity: number
  executedQuantity: number
  remainingQuantity: number
  submittedPrice: number | null
  executedPrice: number | null
  brokerUpdatedAt?: string
  rawResponse?: unknown
}): Partial<ManagedOrder> {
  return {
    brokerStatus: snapshot.brokerStatus,
    status: snapshot.status,
    canCancel: snapshot.canCancel,
    submittedQuantity: snapshot.submittedQuantity,
    executedQuantity: snapshot.executedQuantity,
    remainingQuantity: snapshot.remainingQuantity,
    submittedPrice: snapshot.submittedPrice,
    executedPrice: snapshot.executedPrice,
    brokerUpdatedAt: snapshot.brokerUpdatedAt,
    lastCheckedAt: new Date().toISOString(),
    terminalAt: isManagedOrderTerminal(snapshot.status) ? new Date().toISOString() : undefined,
    rawBrokerSnapshot: snapshot.rawResponse,
  }
}

function emptySnapshot(): ManagedOrderSupervisorSnapshot {
  return {
    running: false,
    managedOrderCount: 0,
    cancellableOrderCount: 0,
    partiallyFilledOrderCount: 0,
    cancelPendingCount: 0,
    lastSyncAt: '',
    lastModelReviewAt: '',
    lastError: '',
  }
}

function numeric(value: string | number): number {
  return numericOrNull(value) ?? 0
}

function numericOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === 'MARKET') return null
  const parsed = Number(String(value).replace(/[^0-9.+-]/g, ''))
  return Number.isFinite(parsed) ? parsed : null
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
