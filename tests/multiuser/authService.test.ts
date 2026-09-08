import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  sign: vi.fn(() => 'jwt-token'),
  verifyPassword: vi.fn(),
  ensureOwner: vi.fn(),
  getProfile: vi.fn(),
  audit: vi.fn(),
}))

vi.mock('../../api/cloud/db/pgClient.js', () => ({ query: mocks.query, queryOne: mocks.queryOne }))
vi.mock('../../api/cloud/auth/jwt.js', () => ({ signToken: mocks.sign }))
vi.mock('../../api/cloud/multiuser/auth/passwordService.js', () => ({ verifyPassword: mocks.verifyPassword }))
vi.mock('../../api/cloud/multiuser/auth/profileStore.js', () => ({
  ensureOwnerProfile: mocks.ensureOwner,
  getProfile: mocks.getProfile,
}))
vi.mock('../../api/cloud/multiuser/audit/securityAuditStore.js', () => ({
  writeSecurityAudit: mocks.audit,
}))

import { authenticateMultiUser, multiUserEnabled } from '../../api/cloud/multiuser/auth/multiUserAuthService.js'

const profile = {
  userId: '1', username: 'member', displayName: '成员', role: 'member' as const,
  active: true, mustChangePassword: false, sessionsValidAfter: new Date(0).toISOString(),
}

describe('多用户认证服务', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.query.mockResolvedValue([])
    mocks.audit.mockResolvedValue(undefined)
  })

  it('严格按 true 开启功能', () => {
    process.env.MULTIUSER_ENABLED = 'true'
    expect(multiUserEnabled()).toBe(true)
    process.env.MULTIUSER_ENABLED = 'TRUE'
    expect(multiUserEnabled()).toBe(false)
  })

  it('用户不存在或密码错误时记录失败审计', async () => {
    mocks.queryOne.mockResolvedValueOnce(null)
    await expect(authenticateMultiUser('missing', 'bad', '1.2.3.4', 'ua'))
      .resolves.toEqual({ ok: false, error: '用户名或密码错误' })
    mocks.queryOne.mockResolvedValueOnce({ id: '1', username: 'member', password_hash: 'hash' })
    mocks.verifyPassword.mockReturnValueOnce(false)
    await expect(authenticateMultiUser('member', 'bad')).resolves.toMatchObject({ ok: false })
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'login_failed' }))
  })

  it('资料缺失或禁用时阻止登录', async () => {
    mocks.queryOne.mockResolvedValue({ id: '1', username: 'member', password_hash: 'hash' })
    mocks.verifyPassword.mockReturnValue(true)
    mocks.getProfile.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...profile, active: false })
    await expect(authenticateMultiUser('member', 'password')).resolves.toMatchObject({ error: '账号未启用' })
    await expect(authenticateMultiUser('member', 'password')).resolves.toMatchObject({ error: '账号未启用' })
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'login_blocked' }))
  })

  it('登录成功更新最后登录时间并签发 JWT', async () => {
    mocks.queryOne.mockResolvedValue({ id: '1', username: 'member', password_hash: 'hash' })
    mocks.verifyPassword.mockReturnValue(true)
    mocks.getProfile.mockResolvedValue(profile)
    await expect(authenticateMultiUser('member', 'password')).resolves.toEqual({
      ok: true, token: 'jwt-token', profile,
    })
    expect(mocks.ensureOwner).toHaveBeenCalled()
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('last_login_at'), ['1'])
    expect(mocks.sign).toHaveBeenCalledWith({ sub: '1', username: 'member' })
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'login_success' }))
  })
})
