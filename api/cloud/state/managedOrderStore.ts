import type { PoolClient, QueryResultRow } from 'pg'
import type {
  ManagedBroker,
  ManagedOrder,
  ManagedOrderEvent,
} from '../../../shared/managedOrderTypes.js'
import { getPool, isPgEnabled, query, queryOne } from '../db/pgClient.js'

type ManagedOrderRow = QueryResultRow & {
  payload: ManagedOrder
  version: number
}

type ManagedOrderEventRow = QueryResultRow & {
  id: string
  request_id: string | null
  platform: ManagedBroker
  order_id: string
  event_type: string
  source: ManagedOrderEvent['source']
  detail: Record<string, unknown>
  created_at: Date
}

const TERMINAL_STATUSES = new Set([
  'FILLED',
  'CANCELED',
  'PARTIALLY_CANCELED',
  'REJECTED',
  'EXPIRED',
])
const memoryOrders = new Map<string, ManagedOrder>()
const memoryEvents: ManagedOrderEvent[] = []

export async function registerManagedOrder(order: ManagedOrder): Promise<ManagedOrder> {
  if (!shouldUseManagedOrderPostgres()) {
    const key = orderKey(order.platform, order.orderId)
    const created = !memoryOrders.has(key)
    if (created) {
      memoryOrders.set(key, order)
      await appendManagedOrderEvent({
        platform: order.platform,
        orderId: order.orderId,
        eventType: 'registered',
        source: 'system',
        detail: { pendingOrderId: order.pendingOrderId, signalId: order.signalId },
        createdAt: order.createdAt,
      })
    }
    return memoryOrders.get(key) ?? order
  }
  const inserted = await query<{ order_id: string }>(
    `INSERT INTO managed_live_orders (
       platform, order_id, pending_order_id, signal_id, ticker, side, order_type,
       order_session, strategy, status, broker_status, submitted_quantity,
       executed_quantity, remaining_quantity, submitted_price, executed_price,
       submitted_at, broker_updated_at, last_checked_at, terminal_at,
       ownership_verified, cancel_request_id, version, payload, created_at, updated_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
       $17,$18,$19,$20,$21,$22,$23,$24::jsonb,$25,$26
     )
     ON CONFLICT (platform, order_id) DO NOTHING
     RETURNING order_id`,
    orderParams(order),
  )
  if (inserted.length) {
    await appendManagedOrderEvent({
      platform: order.platform,
      orderId: order.orderId,
      eventType: 'registered',
      source: 'system',
      detail: { pendingOrderId: order.pendingOrderId, signalId: order.signalId },
      createdAt: order.createdAt,
    })
  }
  return (await getManagedOrder(order.platform, order.orderId)) ?? order
}

export async function getManagedOrder(
  platform: ManagedBroker,
  orderId: string,
): Promise<ManagedOrder | undefined> {
  if (!shouldUseManagedOrderPostgres()) return memoryOrders.get(orderKey(platform, orderId))
  const row = await queryOne<ManagedOrderRow>(
    `SELECT payload, version FROM managed_live_orders WHERE platform = $1 AND order_id = $2`,
    [platform, orderId],
  )
  return row ? { ...row.payload, version: row.version } : undefined
}

export async function listManagedOrders(
  platform?: ManagedBroker,
  activeOnly = false,
): Promise<ManagedOrder[]> {
  if (!shouldUseManagedOrderPostgres()) {
    return [...memoryOrders.values()]
      .filter((order) => (!platform || order.platform === platform) && (!activeOnly || !isManagedOrderTerminal(order.status)))
      .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
  }
  const rows = await query<ManagedOrderRow>(
    `SELECT payload, version
       FROM managed_live_orders
      WHERE ($1::text IS NULL OR platform = $1)
        AND ($2::boolean = false OR terminal_at IS NULL)
      ORDER BY submitted_at DESC`,
    [platform ?? null, activeOnly],
  )
  return rows.map((row) => ({ ...row.payload, version: row.version }))
}

export async function updateManagedOrder(
  order: ManagedOrder,
  expectedVersion = order.version,
): Promise<ManagedOrder | undefined> {
  const next = { ...order, version: expectedVersion + 1, updatedAt: new Date().toISOString() }
  if (!shouldUseManagedOrderPostgres()) {
    const key = orderKey(order.platform, order.orderId)
    const current = memoryOrders.get(key)
    if (!current || current.version !== expectedVersion) return undefined
    memoryOrders.set(key, next)
    return next
  }
  const rows = await query<ManagedOrderRow>(
    `UPDATE managed_live_orders SET
       pending_order_id=$3, signal_id=$4, ticker=$5, side=$6, order_type=$7,
       order_session=$8, strategy=$9, status=$10, broker_status=$11,
       submitted_quantity=$12, executed_quantity=$13, remaining_quantity=$14,
       submitted_price=$15, executed_price=$16, submitted_at=$17,
       broker_updated_at=$18, last_checked_at=$19, terminal_at=$20,
       ownership_verified=$21, cancel_request_id=$22, version=version+1,
       payload=$24::jsonb, updated_at=$25
     WHERE platform=$1 AND order_id=$2 AND version=$23
     RETURNING payload, version`,
    updateOrderParams(next, expectedVersion),
  )
  const row = rows[0]
  return row ? { ...row.payload, version: row.version } : undefined
}

export async function appendManagedOrderEvent(event: ManagedOrderEvent): Promise<void> {
  if (!shouldUseManagedOrderPostgres()) {
    if (event.requestId && memoryEvents.some((item) => item.requestId === event.requestId)) return
    memoryEvents.unshift({ ...event, id: String(memoryEvents.length + 1) })
    return
  }
  await query(
    `INSERT INTO managed_order_events (
       request_id, platform, order_id, event_type, source, detail, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
     ON CONFLICT (request_id) DO NOTHING`,
    [
      event.requestId ?? null,
      event.platform,
      event.orderId,
      event.eventType,
      event.source,
      JSON.stringify(event.detail),
      event.createdAt,
    ],
  )
}

export async function listManagedOrderEvents(
  platform?: ManagedBroker,
  orderId?: string,
  limit = 200,
): Promise<ManagedOrderEvent[]> {
  if (!shouldUseManagedOrderPostgres()) {
    return memoryEvents
      .filter((event) => (!platform || event.platform === platform) && (!orderId || event.orderId === orderId))
      .slice(0, Math.max(1, Math.min(500, limit)))
  }
  const rows = await query<ManagedOrderEventRow>(
    `SELECT id, request_id, platform, order_id, event_type, source, detail, created_at
       FROM managed_order_events
      WHERE ($1::text IS NULL OR platform = $1)
        AND ($2::text IS NULL OR order_id = $2)
      ORDER BY created_at DESC, id DESC
      LIMIT $3`,
    [platform ?? null, orderId ?? null, Math.max(1, Math.min(500, limit))],
  )
  return rows.map((row) => ({
    id: String(row.id),
    requestId: row.request_id ?? undefined,
    platform: row.platform,
    orderId: row.order_id,
    eventType: row.event_type,
    source: row.source,
    detail: row.detail ?? {},
    createdAt: row.created_at.toISOString(),
  }))
}

export async function beginManagedOrderCancel(input: {
  platform: ManagedBroker
  orderId: string
  requestId: string
  source: ManagedOrderEvent['source']
  reason: string
}): Promise<{ ok: boolean; order?: ManagedOrder; alreadyHandled?: boolean; error?: string }> {
  if (!shouldUseManagedOrderPostgres()) return beginMemoryCancel(input)
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const row = (
      await client.query<ManagedOrderRow>(
        `SELECT payload, version FROM managed_live_orders
         WHERE platform=$1 AND order_id=$2 FOR UPDATE`,
        [input.platform, input.orderId],
      )
    ).rows[0]
    if (!row) {
      await client.query('ROLLBACK')
      return { ok: false, error: '该订单不属于本系统托管订单。' }
    }
    const current = { ...row.payload, version: row.version }
    if (!current.ownershipVerified) {
      await client.query('ROLLBACK')
      return { ok: false, order: current, error: '订单所有权校验失败，禁止撤单。' }
    }
    if (TERMINAL_STATUSES.has(current.status)) {
      await client.query('ROLLBACK')
      return { ok: false, order: current, error: '订单已经进入终态，无需撤单。' }
    }
    if (current.cancelRequestId) {
      await client.query('ROLLBACK')
      return {
        ok: current.cancelRequestId === input.requestId,
        order: current,
        alreadyHandled: true,
        error: current.cancelRequestId === input.requestId ? undefined : '订单已有撤单请求处理中。',
      }
    }
    const now = new Date().toISOString()
    const next: ManagedOrder = {
      ...current,
      status: 'CANCEL_REQUESTED',
      cancelRequestId: input.requestId,
      latestDecision: {
        action: 'CANCEL',
        confidence: input.source === 'model' ? 'high' : 'high',
        source: input.source === 'reconcile' || input.source === 'system' ? 'hard_rule' : input.source,
        reason: input.reason,
        riskAssessment: '撤单只影响尚未成交的剩余数量。',
        decidedAt: now,
      },
      version: current.version + 1,
      updatedAt: now,
    }
    await updateLockedOrder(client, next)
    await client.query(
      `INSERT INTO managed_order_events (
         request_id, platform, order_id, event_type, source, detail, created_at
       ) VALUES ($1,$2,$3,'cancel_requested',$4,$5::jsonb,$6)
       ON CONFLICT (request_id) DO NOTHING`,
      [input.requestId, input.platform, input.orderId, input.source, JSON.stringify({ reason: input.reason }), now],
    )
    await client.query('COMMIT')
    return { ok: true, order: next }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

function beginMemoryCancel(input: {
  platform: ManagedBroker
  orderId: string
  requestId: string
  source: ManagedOrderEvent['source']
  reason: string
}): { ok: boolean; order?: ManagedOrder; alreadyHandled?: boolean; error?: string } {
  const key = orderKey(input.platform, input.orderId)
  const current = memoryOrders.get(key)
  if (!current) return { ok: false, error: '该订单不属于本系统托管订单。' }
  if (!current.ownershipVerified) return { ok: false, order: current, error: '订单所有权校验失败，禁止撤单。' }
  if (TERMINAL_STATUSES.has(current.status)) return { ok: false, order: current, error: '订单已经进入终态，无需撤单。' }
  if (current.cancelRequestId) {
    return {
      ok: current.cancelRequestId === input.requestId,
      order: current,
      alreadyHandled: true,
      error: current.cancelRequestId === input.requestId ? undefined : '订单已有撤单请求处理中。',
    }
  }
  const now = new Date().toISOString()
  const next: ManagedOrder = {
    ...current,
    status: 'CANCEL_REQUESTED',
    cancelRequestId: input.requestId,
    latestDecision: {
      action: 'CANCEL',
      confidence: 'high',
      source: input.source === 'reconcile' || input.source === 'system' ? 'hard_rule' : input.source,
      reason: input.reason,
      riskAssessment: '撤单只影响尚未成交的剩余数量。',
      decidedAt: now,
    },
    version: current.version + 1,
    updatedAt: now,
  }
  memoryOrders.set(key, next)
  memoryEvents.unshift({
    id: String(memoryEvents.length + 1),
    requestId: input.requestId,
    platform: input.platform,
    orderId: input.orderId,
    eventType: 'cancel_requested',
    source: input.source,
    detail: { reason: input.reason },
    createdAt: now,
  })
  return { ok: true, order: next }
}

export function isManagedOrderTerminal(status: ManagedOrder['status']): boolean {
  return TERMINAL_STATUSES.has(status)
}

export function resetManagedOrderStoreForTests(): void {
  memoryOrders.clear()
  memoryEvents.splice(0)
}

async function updateLockedOrder(client: PoolClient, order: ManagedOrder): Promise<void> {
  await client.query(
    `UPDATE managed_live_orders SET
       status=$3, broker_status=$4, submitted_quantity=$5,
       executed_quantity=$6, remaining_quantity=$7, submitted_price=$8,
       executed_price=$9, broker_updated_at=$10, last_checked_at=$11,
       terminal_at=$12, ownership_verified=$13, cancel_request_id=$14,
       version=$15, payload=$16::jsonb, updated_at=$17
     WHERE platform=$1 AND order_id=$2`,
    lockedUpdateOrderParams(order),
  )
}

function updateOrderParams(order: ManagedOrder, expectedVersion: number): unknown[] {
  return [
    order.platform,
    order.orderId,
    order.pendingOrderId,
    order.signalId,
    order.ticker,
    order.side,
    order.orderType,
    order.orderSession ?? null,
    order.strategy,
    order.status,
    order.brokerStatus,
    order.submittedQuantity,
    order.executedQuantity,
    order.remainingQuantity,
    order.submittedPrice,
    order.executedPrice,
    order.submittedAt,
    order.brokerUpdatedAt ?? null,
    order.lastCheckedAt ?? null,
    order.terminalAt ?? null,
    order.ownershipVerified,
    order.cancelRequestId ?? null,
    expectedVersion,
    JSON.stringify(order),
    order.updatedAt,
  ]
}

function lockedUpdateOrderParams(order: ManagedOrder): unknown[] {
  return [
    order.platform,
    order.orderId,
    order.status,
    order.brokerStatus,
    order.submittedQuantity,
    order.executedQuantity,
    order.remainingQuantity,
    order.submittedPrice,
    order.executedPrice,
    order.brokerUpdatedAt ?? null,
    order.lastCheckedAt ?? null,
    order.terminalAt ?? null,
    order.ownershipVerified,
    order.cancelRequestId ?? null,
    order.version,
    JSON.stringify(order),
    order.updatedAt,
  ]
}

function orderParams(order: ManagedOrder): unknown[] {
  return [
    order.platform,
    order.orderId,
    order.pendingOrderId,
    order.signalId,
    order.ticker,
    order.side,
    order.orderType,
    order.orderSession ?? null,
    order.strategy,
    order.status,
    order.brokerStatus,
    order.submittedQuantity,
    order.executedQuantity,
    order.remainingQuantity,
    order.submittedPrice,
    order.executedPrice,
    order.submittedAt,
    order.brokerUpdatedAt ?? null,
    order.lastCheckedAt ?? null,
    order.terminalAt ?? null,
    order.ownershipVerified,
    order.cancelRequestId ?? null,
    order.version,
    JSON.stringify(order),
    order.createdAt,
    order.updatedAt,
  ]
}

function orderKey(platform: ManagedBroker, orderId: string): string {
  return `${platform}:${orderId}`
}

function shouldUseManagedOrderPostgres(): boolean {
  return isPgEnabled() && (process.env.NODE_ENV !== 'test' || process.env.MANAGED_ORDER_PG_TEST === '1')
}
