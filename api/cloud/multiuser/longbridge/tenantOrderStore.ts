import type { LivePendingOrder } from '../../../../shared/types.js'
import { query, queryOne } from '../../db/pgClient.js'

export async function getTenantPendingOrder(
  userId: string,
  bindingId: string,
  orderId: string,
): Promise<LivePendingOrder | null> {
  const row = await queryOne<{ payload: LivePendingOrder }>(
    `SELECT payload
     FROM multiuser.longbridge_events
     WHERE user_id = $1 AND binding_id = $2 AND kind = 'pending-orders'
       AND payload->>'id' = $3
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [userId, bindingId, orderId],
  )
  return row?.payload ?? null
}

export async function listActiveTenantPendingOrders(
  userId: string,
  bindingId: string,
): Promise<LivePendingOrder[]> {
  const rows = await query<{ payload: LivePendingOrder }>(
    `SELECT DISTINCT ON (payload->>'id') payload
     FROM multiuser.longbridge_events
     WHERE user_id = $1 AND binding_id = $2 AND kind = 'pending-orders'
     ORDER BY payload->>'id', created_at DESC, id DESC`,
    [userId, bindingId],
  )
  return rows
    .map((row) => row.payload)
    .filter((order) =>
      order.status === 'PENDING_CONFIRMATION' || order.status === 'CONFIRMED_SUBMITTING')
}

export async function appendTenantPendingOrder(
  userId: string,
  bindingId: string,
  order: LivePendingOrder,
): Promise<void> {
  await query(
    `INSERT INTO multiuser.longbridge_events
       (user_id, binding_id, kind, status, payload)
     VALUES ($1, $2, 'pending-orders', $3, $4::jsonb)`,
    [userId, bindingId, order.status, JSON.stringify(order)],
  )
}

export async function rejectTenantPendingOrder(
  userId: string,
  bindingId: string,
  orderId: string,
): Promise<LivePendingOrder | null> {
  const order = await getTenantPendingOrder(userId, bindingId, orderId)
  if (!order || order.status !== 'PENDING_CONFIRMATION') return null
  const next: LivePendingOrder = {
    ...order,
    status: 'REJECTED_BY_USER',
    updatedAt: new Date().toISOString(),
    riskWarnings: ['该订单已由当前用户拒绝，不会提交真实订单。', ...order.riskWarnings],
  }
  await appendTenantPendingOrder(userId, bindingId, next)
  return next
}

export async function expireTenantPendingOrders(
  userId: string,
  bindingId: string,
  input: { ids?: string[]; ticker?: string; side?: string },
): Promise<LivePendingOrder[]> {
  const ids = new Set((input.ids ?? []).map((item) => item.trim()).filter(Boolean))
  const ticker = input.ticker?.trim().toUpperCase()
  const side = input.side?.trim().toUpperCase()
  const orders = (await listActiveTenantPendingOrders(userId, bindingId)).filter((order) => {
    if (order.status !== 'PENDING_CONFIRMATION') return false
    if (ids.size && !ids.has(order.id)) return false
    if (ticker && ticker !== 'ALL' && order.intent.ticker.toUpperCase() !== ticker) return false
    if (side && side !== 'ALL' && order.intent.side !== side) return false
    return true
  })
  const expired: LivePendingOrder[] = []
  for (const order of orders) {
    const next: LivePendingOrder = {
      ...order,
      status: 'REJECTED_BY_USER',
      updatedAt: new Date().toISOString(),
      riskWarnings: ['该订单已批量过期，不会提交真实订单。', ...order.riskWarnings],
    }
    await appendTenantPendingOrder(userId, bindingId, next)
    expired.push(next)
  }
  return expired
}
