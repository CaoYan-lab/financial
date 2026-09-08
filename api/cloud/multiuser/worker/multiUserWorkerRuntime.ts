import { query } from '../../db/pgClient.js'
import { logger } from '../../../utils/logger.js'
import { orderSubmissionSessionFailureReason } from '../../../simulation/usOvernightLlmGate.js'
import { normalizeLongbridgeSymbol } from '../../../longbridge/longbridgeMarketSessionService.js'
import {
  longbridgeOpeningLotSizeFailureReason,
} from '../../../longbridge/longbridgeLotSizeService.js'
import {
  getConnectionForVerification,
  getOwnedConnection,
  markConnectionInvalid,
  markConnectionVerified,
} from '../longbridge/connectionStore.js'
import {
  loadTenantLiveDashboard,
  runTenantOrderChild,
  setTenantDesiredState,
} from '../longbridge/tenantDataService.js'
import {
  appendTenantPendingOrder,
  getTenantPendingOrder,
} from '../longbridge/tenantOrderStore.js'
import {
  claimTenantJob,
  completeTenantJob,
  enqueueTenantJob,
  failTenantJob,
  type TenantJob,
} from '../longbridge/tenantJobStore.js'
import {
  loadTenantLotSize,
  loadTenantMarketStates,
} from '../longbridge/tenantMarketSessionService.js'
import { runTenantStrategyOnce, runTenantStrategyPoolOnce } from '../longbridge/tenantStrategyService.js'
import { multiUserEnabled } from '../auth/multiUserAuthService.js'

const POLL_MS = Number(process.env.MULTIUSER_WORKER_POLL_MS || 3_000)
const HEARTBEAT_MS = Number(process.env.MULTIUSER_HEARTBEAT_MS || 30_000)

type TenantAutoSubmitPendingOrder = {
  id: string
  status: string
  intent?: {
    ticker: string
    side: string
    quantity: number
    orderType: string
    orderSession?: string
    limitPrice: number
  }
}

let active = false
let workerId = ''
let jobTimer: NodeJS.Timeout | undefined
let heartbeatTimer: NodeJS.Timeout | undefined

async function handleTenantJob(job: TenantJob): Promise<Record<string, unknown>> {
  if (job.jobType === 'multiuser.longbridge.verify_connection') {
    const pending = await getConnectionForVerification(job.userId, job.bindingId)
    if (!pending) throw new Error('待验证的长桥绑定不存在')
    const result = await runTenantOrderChild(pending, 'orders', { page: 1, pageSize: 1 })
    if (result.ok !== true) {
      await markConnectionInvalid(pending.id)
      throw new Error(String(result.error ?? '长桥订单读取验证失败'))
    }
    await markConnectionVerified(job.userId, pending.id)
    return { ok: true, verified: true }
  }
  const connection = await getOwnedConnection(job.userId, job.bindingId)
  if (!connection) throw new Error('任务绑定不存在、已禁用或不属于当前用户')
  switch (job.jobType) {
    case 'multiuser.longbridge.start':
      await setTenantDesiredState(job.userId, job.bindingId, 'running')
      return { ok: true, desired: 'running' }
    case 'multiuser.longbridge.stop':
      await setTenantDesiredState(job.userId, job.bindingId, 'stopped')
      return { ok: true, desired: 'stopped' }
    case 'multiuser.longbridge.orders':
      return runTenantOrderChild(connection, 'orders', job.payload)
    case 'multiuser.longbridge.order_detail':
      return runTenantOrderChild(connection, 'detail', job.payload)
    case 'multiuser.longbridge.cancel_order': {
      const result = await runTenantOrderChild(connection, 'cancel', job.payload)
      const orderId = String(job.payload.orderId ?? '')
      await query(
        `INSERT INTO multiuser.longbridge_order_events
           (user_id, binding_id, order_id, event_type, request_id, detail)
         VALUES ($1, $2, $3, 'manual_cancel_requested', $4, $5::jsonb)
         ON CONFLICT (user_id, binding_id, request_id) DO NOTHING`,
        [job.userId, job.bindingId, orderId, `manual-cancel:${job.id}`, JSON.stringify(result)],
      )
      return result
    }
    case 'multiuser.longbridge.submit_order': {
      const state = await query<{
        mode: string
        live_trading_enabled: boolean
        shadow_verified_at: Date | null
      }>(
        `SELECT mode, live_trading_enabled, shadow_verified_at
         FROM multiuser.longbridge_engine_state
         WHERE user_id = $1 AND binding_id = $2`,
        [job.userId, job.bindingId],
      )
      const gate = state[0]
      if (!gate || gate.mode !== 'live' || !gate.live_trading_enabled || !gate.shadow_verified_at) {
        throw new Error('当前用户尚未完成影子验收，真实交易门禁关闭')
      }
      const pendingOrderId = String(job.payload.pendingOrderId ?? '')
      const pending = await getTenantPendingOrder(job.userId, job.bindingId, pendingOrderId)
      if (!pending || pending.status !== 'PENDING_CONFIRMATION') {
        throw new Error('未找到当前用户可提交的待确认订单')
      }
      const symbol = normalizeLongbridgeSymbol(typeof job.payload.symbol === 'string'
        ? job.payload.symbol
        : pending.intent.ticker)
      const lotSize = await loadTenantLotSize(connection, symbol)
      const lotSizeFailure = longbridgeOpeningLotSizeFailureReason({
        symbol,
        action: pending.intent.side,
        quantity: pending.intent.quantity,
        lotSize,
      })
      if (lotSizeFailure) {
        throw new Error(`当前用户长桥真实提交已拦截：${lotSizeFailure}`)
      }
      const marketState = (await loadTenantMarketStates(connection, [symbol])).get(symbol)
      const sessionFailure = orderSubmissionSessionFailureReason({
        ticker: pending.intent.ticker,
        marketState,
        orderSession: pending.intent.orderSession,
      })
      if (sessionFailure) {
        throw new Error(sessionFailure)
      }
      const submittingAt = new Date().toISOString()
      await appendTenantPendingOrder(job.userId, job.bindingId, {
        ...pending,
        status: 'CONFIRMED_SUBMITTING',
        updatedAt: submittingAt,
        confirmation: {
          confirmedAt: submittingAt,
          confirmationId: `tenant-confirm-${job.id}`,
          confirmedBy: 'user',
        },
      })
      const result = await runTenantOrderChild(connection, 'submit', job.payload)
      const submittedAt = new Date().toISOString()
      const finalOrder = {
        ...pending,
        status: result.ok === true ? ('SUBMITTED' as const) : ('SUBMIT_FAILED' as const),
        updatedAt: submittedAt,
        submittedOrder: {
          ok: result.ok === true,
          orderId: String(result.orderId ?? ''),
          ticker: pending.intent.ticker,
          side: pending.intent.side,
          quantity: String(pending.intent.quantity),
          orderType: pending.intent.orderType,
          orderSession: pending.intent.orderSession,
          limitPrice: String(pending.intent.limitPrice),
          submittedAt,
          strategy: pending.intent.strategy,
          signalId: pending.intent.signalId,
          pendingOrderId: pending.id,
          feeContext: pending.intent.feeContext,
          llmDecision: pending.llmDecision,
          rawResponse: result.rawResponse,
          error: result.ok === true ? undefined : String(result.error ?? '长桥报单失败'),
        },
      }
      await appendTenantPendingOrder(job.userId, job.bindingId, finalOrder)
      if (result.ok === true) {
        const managedOrder = {
          platform: 'longbridge',
          orderId: String(result.orderId),
          pendingOrderId: pending.id,
          signalId: pending.intent.signalId,
          ticker: pending.intent.ticker,
          side: pending.intent.side,
          orderType: pending.intent.orderType,
          orderSession: pending.intent.orderSession,
          strategy: pending.intent.strategy,
          tradeHorizon: pending.llmDecision.tradeHorizon,
          submittedQuantity: pending.intent.quantity,
          executedQuantity: 0,
          remainingQuantity: pending.intent.quantity,
          submittedPrice: pending.intent.limitPrice,
          executedPrice: null,
          latestPrice: null,
          priceDriftPct: null,
          brokerStatus: '已提交',
          status: 'TRACKING',
          canCancel: true,
          submittedAt,
          ownershipVerified: true,
          hardRuleReasons: [],
          rawBrokerSnapshot: result.rawResponse,
          version: 1,
          createdAt: submittedAt,
          updatedAt: submittedAt,
        }
        await query(
          `INSERT INTO multiuser.longbridge_managed_orders
             (user_id, binding_id, order_id, pending_order_id, ticker, side, status, payload)
           VALUES ($1, $2, $3, $4, $5, $6, 'SUBMITTED', $7::jsonb)
           ON CONFLICT (user_id, binding_id, order_id) DO UPDATE
             SET status = EXCLUDED.status, payload = EXCLUDED.payload, updated_at = now()`,
          [
            job.userId,
            job.bindingId,
            String(result.orderId),
            pending.id,
            pending.intent.ticker,
            pending.intent.side,
            JSON.stringify(managedOrder),
          ],
        )
        await query(
          `INSERT INTO multiuser.longbridge_order_events
             (user_id, binding_id, order_id, event_type, request_id, detail)
           VALUES ($1, $2, $3, 'submitted', $4, $5::jsonb)
           ON CONFLICT (user_id, binding_id, request_id) DO NOTHING`,
          [job.userId, job.bindingId, String(result.orderId), `submit:${job.id}`, JSON.stringify(result)],
        )
      }
      return { ...result, pendingOrder: finalOrder }
    }
    case 'multiuser.longbridge.run_once': {
      const symbol = typeof job.payload.symbol === 'string'
        ? job.payload.symbol.trim()
        : ''
      const result = symbol
        ? runTenantStrategyOnce(job.userId, connection, symbol)
        : runTenantStrategyPoolOnce(job.userId, connection)
      return enqueueAutomaticSubmissions(job, await result)
    }
    default:
      throw new Error(`不支持的多用户任务：${job.jobType}`)
  }
}

async function enqueueAutomaticSubmissions(
  job: TenantJob,
  result: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const gateRows = await query<{
    mode: string
    live_trading_enabled: boolean
    auto_submit_enabled: boolean
    shadow_verified_at: Date | null
  }>(
    `SELECT mode, live_trading_enabled, auto_submit_enabled, shadow_verified_at
     FROM multiuser.longbridge_engine_state
     WHERE user_id = $1 AND binding_id = $2`,
    [job.userId, job.bindingId],
  )
  const gate = gateRows[0]
  if (!gate
    || gate.mode !== 'live'
    || !gate.live_trading_enabled
    || !gate.auto_submit_enabled
    || !gate.shadow_verified_at) {
    return result
  }

  const pendingOrders = collectPendingOrders(result)
  const autoSubmitJobIds: string[] = []
  for (const pending of pendingOrders) {
    if (pending.status !== 'PENDING_CONFIRMATION' || !pending.intent) continue
    autoSubmitJobIds.push(await enqueueTenantJob({
      userId: job.userId,
      bindingId: job.bindingId,
      jobType: 'multiuser.longbridge.submit_order',
      payload: {
        pendingOrderId: pending.id,
        symbol: normalizeLongbridgeSymbol(pending.intent.ticker),
        side: pending.intent.side === 'BUY' ? 'BUY' : 'SELL',
        quantity: pending.intent.quantity,
        orderType: pending.intent.orderType === 'MARKET' ? 'MO' : 'LO',
        orderSession: pending.intent.orderSession,
        limitPrice: pending.intent.limitPrice,
        remark: `financial:${pending.id}`.slice(0, 64),
      },
    }))
  }
  return autoSubmitJobIds.length ? { ...result, autoSubmitJobIds } : result
}

function collectPendingOrders(result: Record<string, unknown>): TenantAutoSubmitPendingOrder[] {
  const candidates = [
    result.pendingOrder,
    ...(Array.isArray(result.results)
      ? result.results.map((item) =>
          item && typeof item === 'object'
            ? (item as Record<string, unknown>).pendingOrder
            : undefined)
      : []),
  ]
  return candidates.filter((item): item is TenantAutoSubmitPendingOrder =>
    Boolean(item && typeof item === 'object'
      && typeof (item as { id?: unknown }).id === 'string'
      && typeof (item as { status?: unknown }).status === 'string'))
}

async function processJobs(): Promise<void> {
  if (!active) return
  try {
    for (let processed = 0; active && processed < 10; processed += 1) {
      const job = await claimTenantJob(workerId)
      if (!job) break
      try {
        const result = await handleTenantJob(job)
        await completeTenantJob(job.id, result)
      } catch (error) {
        await failTenantJob(
          job.id,
          error instanceof Error ? error.message : String(error),
          ![
            'multiuser.longbridge.verify_connection',
            'multiuser.longbridge.submit_order',
            'multiuser.longbridge.run_once',
          ].includes(job.jobType),
        )
      }
    }
  } catch (error) {
    logger.error({
      event: 'multiuser.worker.loop_failed',
      error: error instanceof Error ? error.message : String(error),
    }, '多用户任务循环失败')
  } finally {
    if (active) jobTimer = setTimeout(() => void processJobs(), POLL_MS)
  }
}

async function writeHeartbeats(): Promise<void> {
  if (!active) return
  try {
    const bindings = await query<{
      user_id: string
      id: string
      auto_cancel_enabled: boolean
      settings: Record<string, unknown>
    }>(
      `SELECT c.user_id, c.id, s.auto_cancel_enabled, s.settings
       FROM multiuser.broker_connections c
       JOIN multiuser.user_profiles p ON p.user_id = c.user_id
       JOIN multiuser.longbridge_engine_state s
         ON s.user_id = c.user_id AND s.binding_id = c.id
       WHERE c.status = 'verified' AND c.credential_source = 'encrypted_bundle'
         AND p.active = TRUE AND s.desired = 'running'
       ORDER BY c.user_id
       LIMIT 20`,
    )
    for (const binding of bindings) {
      await query(
        `INSERT INTO multiuser.longbridge_jobs
           (user_id, binding_id, job_type, payload)
         SELECT $1, $2, 'multiuser.longbridge.run_once', '{}'::jsonb
         WHERE NOT EXISTS (
           SELECT 1 FROM multiuser.longbridge_jobs
           WHERE user_id = $1 AND binding_id = $2
             AND job_type = 'multiuser.longbridge.run_once'
             AND (
               status IN ('queued', 'running')
               OR updated_at > now() - interval '60 seconds'
             )
         )`,
        [binding.user_id, binding.id],
      )
      const connection = await getOwnedConnection(String(binding.user_id), binding.id)
      if (connection) {
        await superviseTenantOrders(
          String(binding.user_id),
          connection,
          binding.auto_cancel_enabled,
          binding.settings,
        )
      }
      const dashboard = await loadTenantLiveDashboard(String(binding.user_id), binding.id, connection ?? undefined)
      await query(
        `INSERT INTO multiuser.longbridge_worker_snapshots
           (user_id, binding_id, snapshot, heartbeat_at)
         VALUES ($1, $2, $3::jsonb, now())
         ON CONFLICT (user_id, binding_id) DO UPDATE
           SET snapshot = EXCLUDED.snapshot, heartbeat_at = now()`,
        [binding.user_id, binding.id, JSON.stringify(dashboard)],
      )
    }
  } catch (error) {
    logger.error({
      event: 'multiuser.worker.heartbeat_failed',
      error: error instanceof Error ? error.message : String(error),
    }, '多用户心跳失败')
  } finally {
    if (active) heartbeatTimer = setTimeout(() => void writeHeartbeats(), HEARTBEAT_MS)
  }
}

async function superviseTenantOrders(
  userId: string,
  connection: NonNullable<Awaited<ReturnType<typeof getOwnedConnection>>>,
  autoCancelEnabled: boolean,
  settings: Record<string, unknown>,
): Promise<void> {
  const orders = await query<{
    order_id: string
    payload: Record<string, unknown>
    created_at: Date
  }>(
    `SELECT order_id, payload, created_at
     FROM multiuser.longbridge_managed_orders
     WHERE user_id = $1 AND binding_id = $2
       AND status IN ('TRACKING', 'PARTIALLY_FILLED', 'CANCEL_REQUESTED', 'CANCEL_PENDING')
     ORDER BY updated_at
     LIMIT 50`,
    [userId, connection.id],
  )
  for (const order of orders) {
    const detail = await runTenantOrderChild(connection, 'detail', {
      orderId: order.order_id,
      submittedAt: order.payload.submittedAt,
    })
    if (detail.ok !== true) continue
    const status = managedStatus(Number(detail.status))
    const submittedQuantity = Number(detail.quantity ?? order.payload.submittedQuantity ?? 0)
    const executedQuantity = Number(detail.executedQuantity ?? 0)
    const canCancel = [1, 6, 7, 11].includes(Number(detail.status))
    const now = new Date().toISOString()
    const next = {
      ...order.payload,
      brokerStatus: String(detail.statusLabel ?? '未知'),
      status,
      canCancel,
      submittedQuantity,
      executedQuantity,
      remainingQuantity: Math.max(0, submittedQuantity - executedQuantity),
      executedPrice: detail.executedPrice === null ? null : Number(detail.executedPrice),
      brokerUpdatedAt: detail.updatedAt,
      lastCheckedAt: now,
      terminalAt: isTerminalManagedStatus(status) ? now : undefined,
      rawBrokerSnapshot: detail,
      version: Number(order.payload.version ?? 0) + 1,
      updatedAt: now,
    }
    await query(
      `UPDATE multiuser.longbridge_managed_orders
       SET status = $4, payload = $5::jsonb, updated_at = now()
       WHERE user_id = $1 AND binding_id = $2 AND order_id = $3`,
      [userId, connection.id, order.order_id, status, JSON.stringify(next)],
    )
    await query(
      `INSERT INTO multiuser.longbridge_order_events
         (user_id, binding_id, order_id, event_type, request_id, detail)
       VALUES ($1, $2, $3, 'reconciled', $4, $5::jsonb)
       ON CONFLICT (user_id, binding_id, request_id) DO NOTHING`,
      [userId, connection.id, order.order_id, `reconcile:${order.order_id}:${detail.status}:${detail.updatedAt ?? now}`, JSON.stringify(detail)],
    )
    const timeoutSeconds = Number(
      order.payload.orderType === 'MARKETABLE_LIMIT'
        ? settings.marketableLimitTimeoutSeconds ?? 90
        : settings.limitTimeoutSeconds ?? 600,
    )
    if (
      autoCancelEnabled
      && canCancel
      && Date.now() - order.created_at.getTime() >= timeoutSeconds * 1_000
    ) {
      const cancelled = await runTenantOrderChild(connection, 'cancel', { orderId: order.order_id })
      await query(
        `INSERT INTO multiuser.longbridge_order_events
           (user_id, binding_id, order_id, event_type, request_id, detail)
         VALUES ($1, $2, $3, 'auto_cancel_requested', $4, $5::jsonb)
         ON CONFLICT (user_id, binding_id, request_id) DO NOTHING`,
        [userId, connection.id, order.order_id, `auto-cancel:${order.order_id}`, JSON.stringify(cancelled)],
      )
    }
  }
}

function managedStatus(status: number): string {
  if (status === 5) return 'FILLED'
  if (status === 11) return 'PARTIALLY_FILLED'
  if (status === 14) return 'REJECTED'
  if (status === 15) return 'CANCELED'
  if (status === 16) return 'EXPIRED'
  if (status === 17) return 'PARTIALLY_CANCELED'
  if (status === 12 || status === 13) return 'CANCEL_PENDING'
  return [1, 6, 7, 8, 9, 10].includes(status) ? 'TRACKING' : 'UNKNOWN'
}

function isTerminalManagedStatus(status: string): boolean {
  return ['FILLED', 'CANCELED', 'PARTIALLY_CANCELED', 'REJECTED', 'EXPIRED'].includes(status)
}

export function startMultiUserWorkerRuntime(id: string): void {
  if (!multiUserEnabled() || active) return
  active = true
  workerId = id
  void processJobs()
  void writeHeartbeats()
  logger.info({ event: 'multiuser.worker.started', workerId }, '多用户 Worker runtime 已启动')
}

export function stopMultiUserWorkerRuntime(): void {
  active = false
  if (jobTimer) clearTimeout(jobTimer)
  if (heartbeatTimer) clearTimeout(heartbeatTimer)
  jobTimer = undefined
  heartbeatTimer = undefined
}

export const multiUserWorkerTestHarness = {
  handleTenantJob,
  superviseTenantOrders,
  managedStatus,
  isTerminalManagedStatus,
}
