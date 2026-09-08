import { createServer, type Server } from 'node:http'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrokerConnection, UserProfile } from '../../api/cloud/multiuser/types.js'

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(() => true),
  validatePassword: vi.fn(),
  verifyPassword: vi.fn(),
  changePassword: vi.fn(),
  createMember: vi.fn(),
  getPasswordHash: vi.fn(),
  listProfiles: vi.fn(),
  resetMemberPassword: vi.fn(),
  setProfileActive: vi.fn(),
  audit: vi.fn(),
  createUnlock: vi.fn(),
  secretConfigured: vi.fn(),
  unlockMaxAge: vi.fn(() => 600),
  revokeUnlock: vi.fn(),
  setSecondaryPassword: vi.fn(),
  validateUnlock: vi.fn(),
  disableConnection: vi.fn(),
  getActiveConnection: vi.fn(),
  getConnectionForVerification: vi.fn(),
  savePendingConnection: vi.fn(),
  evictContext: vi.fn(),
  validateCredentials: vi.fn(),
  listHistory: vi.fn(),
  loadLiveDashboard: vi.fn(),
  loadWorkbench: vi.fn(),
  setDesiredState: vi.fn(),
  verifyCredentials: vi.fn(),
  expireOrders: vi.fn(),
  getPendingOrder: vi.fn(),
  rejectPendingOrder: vi.fn(),
  enqueueJob: vi.fn(),
  getJob: vi.fn(),
  loadConfig: vi.fn(),
  query: vi.fn(),
  queryOne: vi.fn(),
}))

vi.mock('../../api/cloud/db/pgClient.js', () => ({ query: mocks.query, queryOne: mocks.queryOne }))
vi.mock('../../api/cloud/multiuser/auth/multiUserAuthService.js', () => ({
  multiUserEnabled: mocks.enabled,
}))
vi.mock('../../api/cloud/multiuser/auth/passwordService.js', () => ({
  validatePassword: mocks.validatePassword,
  verifyPassword: mocks.verifyPassword,
}))
vi.mock('../../api/cloud/multiuser/auth/profileStore.js', () => ({
  changePassword: mocks.changePassword,
  createMember: mocks.createMember,
  getPasswordHash: mocks.getPasswordHash,
  listProfiles: mocks.listProfiles,
  resetMemberPassword: mocks.resetMemberPassword,
  setProfileActive: mocks.setProfileActive,
}))
vi.mock('../../api/cloud/multiuser/audit/securityAuditStore.js', () => ({
  writeSecurityAudit: mocks.audit,
}))
vi.mock('../../api/cloud/multiuser/futu/futuStepUpService.js', () => ({
  createFutuUnlock: mocks.createUnlock,
  futuSecretConfigured: mocks.secretConfigured,
  futuUnlockMaxAgeSeconds: mocks.unlockMaxAge,
  revokeFutuUnlock: mocks.revokeUnlock,
  setFutuSecondaryPassword: mocks.setSecondaryPassword,
  validateFutuUnlock: mocks.validateUnlock,
}))
vi.mock('../../api/cloud/multiuser/longbridge/connectionStore.js', () => ({
  disableConnection: mocks.disableConnection,
  getActiveConnection: mocks.getActiveConnection,
  getConnectionForVerification: mocks.getConnectionForVerification,
  savePendingConnection: mocks.savePendingConnection,
}))
vi.mock('../../api/cloud/multiuser/longbridge/contextRegistry.js', () => ({
  evictConnectionContext: mocks.evictContext,
}))
vi.mock('../../api/cloud/multiuser/longbridge/credentialVault.js', () => ({
  validateCredentialBundle: mocks.validateCredentials,
}))
vi.mock('../../api/cloud/multiuser/longbridge/tenantDataService.js', () => ({
  listTenantHistory: mocks.listHistory,
  loadTenantLiveDashboard: mocks.loadLiveDashboard,
  loadTenantWorkbench: mocks.loadWorkbench,
  setTenantDesiredState: mocks.setDesiredState,
  verifyTenantCredentials: mocks.verifyCredentials,
}))
vi.mock('../../api/cloud/multiuser/longbridge/tenantOrderStore.js', () => ({
  expireTenantPendingOrders: mocks.expireOrders,
  getTenantPendingOrder: mocks.getPendingOrder,
  rejectTenantPendingOrder: mocks.rejectPendingOrder,
}))
vi.mock('../../api/cloud/multiuser/longbridge/tenantJobStore.js', () => ({
  enqueueTenantJob: mocks.enqueueJob,
  getTenantJob: mocks.getJob,
}))
vi.mock('../../api/longbridge/longbridgeAdapter.js', () => ({
  loadLongbridgeLiveTradingConfig: mocks.loadConfig,
}))

import { createMultiUserPrivateRouter } from '../../api/cloud/multiuser/http/privateRouter.js'

const owner: UserProfile = {
  userId: 'owner-1',
  username: 'owner',
  displayName: '所有者',
  role: 'owner',
  active: true,
  mustChangePassword: false,
  sessionsValidAfter: new Date(0).toISOString(),
}
const member: UserProfile = { ...owner, userId: 'member-1', username: 'member', role: 'member' }
const connection: BrokerConnection = {
  id: 'binding-1',
  userId: member.userId,
  platform: 'longbridge',
  credentialSource: 'encrypted_bundle',
  status: 'verified',
  accountFingerprint: 'fingerprint',
}
const pendingOrder = {
  id: 'pending-1',
  status: 'PENDING_CONFIRMATION',
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  intent: {
    ticker: 'AAPL',
    side: 'BUY',
    quantity: 2,
    orderType: 'MARKET',
    orderSession: 'RTH',
    limitPrice: 100,
    strategy: 'test',
    signalId: 'signal-1',
    reason: 'test',
    estimatedNotional: '$200',
  },
  signal: {},
  llmDecision: {},
  riskWarnings: [],
}

describe('多用户 privateRouter', () => {
  let server: Server
  let baseUrl: string

  beforeEach(async () => {
    vi.clearAllMocks()
    process.env.MULTIUSER_ENABLED = 'true'
    process.env.CLOUD_COOKIE_SECURE = 'false'
    mocks.enabled.mockReturnValue(true)
    mocks.getPasswordHash.mockResolvedValue('password-hash')
    mocks.verifyPassword.mockImplementation((value: string) => value === 'current')
    mocks.listProfiles.mockResolvedValue([owner, member])
    mocks.createMember.mockResolvedValue(member)
    mocks.getActiveConnection.mockResolvedValue(connection)
    mocks.getConnectionForVerification.mockResolvedValue(connection)
    mocks.savePendingConnection.mockResolvedValue({ ...connection, status: 'pending' })
    mocks.verifyCredentials.mockResolvedValue({ accountFingerprint: 'fingerprint' })
    mocks.enqueueJob.mockResolvedValue('job-1')
    mocks.getJob.mockResolvedValue({ status: 'succeeded', result: { ok: true, orderId: 'order-1' } })
    mocks.secretConfigured.mockResolvedValue(true)
    mocks.validateUnlock.mockResolvedValue(true)
    mocks.createUnlock.mockResolvedValue('unlock-token')
    mocks.loadWorkbench.mockResolvedValue({
      ok: true,
      sourceStatus: { ok: true },
      accountMetrics: [],
      positions: [],
    })
    mocks.loadLiveDashboard.mockResolvedValue({
      ok: true,
      liveTradingEnabled: false,
      autoSubmitEnabled: false,
      autoCancelEnabled: false,
      marketableLimitTimeoutSeconds: 90,
      limitTimeoutSeconds: 600,
      brokerSyncIntervalSeconds: 30,
      modelReviewIntervalSeconds: 60,
      updatedAt: 'now',
    })
    mocks.listHistory.mockResolvedValue({ items: [], page: 1, pageSize: 12, total: 0, totalPages: 1 })
    mocks.loadConfig.mockReturnValue({ ok: true })
    mocks.getPendingOrder.mockResolvedValue(pendingOrder)
    mocks.rejectPendingOrder.mockResolvedValue({ ...pendingOrder, status: 'REJECTED_BY_USER' })
    mocks.expireOrders.mockResolvedValue([{ ...pendingOrder, status: 'REJECTED_BY_USER' }])
    mocks.query.mockResolvedValue([])
    mocks.queryOne.mockResolvedValue({ shadow_verified_at: new Date(), present: true })

    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      if (req.headers['x-no-user'] === 'true') {
        next()
        return
      }
      const role = req.headers['x-role']
      ;(req as typeof req & { multiUser: UserProfile }).multiUser = role === 'owner' ? owner : member
      next()
    })
    app.use(createMultiUserPrivateRouter())
    app.use((_req, res) => res.status(299).json({ fallback: true }))
    server = createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试端口不可用')
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(() => new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())))

  const request = (path: string, init: RequestInit = {}, role: 'owner' | 'member' = 'member') =>
    fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-role': role, ...init.headers },
    })

  it('返回当前会话并完成改密校验与审计', async () => {
    expect((await request('/multiuser/session')).status).toBe(200)
    mocks.validatePassword.mockReturnValueOnce('密码太弱')
    expect((await request('/multiuser/password/change', {
      method: 'POST', body: JSON.stringify({ currentPassword: 'current', newPassword: 'weak' }),
    })).status).toBe(400)
    expect((await request('/multiuser/password/change', {
      method: 'POST', body: JSON.stringify({ currentPassword: 'wrong', newPassword: 'new' }),
    })).status).toBe(400)
    mocks.verifyPassword.mockImplementation((value: string) => value === 'current' || value === 'same')
    expect((await request('/multiuser/password/change', {
      method: 'POST', body: JSON.stringify({ currentPassword: 'current', newPassword: 'same' }),
    })).status).toBe(400)
    mocks.verifyPassword.mockImplementation((value: string) => value === 'current')
    expect((await request('/multiuser/password/change', {
      method: 'POST', body: JSON.stringify({ currentPassword: 'current', newPassword: 'new' }),
      headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8', 'user-agent': 'vitest' },
    })).status).toBe(200)
    expect(mocks.changePassword).toHaveBeenCalledWith(member.userId, 'new')
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'password_changed', ip: '1.2.3.4' }))
  })

  it('覆盖 owner 用户管理成功与失败分支', async () => {
    expect((await request('/multiuser/users')).status).toBe(403)
    const users = await request('/multiuser/users', {}, 'owner')
    expect((await users.json()).users).toHaveLength(2)

    expect((await request('/multiuser/users', {
      method: 'POST', body: JSON.stringify({ username: 'x', temporaryPassword: 'valid' }),
    }, 'owner')).status).toBe(400)
    mocks.validatePassword.mockReturnValueOnce('密码太弱')
    expect((await request('/multiuser/users', {
      method: 'POST', body: JSON.stringify({ username: 'valid-user', temporaryPassword: 'weak' }),
    }, 'owner')).status).toBe(400)
    expect((await request('/multiuser/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'valid-user', displayName: '', temporaryPassword: 'valid' }),
    }, 'owner')).status).toBe(201)
    mocks.createMember.mockRejectedValueOnce(new Error('unique violation'))
    expect((await request('/multiuser/users', {
      method: 'POST', body: JSON.stringify({ username: 'duplicate', temporaryPassword: 'valid' }),
    }, 'owner')).status).toBe(409)
    mocks.createMember.mockRejectedValueOnce('db down')
    expect((await request('/multiuser/users', {
      method: 'POST', body: JSON.stringify({ username: 'broken', temporaryPassword: 'valid' }),
    }, 'owner')).status).toBe(500)

    expect((await request('/multiuser/users/member-1/status', {
      method: 'PUT', body: JSON.stringify({ active: false }),
    }, 'owner')).status).toBe(200)
    expect(mocks.disableConnection).toHaveBeenCalledWith('member-1')
    expect(mocks.evictContext).toHaveBeenCalledWith(connection.id)
    expect((await request('/multiuser/users/member-1/status', {
      method: 'PUT', body: JSON.stringify({ active: true }),
    }, 'owner')).status).toBe(200)

    mocks.validatePassword.mockReturnValueOnce('密码太弱')
    expect((await request('/multiuser/users/member-1/reset-password', {
      method: 'POST', body: JSON.stringify({ temporaryPassword: 'weak' }),
    }, 'owner')).status).toBe(400)
    expect((await request('/multiuser/users/member-1/reset-password', {
      method: 'POST', body: JSON.stringify({ temporaryPassword: 'valid' }),
    }, 'owner')).status).toBe(200)
  })

  it('仅允许 owner 审批或关闭成员长桥实盘门禁', async () => {
    expect((await request('/multiuser/users/member-1/longbridge-live-gate', {
      method: 'PUT',
      body: JSON.stringify({ enabled: true }),
    })).status).toBe(403)

    mocks.queryOne.mockResolvedValueOnce(null)
    expect((await request('/multiuser/users/member-1/longbridge-live-gate', {
      method: 'PUT',
      body: JSON.stringify({ enabled: true }),
    }, 'owner')).status).toBe(409)

    mocks.queryOne.mockResolvedValueOnce({
      user_id: member.userId,
      active: true,
      binding_id: connection.id,
    })
    expect((await request('/multiuser/users/member-1/longbridge-live-gate', {
      method: 'PUT',
      body: JSON.stringify({ enabled: true }),
    }, 'owner')).status).toBe(200)
    expect(mocks.query.mock.calls.some(([sql, params]) =>
      String(sql).includes('shadow_verified_at')
      && Array.isArray(params)
      && params[2] === 'live'
      && params[3] === true)).toBe(true)
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'longbridge_live_gate_approved',
      targetUserId: member.userId,
    }))
  })

  it('覆盖 Futu 配置、解锁、限流和锁定', async () => {
    expect(await (await request('/multiuser/futu/access')).json()).toMatchObject({ status: 'forbidden' })
    mocks.secretConfigured.mockResolvedValueOnce(false)
    expect(await (await request('/multiuser/futu/access', {}, 'owner')).json()).toMatchObject({ status: 'setup_required' })
    mocks.validateUnlock.mockResolvedValueOnce(false)
    expect(await (await request('/multiuser/futu/access', {}, 'owner')).json()).toMatchObject({ status: 'locked' })
    expect(await (await request('/multiuser/futu/access', {
      headers: { cookie: 'fa_futu_unlock=abc' },
    }, 'owner')).json()).toMatchObject({ status: 'unlocked' })

    expect((await request('/multiuser/futu/secondary-password', {
      method: 'POST', body: JSON.stringify({ currentPassword: 'current', secondaryPassword: 'secondary' }),
    }, 'owner')).status).toBe(200)
    mocks.setSecondaryPassword.mockRejectedValueOnce(new Error('设置失败'))
    expect((await request('/multiuser/futu/secondary-password', {
      method: 'POST', body: '{}',
    }, 'owner')).status).toBe(400)

    expect((await request('/multiuser/futu/unlock', {
      method: 'POST',
      body: JSON.stringify({ secondaryPassword: 'secondary' }),
      headers: { 'x-forwarded-for': '9.8.7.6', 'x-forwarded-proto': 'https' },
    }, 'owner')).status).toBe(200)
    for (let index = 0; index < 5; index += 1) {
      mocks.createUnlock.mockRejectedValueOnce(new Error(
        index === 0 ? 'FUTU_STEP_UP_SETUP_REQUIRED' : 'FUTU_SECONDARY_PASSWORD_INVALID',
      ))
      const response = await request('/multiuser/futu/unlock', {
        method: 'POST',
        body: '{}',
        headers: { 'x-forwarded-for': '6.6.6.6' },
      }, 'owner')
      expect(response.status).toBe(index === 0 ? 428 : 401)
    }
    expect((await request('/multiuser/futu/unlock', {
      method: 'POST', body: '{}', headers: { 'x-forwarded-for': '6.6.6.6' },
    }, 'owner')).status).toBe(429)
    expect((await request('/multiuser/futu/lock', {
      method: 'POST', headers: { cookie: 'fa_futu_unlock=abc' },
    }, 'owner')).status).toBe(200)
    expect(mocks.revokeUnlock).toHaveBeenCalledWith(owner.userId, 'abc')
  })

  it('覆盖 Longbridge 连接读写与错误分支', async () => {
    expect(await (await request('/multiuser/longbridge/connection')).json())
      .toMatchObject({ connection: { id: connection.id, accountFingerprint: 'fingerprint' } })
    mocks.getActiveConnection.mockResolvedValueOnce(null)
    expect(await (await request('/multiuser/longbridge/connection')).json()).toMatchObject({ connection: null })

    const credentials = { appKey: 'key', appSecret: 'secret', accessToken: 'token' }
    expect((await request('/multiuser/longbridge/connection/verify', {
      method: 'POST', body: JSON.stringify(credentials),
    })).status).toBe(200)
    mocks.validateCredentials.mockImplementationOnce(() => { throw new Error('凭据无效') })
    expect((await request('/multiuser/longbridge/connection/verify', {
      method: 'POST', body: '{}',
    })).status).toBe(400)

    expect((await request('/multiuser/longbridge/connection', {
      method: 'PUT', body: JSON.stringify(credentials),
    })).status).toBe(200)
    expect((await request('/multiuser/longbridge/connection', {
      method: 'PUT', body: JSON.stringify(credentials),
    }, 'owner')).status).toBe(200)
    expect(mocks.savePendingConnection).toHaveBeenLastCalledWith(owner.userId, credentials)
    mocks.getConnectionForVerification.mockResolvedValueOnce({ ...connection, status: 'pending' })
    expect((await request('/multiuser/longbridge/connection', {
      method: 'PUT', body: JSON.stringify(credentials),
    })).status).toBe(400)
    expect((await request('/multiuser/longbridge/connection', { method: 'DELETE' })).status).toBe(200)
  })

  it('覆盖租户只读看板、配置、设置、历史和托管订单', async () => {
    const gets = [
      '/longbridge/workbench/dashboard',
      '/longbridge/source/status',
      '/longbridge/realtime/status/subscription',
      '/longbridge/live-trading/dashboard',
      '/longbridge/live-trading/config',
      '/longbridge/live-trading/accounts',
      '/longbridge/live-trading/settings',
      '/longbridge/live-trading/history/signals?page=0&pageSize=500&ticker=aapl&direction=buy',
      '/longbridge/live-trading/history/pending-orders?status=pending_confirmation&side=buy',
      '/longbridge/live-trading/history/candidate-pool?statusGroup=active',
      '/longbridge/live-trading/managed-orders',
    ]
    mocks.query
      .mockResolvedValueOnce([{ payload: { id: 'managed-1' } }])
      .mockResolvedValueOnce([{
        id: 'event-1',
        order_id: 'order-1',
        event_type: 'auto_cancel_requested',
        detail: {},
        created_at: new Date(0),
      }])
    for (const path of gets) expect((await request(path)).status, path).toBe(200)
    expect((await request('/longbridge/live-trading/history/unsupported')).status).toBe(404)
    for (const path of [
      '/longbridge/live-trading/llm-config',
      '/longbridge/live-trading/trade-strategy-config',
    ]) {
      expect((await request(path, { method: 'PUT', body: '{}' })).status).toBe(409)
    }
    expect((await request('/longbridge/live-trading/settings', {
      method: 'PUT',
      body: JSON.stringify({ liveTradingEnabled: true, autoSubmitEnabled: true, autoCancelEnabled: true }),
    })).status).toBe(200)
    mocks.queryOne.mockResolvedValueOnce({
      shadow_verified_at: new Date(),
      live_trading_enabled: true,
      auto_submit_enabled: false,
      auto_cancel_enabled: false,
    })
    expect((await request('/longbridge/live-trading/settings', {
      method: 'PUT',
      body: JSON.stringify({ autoSubmitEnabled: true }),
    })).status).toBe(200)
    expect(mocks.query.mock.calls.some(([, params]) =>
      Array.isArray(params) && params[2] === true && params[3] === true)).toBe(true)
    mocks.queryOne.mockResolvedValueOnce({
      shadow_verified_at: null,
      live_trading_enabled: false,
      auto_submit_enabled: false,
      auto_cancel_enabled: false,
    })
    expect((await request('/longbridge/live-trading/settings', {
      method: 'PUT',
      body: JSON.stringify({ autoSubmitEnabled: true }),
    })).status).toBe(409)
  })

  it('覆盖租户订单、控制命令和待确认订单', async () => {
    expect((await request('/longbridge/live-trading/orders?page=2&pageSize=20&ticker=aapl&status=filled&side=buy')).status).toBe(200)
    expect((await request('/longbridge/live-trading/orders/order-1/detail?submittedAt=now')).status).toBe(200)
    expect((await request('/longbridge/live-trading/orders/order-1/cancel', { method: 'POST', body: '{}' })).status).toBe(200)
    mocks.queryOne.mockResolvedValueOnce({ present: false })
    expect((await request('/longbridge/live-trading/orders/foreign/cancel', { method: 'POST', body: '{}' })).status).toBe(403)
    for (const path of ['start', 'stop', 'run-once']) {
      expect((await request(`/longbridge/live-trading/${path}`, {
        method: 'POST', body: JSON.stringify({ symbol: '700' }),
      })).status).toBe(202)
    }

    expect((await request('/longbridge/live-trading/pending-orders/pending-1/confirm', {
      method: 'POST', body: '{}',
    })).status).toBe(200)
    mocks.getJob.mockResolvedValueOnce({ status: 'failed', error: '门禁关闭' })
    expect((await request('/longbridge/live-trading/pending-orders/pending-1/confirm', {
      method: 'POST', body: '{}',
    })).status).toBe(409)
    mocks.getPendingOrder.mockResolvedValueOnce(null)
    expect((await request('/longbridge/live-trading/pending-orders/missing/confirm', {
      method: 'POST', body: '{}',
    })).status).toBe(404)
    expect((await request('/longbridge/live-trading/pending-orders/pending-1/reject', {
      method: 'POST', body: '{}',
    })).status).toBe(200)
    mocks.rejectPendingOrder.mockResolvedValueOnce(null)
    expect((await request('/longbridge/live-trading/pending-orders/missing/reject', {
      method: 'POST', body: '{}',
    })).status).toBe(404)
    expect((await request('/longbridge/live-trading/pending-orders/batch-expire', {
      method: 'POST', body: JSON.stringify({ ids: ['pending-1'], ticker: 'AAPL', side: 'BUY' }),
    })).status).toBe(200)
  })

  it('覆盖连接缺失、无效、依赖异常和 owner 回落', async () => {
    expect((await request('/longbridge/workbench/dashboard', {
      headers: { 'x-no-user': 'true' },
    })).status).toBe(401)
    mocks.getActiveConnection.mockResolvedValueOnce(null)
    expect((await request('/longbridge/workbench/dashboard')).status).toBe(428)
    mocks.getActiveConnection.mockResolvedValueOnce({ ...connection, status: 'invalid' })
    expect((await request('/longbridge/workbench/dashboard')).status).toBe(409)
    mocks.getActiveConnection.mockRejectedValueOnce(new Error('database down'))
    expect((await request('/longbridge/workbench/dashboard')).status).toBe(500)
    expect((await request('/longbridge/workbench/dashboard', {}, 'owner')).status).toBe(299)
    expect((await request('/longbridge/not-available')).status).toBe(404)
    expect((await request('/longbridge/not-available', {}, 'owner')).status).toBe(299)
  })

  it('覆盖订单参数映射、任务不存在和不允许实盘设置', async () => {
    mocks.getPendingOrder.mockResolvedValueOnce({
      ...pendingOrder,
      intent: {
        ...pendingOrder.intent,
        ticker: '00700',
        side: 'SELL',
        orderType: 'LIMIT',
      },
    })
    expect((await request('/longbridge/live-trading/pending-orders/pending-1/confirm', {
      method: 'POST', body: '{}',
    })).status).toBe(200)
    expect(mocks.enqueueJob).toHaveBeenLastCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ symbol: '700.HK', side: 'SELL', orderType: 'LO' }),
    }))

    mocks.getPendingOrder.mockResolvedValueOnce({
      ...pendingOrder,
      intent: { ...pendingOrder.intent, ticker: 'TSLA.US' },
    })
    expect((await request('/longbridge/live-trading/pending-orders/pending-1/confirm', {
      method: 'POST', body: '{}',
    })).status).toBe(200)
    expect(mocks.enqueueJob).toHaveBeenLastCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ symbol: 'TSLA.US' }),
    }))

    mocks.getJob.mockResolvedValueOnce(null)
    expect((await request('/longbridge/live-trading/orders')).status).toBe(500)

    mocks.queryOne.mockResolvedValueOnce(null)
    expect((await request('/longbridge/live-trading/settings', {
      method: 'PUT',
      body: JSON.stringify({ liveTradingEnabled: true }),
    })).status).toBe(200)
    const settingsParams = mocks.query.mock.calls.at(-1)?.[1] as unknown[]
    expect(settingsParams[2]).toBe(false)

    process.env.CLOUD_COOKIE_SECURE = 'true'
    const locked = await request('/multiuser/futu/lock', { method: 'POST' }, 'owner')
    expect(locked.headers.get('set-cookie')).toContain('Secure')
  })
})
