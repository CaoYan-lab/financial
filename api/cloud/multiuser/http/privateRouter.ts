import { Router, type NextFunction, type Response } from 'express'
import { query, queryOne } from '../../db/pgClient.js'
import { multiUserEnabled } from '../auth/multiUserAuthService.js'
import { validatePassword, verifyPassword } from '../auth/passwordService.js'
import {
  changePassword,
  createMember,
  getPasswordHash,
  listProfiles,
  resetMemberPassword,
  setProfileActive,
} from '../auth/profileStore.js'
import { writeSecurityAudit } from '../audit/securityAuditStore.js'
import {
  createFutuUnlock,
  futuSecretConfigured,
  futuUnlockMaxAgeSeconds,
  revokeFutuUnlock,
  setFutuSecondaryPassword,
  validateFutuUnlock,
} from '../futu/futuStepUpService.js'
import { readCookie } from '../futu/futuAccessPolicy.js'
import type { BrokerConnection, MultiUserRequest } from '../types.js'
import {
  disableConnection,
  getActiveConnection,
  getConnectionForVerification,
  savePendingConnection,
} from '../longbridge/connectionStore.js'
import { evictConnectionContext } from '../longbridge/contextRegistry.js'
import { validateCredentialBundle } from '../longbridge/credentialVault.js'
import {
  listTenantHistory,
  loadTenantLiveDashboard,
  loadTenantWorkbench,
  setTenantDesiredState,
  verifyTenantCredentials,
} from '../longbridge/tenantDataService.js'
import {
  expireTenantPendingOrders,
  getTenantPendingOrder,
  rejectTenantPendingOrder,
} from '../longbridge/tenantOrderStore.js'
import { enqueueTenantJob, getTenantJob } from '../longbridge/tenantJobStore.js'
import { loadLongbridgeLiveTradingConfig } from '../../../longbridge/longbridgeAdapter.js'

const JOB_WAIT_MS = 40_000
const JOB_POLL_MS = 250
const unlockFailures = new Map<string, { count: number; resetAt: number }>()

function clientIp(req: MultiUserRequest): string {
  const forwarded = req.headers['x-forwarded-for']
  return typeof forwarded === 'string'
    ? forwarded.split(',')[0].trim()
    : req.ip || req.socket.remoteAddress || 'unknown'
}

function secureCookie(req: MultiUserRequest): boolean {
  return req.protocol === 'https' || process.env.CLOUD_COOKIE_SECURE === 'true'
}

function longbridgeSymbol(ticker: string): string {
  const normalized = ticker.trim().toUpperCase()
  if (normalized.includes('.')) return normalized
  if (/^\d{1,5}$/.test(normalized)) return `${normalized.replace(/^0+/, '')}.HK`
  return `${normalized}.US`
}

function futuCookie(value: string, maxAge: number, secure: boolean): string {
  const parts = [
    `fa_futu_unlock=${encodeURIComponent(value)}`,
    'Path=/',
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=Strict',
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

function requireOwner(req: MultiUserRequest, res: Response): boolean {
  if (req.multiUser?.role === 'owner') return true
  res.status(403).json({ success: false, code: 'ROLE_FORBIDDEN', error: '仅所有者可执行此操作' })
  return false
}

function limitedUnlock(key: string): boolean {
  const now = Date.now()
  const current = unlockFailures.get(key)
  if (!current || current.resetAt <= now) {
    unlockFailures.set(key, { count: 0, resetAt: now + 10 * 60_000 })
    return false
  }
  return current.count >= 5
}

function recordUnlockFailure(key: string): void {
  const current = unlockFailures.get(key)
  if (current) current.count += 1
  else unlockFailures.set(key, { count: 1, resetAt: Date.now() + 10 * 60_000 })
}

function publicConnection(connection: BrokerConnection | null) {
  if (!connection) return null
  return {
    id: connection.id,
    platform: connection.platform,
    status: connection.status,
    credentialSource: connection.credentialSource,
    accountFingerprint: connection.accountFingerprint,
    tokenExpiresAt: connection.tokenExpiresAt,
    lastVerifiedAt: connection.lastVerifiedAt,
  }
}

async function memberConnection(
  req: MultiUserRequest,
  res: Response,
): Promise<BrokerConnection | null> {
  const userId = req.multiUser?.userId
  if (!userId) {
    res.status(401).json({ success: false, code: 'AUTH_REQUIRED', error: '未登录' })
    return null
  }
  const connection = await getActiveConnection(userId)
  if (!connection) {
    res.status(428).json({
      success: false,
      code: 'LONGBRIDGE_CONNECTION_REQUIRED',
      error: '请先绑定当前用户的 Longbridge 账户',
    })
    return null
  }
  if (connection.status !== 'verified') {
    res.status(409).json({
      success: false,
      code: 'LONGBRIDGE_CONNECTION_INVALID',
      error: '当前 Longbridge 绑定无效，请重新验证',
    })
    return null
  }
  return connection
}

async function waitForJob(userId: string, jobId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + JOB_WAIT_MS
  while (Date.now() < deadline) {
    const job = await getTenantJob(userId, jobId)
    if (!job) throw new Error('任务不存在')
    if (job.status === 'succeeded') return job.result ?? { ok: true }
    if (job.status === 'failed') return { ok: false, error: job.error ?? '任务失败' }
    await new Promise((resolve) => setTimeout(resolve, JOB_POLL_MS))
  }
  throw new Error('任务等待超时')
}

export function createMultiUserPrivateRouter(): Router {
  const router = Router()

  router.use((_req, _res, next) => {
    if (!multiUserEnabled()) {
      next('router')
      return
    }
    next()
  })

  router.get('/multiuser/session', (req: MultiUserRequest, res: Response) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json({ success: true, profile: req.multiUser })
  })

  router.post('/multiuser/password/change', async (req: MultiUserRequest, res: Response) => {
    const currentPassword = String(req.body?.currentPassword ?? '')
    const newPassword = String(req.body?.newPassword ?? '')
    const error = validatePassword(newPassword)
    if (error) {
      res.status(400).json({ success: false, error })
      return
    }
    const hash = await getPasswordHash(req.multiUser!.userId)
    if (!hash || !verifyPassword(currentPassword, hash)) {
      res.status(400).json({ success: false, error: '当前密码错误' })
      return
    }
    if (verifyPassword(newPassword, hash)) {
      res.status(400).json({ success: false, error: '新密码不能与当前密码相同' })
      return
    }
    await changePassword(req.multiUser!.userId, newPassword)
    await writeSecurityAudit({
      actorUserId: req.multiUser!.userId,
      eventType: 'password_changed',
      success: true,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'],
    })
    res.json({ success: true })
  })

  router.get('/multiuser/users', async (req: MultiUserRequest, res: Response) => {
    if (!requireOwner(req, res)) return
    const profiles = await listProfiles()
    const users = await Promise.all(profiles.map(async (profile) => {
      const connection = await getActiveConnection(profile.userId)
      const gate = connection
        ? await queryOne<{
            mode: string
            live_trading_enabled: boolean
            auto_submit_enabled: boolean
            shadow_verified_at: Date | null
          }>(
            `SELECT mode, live_trading_enabled, auto_submit_enabled, shadow_verified_at
             FROM multiuser.longbridge_engine_state
             WHERE user_id = $1 AND binding_id = $2`,
            [profile.userId, connection.id],
          )
        : null
      return {
        ...profile,
        longbridgeConnection: publicConnection(connection),
        longbridgeLiveGate: {
          shadowVerifiedAt: gate?.shadow_verified_at?.toISOString(),
          liveTradingEnabled: gate?.mode === 'live' && gate.live_trading_enabled,
          autoSubmitEnabled: gate?.auto_submit_enabled === true,
        },
      }
    }))
    res.json({ success: true, users })
  })

  router.put('/multiuser/users/:id/longbridge-live-gate', async (req: MultiUserRequest, res: Response) => {
    if (!requireOwner(req, res)) return
    const enabled = req.body?.enabled === true
    const target = await queryOne<{
      user_id: string
      active: boolean
      binding_id: string | null
    }>(
      `SELECT p.user_id, p.active, c.id AS binding_id
       FROM multiuser.user_profiles p
       LEFT JOIN multiuser.broker_connections c
         ON c.user_id = p.user_id AND c.platform = 'longbridge' AND c.status = 'verified'
       WHERE p.user_id = $1 AND p.role = 'member'`,
      [req.params.id],
    )
    if (!target || !target.active || !target.binding_id) {
      res.status(409).json({
        success: false,
        error: '目标用户未启用或尚未完成长桥账户验证。',
      })
      return
    }
    await query(
      `INSERT INTO multiuser.longbridge_engine_state
         (user_id, binding_id, mode, live_trading_enabled, auto_submit_enabled, shadow_verified_at)
       VALUES ($1, $2, $3, $4, FALSE, $5)
       ON CONFLICT (user_id, binding_id) DO UPDATE
         SET mode = EXCLUDED.mode,
             live_trading_enabled = EXCLUDED.live_trading_enabled,
             auto_submit_enabled = CASE WHEN EXCLUDED.live_trading_enabled
               THEN multiuser.longbridge_engine_state.auto_submit_enabled ELSE FALSE END,
             shadow_verified_at = EXCLUDED.shadow_verified_at,
             updated_at = now()`,
      [
        target.user_id,
        target.binding_id,
        enabled ? 'live' : 'shadow',
        enabled,
        enabled ? new Date() : null,
      ],
    )
    await writeSecurityAudit({
      actorUserId: req.multiUser!.userId,
      targetUserId: target.user_id,
      eventType: enabled ? 'longbridge_live_gate_approved' : 'longbridge_live_gate_revoked',
      success: true,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'],
      resourceId: target.binding_id,
    })
    res.json({
      success: true,
      shadowVerifiedAt: enabled ? new Date().toISOString() : undefined,
      liveTradingEnabled: enabled,
      autoSubmitEnabled: false,
    })
  })

  router.post('/multiuser/users', async (req: MultiUserRequest, res: Response) => {
    if (!requireOwner(req, res)) return
    const username = String(req.body?.username ?? '').trim()
    const displayName = String(req.body?.displayName ?? username).trim()
    const temporaryPassword = String(req.body?.temporaryPassword ?? '')
    if (!/^[A-Za-z0-9_.-]{3,64}$/.test(username)) {
      res.status(400).json({ success: false, error: '用户名需为 3-64 位字母、数字或 ._-' })
      return
    }
    const passwordError = validatePassword(temporaryPassword)
    if (passwordError) {
      res.status(400).json({ success: false, error: passwordError })
      return
    }
    try {
      const profile = await createMember({
        username,
        displayName: displayName || username,
        temporaryPassword,
        createdBy: req.multiUser!.userId,
      })
      await writeSecurityAudit({
        actorUserId: req.multiUser!.userId,
        targetUserId: profile.userId,
        eventType: 'user_created',
        success: true,
        ip: clientIp(req),
        userAgent: req.headers['user-agent'],
      })
      res.status(201).json({ success: true, user: profile })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      res.status(message.includes('unique') ? 409 : 500).json({
        success: false,
        error: message.includes('unique') ? '用户名已存在' : '创建用户失败',
      })
    }
  })

  router.put('/multiuser/users/:id/status', async (req: MultiUserRequest, res: Response) => {
    if (!requireOwner(req, res)) return
    const active = req.body?.active === true
    const connection = active ? null : await getActiveConnection(req.params.id)
    await setProfileActive(req.params.id, active)
    if (!active) {
      await disableConnection(req.params.id)
      await query(
        `UPDATE multiuser.longbridge_jobs
         SET status = 'cancelled', updated_at = now()
         WHERE user_id = $1 AND status = 'queued'`,
        [req.params.id],
      )
      if (connection) evictConnectionContext(connection.id)
    }
    await writeSecurityAudit({
      actorUserId: req.multiUser!.userId,
      targetUserId: req.params.id,
      eventType: active ? 'user_enabled' : 'user_disabled',
      success: true,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'],
    })
    res.json({ success: true })
  })

  router.post('/multiuser/users/:id/reset-password', async (req: MultiUserRequest, res: Response) => {
    if (!requireOwner(req, res)) return
    const temporaryPassword = String(req.body?.temporaryPassword ?? '')
    const error = validatePassword(temporaryPassword)
    if (error) {
      res.status(400).json({ success: false, error })
      return
    }
    await resetMemberPassword(req.params.id, temporaryPassword)
    await writeSecurityAudit({
      actorUserId: req.multiUser!.userId,
      targetUserId: req.params.id,
      eventType: 'user_password_reset',
      success: true,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'],
    })
    res.json({ success: true })
  })

  router.get('/multiuser/futu/access', async (req: MultiUserRequest, res: Response) => {
    if (req.multiUser?.role !== 'owner') {
      res.json({ success: true, status: 'forbidden' })
      return
    }
    const configured = await futuSecretConfigured(req.multiUser.userId)
    if (!configured) {
      res.json({ success: true, status: 'setup_required' })
      return
    }
    const unlocked = await validateFutuUnlock(
      req.multiUser.userId,
      readCookie(req, 'fa_futu_unlock'),
    )
    res.json({ success: true, status: unlocked ? 'unlocked' : 'locked' })
  })

  router.post('/multiuser/futu/secondary-password', async (req: MultiUserRequest, res: Response) => {
    if (!requireOwner(req, res)) return
    try {
      await setFutuSecondaryPassword({
        ownerUserId: req.multiUser!.userId,
        currentPassword: String(req.body?.currentPassword ?? ''),
        secondaryPassword: String(req.body?.secondaryPassword ?? ''),
      })
      await writeSecurityAudit({
        actorUserId: req.multiUser!.userId,
        eventType: 'futu_secondary_password_set',
        success: true,
        ip: clientIp(req),
        userAgent: req.headers['user-agent'],
      })
      res.append('Set-Cookie', futuCookie('', 0, secureCookie(req)))
      res.json({ success: true, status: 'locked' })
    } catch (error) {
      res.status(400).json({ success: false, error: error instanceof Error ? error.message : String(error) })
    }
  })

  router.post('/multiuser/futu/unlock', async (req: MultiUserRequest, res: Response) => {
    if (!requireOwner(req, res)) return
    const key = `${req.multiUser!.userId}:${clientIp(req)}`
    if (limitedUnlock(key)) {
      res.status(429).json({ success: false, error: '二次验证失败次数过多，请稍后再试' })
      return
    }
    try {
      const token = await createFutuUnlock({
        ownerUserId: req.multiUser!.userId,
        secondaryPassword: String(req.body?.secondaryPassword ?? ''),
        ip: clientIp(req),
        userAgent: req.headers['user-agent'],
      })
      unlockFailures.delete(key)
      res.append('Set-Cookie', futuCookie(token, futuUnlockMaxAgeSeconds(), secureCookie(req)))
      await writeSecurityAudit({
        actorUserId: req.multiUser!.userId,
        eventType: 'futu_unlocked',
        success: true,
        ip: clientIp(req),
        userAgent: req.headers['user-agent'],
      })
      res.json({ success: true, status: 'unlocked' })
    } catch (error) {
      recordUnlockFailure(key)
      const code = error instanceof Error ? error.message : String(error)
      await writeSecurityAudit({
        actorUserId: req.multiUser!.userId,
        eventType: 'futu_unlock_failed',
        success: false,
        ip: clientIp(req),
        userAgent: req.headers['user-agent'],
      })
      res.status(code === 'FUTU_STEP_UP_SETUP_REQUIRED' ? 428 : 401).json({
        success: false,
        code,
        error: code === 'FUTU_STEP_UP_SETUP_REQUIRED'
          ? '请先设置 Futu 二次密码'
          : 'Futu 二次密码错误',
      })
    }
  })

  router.post('/multiuser/futu/lock', async (req: MultiUserRequest, res: Response) => {
    if (!requireOwner(req, res)) return
    await revokeFutuUnlock(req.multiUser!.userId, readCookie(req, 'fa_futu_unlock'))
    res.append('Set-Cookie', futuCookie('', 0, secureCookie(req)))
    res.json({ success: true, status: 'locked' })
  })

  router.get('/multiuser/longbridge/connection', async (req: MultiUserRequest, res: Response) => {
    const connection = await getActiveConnection(req.multiUser!.userId)
    res.json({ success: true, connection: publicConnection(connection) })
  })

  router.post('/multiuser/longbridge/connection/verify', async (req: MultiUserRequest, res: Response) => {
    try {
      const credentials = {
        appKey: String(req.body?.appKey ?? ''),
        appSecret: String(req.body?.appSecret ?? ''),
        accessToken: String(req.body?.accessToken ?? ''),
      }
      validateCredentialBundle(credentials)
      const result = await verifyTenantCredentials(credentials)
      res.json({ success: true, accountFingerprint: result.accountFingerprint })
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : 'Longbridge 凭据验证失败',
      })
    }
  })

  router.put('/multiuser/longbridge/connection', async (req: MultiUserRequest, res: Response) => {
    try {
      const credentials = {
        appKey: String(req.body?.appKey ?? ''),
        appSecret: String(req.body?.appSecret ?? ''),
        accessToken: String(req.body?.accessToken ?? ''),
      }
      validateCredentialBundle(credentials)
      await verifyTenantCredentials(credentials)
      const pending = await savePendingConnection(req.multiUser!.userId, credentials)
      const jobId = await enqueueTenantJob({
        userId: req.multiUser!.userId,
        bindingId: pending.id,
        jobType: 'multiuser.longbridge.verify_connection',
      })
      await waitForJob(req.multiUser!.userId, jobId)
      const connection = await getConnectionForVerification(req.multiUser!.userId, pending.id)
      if (!connection || connection.status !== 'verified') {
        throw new Error('长桥订单读取验证未通过')
      }
      await writeSecurityAudit({
        actorUserId: req.multiUser!.userId,
        eventType: 'longbridge_connection_saved',
        resourceType: 'broker_connection',
        resourceId: connection.id,
        success: true,
        ip: clientIp(req),
        userAgent: req.headers['user-agent'],
      })
      res.json({ success: true, connection: publicConnection(connection) })
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : 'Longbridge 凭据保存失败',
      })
    }
  })

  router.delete('/multiuser/longbridge/connection', async (req: MultiUserRequest, res: Response) => {
    const connection = await getActiveConnection(req.multiUser!.userId)
    await disableConnection(req.multiUser!.userId)
    if (connection) evictConnectionContext(connection.id)
    res.json({ success: true })
  })

  registerTenantLongbridgeRoutes(router)
  return router
}

function registerTenantLongbridgeRoutes(router: Router): void {
  const memberOnly = async (
    req: MultiUserRequest,
    res: Response,
    next: NextFunction,
    handler: (connection: BrokerConnection) => Promise<void>,
  ) => {
    if (req.multiUser?.role === 'owner') {
      next()
      return
    }
    try {
      const connection = await memberConnection(req, res)
      if (connection) await handler(connection)
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  router.get('/longbridge/workbench/dashboard', (req: MultiUserRequest, res, next) =>
    memberOnly(req, res, next, async (connection) => {
      res.json(await loadTenantWorkbench(connection))
    }))

  router.get('/longbridge/source/status', (req: MultiUserRequest, res, next) =>
    memberOnly(req, res, next, async (connection) => {
      res.json((await loadTenantWorkbench(connection)).sourceStatus)
    }))

  router.get('/longbridge/realtime/status/subscription', (req: MultiUserRequest, res, next) =>
    memberOnly(req, res, next, async () => {
      res.json({ ok: true, connected: true, source: '独立用户 SDK Context', subscriptions: [] })
    }))

  router.get('/longbridge/live-trading/dashboard', (req: MultiUserRequest, res, next) =>
    memberOnly(req, res, next, async (connection) => {
      res.json(await loadTenantLiveDashboard(req.multiUser!.userId, connection.id, connection))
    }))

  router.get('/longbridge/live-trading/config', (req: MultiUserRequest, res, next) =>
    memberOnly(req, res, next, async () => {
      res.json(loadLongbridgeLiveTradingConfig())
    }))

  for (const configPath of ['llm-config', 'trade-strategy-config']) {
    router.put(`/longbridge/live-trading/${configPath}`, (req: MultiUserRequest, res, next) =>
      memberOnly(req, res, next, async () => {
        res.status(409).json({
          success: false,
          code: 'TENANT_CONFIG_READ_ONLY',
          error: '多用户影子验收期间策略配置只读，避免影响其他账户。',
        })
      }))
  }

  router.get('/longbridge/live-trading/accounts', (req: MultiUserRequest, res, next) =>
    memberOnly(req, res, next, async (connection) => {
      res.json(await loadTenantWorkbench(connection))
    }))

  router.get('/longbridge/live-trading/settings', (req: MultiUserRequest, res, next) =>
    memberOnly(req, res, next, async (connection) => {
      const dashboard = await loadTenantLiveDashboard(req.multiUser!.userId, connection.id, connection)
      res.json({
        liveTradingEnabled: dashboard.liveTradingEnabled,
        autoSubmitEnabled: dashboard.autoSubmitEnabled,
        autoCancelEnabled: dashboard.autoCancelEnabled,
        blockOpeningWhenCashNegative:
          dashboard.blockOpeningWhenCashNegative,
        marketableLimitTimeoutSeconds: dashboard.marketableLimitTimeoutSeconds,
        limitTimeoutSeconds: dashboard.limitTimeoutSeconds,
        brokerSyncIntervalSeconds: dashboard.brokerSyncIntervalSeconds,
        modelReviewIntervalSeconds: dashboard.modelReviewIntervalSeconds,
        updatedAt: dashboard.updatedAt,
      })
    }))

  router.put('/longbridge/live-trading/settings', (req: MultiUserRequest, res, next) =>
    memberOnly(req, res, next, async (connection) => {
      const state = await queryOne<{
        shadow_verified_at: Date | null
        live_trading_enabled: boolean
        auto_submit_enabled: boolean
        auto_cancel_enabled: boolean
      }>(
        `SELECT shadow_verified_at, live_trading_enabled, auto_submit_enabled, auto_cancel_enabled
         FROM multiuser.longbridge_engine_state
         WHERE user_id = $1 AND binding_id = $2`,
        [req.multiUser!.userId, connection.id],
      )
      const requestedLive = typeof req.body?.liveTradingEnabled === 'boolean'
        ? req.body.liveTradingEnabled
        : state?.live_trading_enabled === true
      const requestedAutoSubmit = typeof req.body?.autoSubmitEnabled === 'boolean'
        ? req.body.autoSubmitEnabled
        : state?.auto_submit_enabled === true
      if (requestedAutoSubmit && (!requestedLive || !state?.shadow_verified_at)) {
        res.status(409).json({
          success: false,
          error: '真实交易门禁尚未通过 owner 验收，不能开启自动下单。',
        })
        return
      }
      await query(
        `UPDATE multiuser.longbridge_engine_state
         SET live_trading_enabled = $3,
             mode = CASE WHEN $3 THEN 'live' ELSE 'shadow' END,
             auto_submit_enabled = $4,
             auto_cancel_enabled = $5,
             settings = settings || $6::jsonb,
             updated_at = now()
         WHERE user_id = $1 AND binding_id = $2`,
        [
          req.multiUser!.userId,
          connection.id,
          requestedLive && Boolean(state?.shadow_verified_at),
          requestedAutoSubmit,
          typeof req.body?.autoCancelEnabled === 'boolean'
            ? req.body.autoCancelEnabled
            : state?.auto_cancel_enabled === true,
          JSON.stringify(req.body ?? {}),
        ],
      )
      res.json(await loadTenantLiveDashboard(req.multiUser!.userId, connection.id, connection))
    }))

  router.get('/longbridge/live-trading/history/:kind', (req: MultiUserRequest, res, next) =>
    memberOnly(req, res, next, async (connection) => {
      const kind = req.params.kind
      if (!['signals', 'pending-orders', 'candidate-pool'].includes(kind)) {
        res.status(404).json({ success: false, error: '不支持的历史类型' })
        return
      }
      const page = Math.max(1, Number(req.query.page) || 1)
      const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 12))
      res.json(await listTenantHistory(
        req.multiUser!.userId,
        connection.id,
        kind,
        page,
        pageSize,
        Object.fromEntries(
          ['status', 'ticker', 'side', 'direction', 'lifecycleStatus', 'statusGroup']
            .flatMap((key) => typeof req.query[key] === 'string'
              ? [[key, String(req.query[key]).toUpperCase()]]
              : []),
        ),
      ))
    }))

  router.get('/longbridge/live-trading/managed-orders', (req: MultiUserRequest, res, next) =>
    memberOnly(req, res, next, async (connection) => {
      const orders = await query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM multiuser.longbridge_managed_orders
         WHERE user_id = $1 AND binding_id = $2
         ORDER BY updated_at DESC`,
        [req.multiUser!.userId, connection.id],
      )
      const events = await query<{
        id: string
        order_id: string
        event_type: string
        detail: Record<string, unknown>
        created_at: Date
      }>(
        `SELECT id, order_id, event_type, detail, created_at
         FROM multiuser.longbridge_order_events
         WHERE user_id = $1 AND binding_id = $2
         ORDER BY created_at DESC
         LIMIT 200`,
        [req.multiUser!.userId, connection.id],
      )
      res.json({
        ok: true,
        orders: orders.map((row) => row.payload),
        events: events.map((event) => ({
          id: String(event.id),
          platform: 'longbridge',
          orderId: event.order_id,
          eventType: event.event_type,
          source: event.event_type.includes('cancel') ? 'hard_rule' : 'reconcile',
          detail: event.detail,
          createdAt: event.created_at.toISOString(),
        })),
      })
    }))

  router.get('/longbridge/live-trading/orders', (req: MultiUserRequest, res, next) =>
    memberOnly(req, res, next, async (connection) => {
      const ticker = typeof req.query.ticker === 'string' ? req.query.ticker.toUpperCase() : undefined
      const jobId = await enqueueTenantJob({
        userId: req.multiUser!.userId,
        bindingId: connection.id,
        jobType: 'multiuser.longbridge.orders',
        payload: {
          page: Number(req.query.page) || 1,
          pageSize: Number(req.query.pageSize) || 12,
          startDate: req.query.startDate,
          endDate: req.query.endDate,
          symbol: ticker && ticker !== 'ALL' ? ticker : undefined,
          status: req.query.status,
          side: req.query.side,
        },
      })
      res.json(await waitForJob(req.multiUser!.userId, jobId))
    }))

  router.get('/longbridge/live-trading/orders/:orderId/detail', (req: MultiUserRequest, res, next) =>
    memberOnly(req, res, next, async (connection) => {
      const jobId = await enqueueTenantJob({
        userId: req.multiUser!.userId,
        bindingId: connection.id,
        jobType: 'multiuser.longbridge.order_detail',
        payload: {
          orderId: req.params.orderId,
          submittedAt: req.query.submittedAt,
        },
      })
      const detail = await waitForJob(req.multiUser!.userId, jobId)
      res.json({
        ok: detail.ok === true,
        orderId: req.params.orderId,
        brokerOrder: detail.ok === true ? detail : undefined,
        managedEvents: [],
        error: detail.ok === true ? undefined : detail.error,
      })
    }))

  router.post('/longbridge/live-trading/orders/:orderId/cancel', (req: MultiUserRequest, res, next) =>
    memberOnly(req, res, next, async (connection) => {
      const owned = await queryOne<{ present: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM multiuser.longbridge_managed_orders
           WHERE user_id = $1 AND binding_id = $2 AND order_id = $3
         ) AS present`,
        [req.multiUser!.userId, connection.id, req.params.orderId],
      )
      if (!owned?.present) {
        res.status(403).json({ ok: false, error: '该订单不属于当前用户的系统托管订单' })
        return
      }
      const jobId = await enqueueTenantJob({
        userId: req.multiUser!.userId,
        bindingId: connection.id,
        jobType: 'multiuser.longbridge.cancel_order',
        payload: { orderId: req.params.orderId },
      })
      res.json(await waitForJob(req.multiUser!.userId, jobId))
    }))

  for (const action of ['start', 'stop', 'run-once'] as const) {
    router.post(`/longbridge/live-trading/${action}`, (req: MultiUserRequest, res, next) =>
      memberOnly(req, res, next, async (connection) => {
        if (action === 'start' || action === 'stop') {
          await setTenantDesiredState(
            req.multiUser!.userId,
            connection.id,
            action === 'start' ? 'running' : 'stopped',
          )
        }
        const jobType = `multiuser.longbridge.${action === 'run-once' ? 'run_once' : action}`
        const jobId = await enqueueTenantJob({
          userId: req.multiUser!.userId,
          bindingId: connection.id,
          jobType,
          payload: action === 'run-once' ? { symbol: req.body?.symbol } : {},
        })
        res.status(202).json({ success: true, enqueued: true, jobId, jobType })
      }))
  }

  router.post('/longbridge/live-trading/pending-orders/:id/confirm', (req: MultiUserRequest, res, next) =>
    memberOnly(req, res, next, async (connection) => {
      const order = await getTenantPendingOrder(req.multiUser!.userId, connection.id, req.params.id)
      if (!order || order.status !== 'PENDING_CONFIRMATION') {
        res.status(404).json({ ok: false, error: '未找到当前用户可确认的待确认订单' })
        return
      }
      const jobId = await enqueueTenantJob({
        userId: req.multiUser!.userId,
        bindingId: connection.id,
        jobType: 'multiuser.longbridge.submit_order',
        payload: {
          pendingOrderId: order.id,
          symbol: longbridgeSymbol(order.intent.ticker),
          side: order.intent.side === 'BUY' ? 'BUY' : 'SELL',
          quantity: order.intent.quantity,
          orderType: order.intent.orderType === 'MARKET' ? 'MO' : 'LO',
          orderSession: order.intent.orderSession,
          limitPrice: order.intent.limitPrice,
          remark: `financial:${order.id}`.slice(0, 64),
        },
      })
      const result = await waitForJob(req.multiUser!.userId, jobId)
      if (result.ok !== true) {
        res.status(409).json({
          ok: false,
          order,
          blockedByGate: true,
          error: result.error ?? '当前用户尚未通过逐户实盘门禁',
        })
        return
      }
      res.json({ ok: true, order, result, blockedByGate: false })
    }))

  router.post('/longbridge/live-trading/pending-orders/:id/reject', (req: MultiUserRequest, res, next) =>
    memberOnly(req, res, next, async (connection) => {
      const order = await rejectTenantPendingOrder(req.multiUser!.userId, connection.id, req.params.id)
      if (!order) {
        res.status(404).json({ ok: false, error: '未找到当前用户可拒绝的待确认订单' })
        return
      }
      res.json({ ok: true, order })
    }))

  router.post('/longbridge/live-trading/pending-orders/batch-expire', (req: MultiUserRequest, res, next) =>
    memberOnly(req, res, next, async (connection) => {
      const expired = await expireTenantPendingOrders(req.multiUser!.userId, connection.id, {
        ids: Array.isArray(req.body?.ids) ? req.body.ids : undefined,
        ticker: typeof req.body?.ticker === 'string' ? req.body.ticker : undefined,
        side: typeof req.body?.side === 'string' ? req.body.side : undefined,
      })
      res.json({ ok: true, expiredCount: expired.length, expired })
    }))

  router.use('/longbridge', (req: MultiUserRequest, res: Response, next: NextFunction) => {
    if (req.multiUser?.role === 'owner') {
      next()
      return
    }
    res.status(404).json({
      success: false,
      code: 'TENANT_ROUTE_NOT_AVAILABLE',
      error: '当前用户无权访问该 Longbridge 全局接口',
    })
  })
}
