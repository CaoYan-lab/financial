import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextFunction, Response } from 'express'
import type { MultiUserRequest, UserProfile } from '../../api/cloud/multiuser/types.js'

const mocks = vi.hoisted(() => ({
  multiUserEnabled: vi.fn(() => true),
  ensureOwnerProfile: vi.fn(),
  getProfile: vi.fn(),
}))

vi.mock('../../api/cloud/multiuser/auth/multiUserAuthService.js', () => ({
  multiUserEnabled: mocks.multiUserEnabled,
}))

vi.mock('../../api/cloud/multiuser/auth/profileStore.js', () => ({
  ensureOwnerProfile: mocks.ensureOwnerProfile,
  getProfile: mocks.getProfile,
}))

import { attachMultiUserContext } from '../../api/cloud/multiuser/auth/securityContext.js'

const profile: UserProfile = {
  userId: '7',
  username: 'member',
  displayName: '成员',
  role: 'member',
  active: true,
  mustChangePassword: false,
  sessionsValidAfter: new Date(0).toISOString(),
}

function request(path = '/longbridge/workbench/dashboard'): MultiUserRequest {
  return {
    path,
    headers: {},
    user: {
      sub: '7',
      username: 'member',
      iat: 2_000_000_000,
      exp: 2_000_100_000,
    },
  } as MultiUserRequest
}

function response() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response
}

describe('多用户安全上下文', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.multiUserEnabled.mockReturnValue(true)
    mocks.getProfile.mockResolvedValue(profile)
  })

  it('加载活动用户并写入请求上下文', async () => {
    const req = request()
    const res = response()
    const next: NextFunction = vi.fn()

    await attachMultiUserContext(req, res, next)

    expect(req.multiUser).toEqual(profile)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('健康检查无需用户上下文即可放行', async () => {
    const req = request('/health')
    delete req.user
    const next: NextFunction = vi.fn()

    await attachMultiUserContext(req, response(), next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(mocks.getProfile).not.toHaveBeenCalled()
  })

  it('功能关闭时直接放行，缺少 JWT 时返回 401', async () => {
    mocks.multiUserEnabled.mockReturnValueOnce(false)
    const disabledNext: NextFunction = vi.fn()
    await attachMultiUserContext(request(), response(), disabledNext)
    expect(disabledNext).toHaveBeenCalledTimes(1)

    const req = request()
    delete req.user
    const res = response()
    await attachMultiUserContext(req, res, vi.fn())
    expect(res.status).toHaveBeenCalledWith(401)
  })

  it('首次找不到资料时初始化 owner 后重新读取', async () => {
    mocks.getProfile.mockResolvedValueOnce(null).mockResolvedValueOnce(profile)
    const next: NextFunction = vi.fn()
    await attachMultiUserContext(request(), response(), next)
    expect(mocks.ensureOwnerProfile).toHaveBeenCalledTimes(1)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('初始化后仍无资料时返回 403', async () => {
    mocks.getProfile.mockResolvedValue(null)
    const res = response()
    await attachMultiUserContext(request(), res, vi.fn())
    expect(res.status).toHaveBeenCalledWith(403)
  })

  it('禁用用户返回 403', async () => {
    mocks.getProfile.mockResolvedValue({ ...profile, active: false })
    const res = response()
    const next: NextFunction = vi.fn()

    await attachMultiUserContext(request(), res, next)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(next).not.toHaveBeenCalled()
  })

  it('密码重置时间晚于 JWT 签发时间时撤销会话', async () => {
    mocks.getProfile.mockResolvedValue({
      ...profile,
      sessionsValidAfter: new Date((2_000_000_000 + 1) * 1_000).toISOString(),
    })
    const res = response()
    const next: NextFunction = vi.fn()

    await attachMultiUserContext(request(), res, next)

    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'SESSION_REVOKED' }))
    expect(next).not.toHaveBeenCalled()
  })

  it('同一秒内重新登录的 JWT 不会因数据库毫秒精度被误撤销', async () => {
    mocks.getProfile.mockResolvedValue({
      ...profile,
      sessionsValidAfter: new Date(2_000_000_000 * 1_000 + 999).toISOString(),
    })
    const next: NextFunction = vi.fn()

    await attachMultiUserContext(request(), response(), next)

    expect(next).toHaveBeenCalledTimes(1)
  })

  it('首次改密状态仅允许改密相关路径', async () => {
    mocks.getProfile.mockResolvedValue({ ...profile, mustChangePassword: true })
    const blockedRes = response()
    const blockedNext: NextFunction = vi.fn()

    await attachMultiUserContext(request(), blockedRes, blockedNext)

    expect(blockedRes.status).toHaveBeenCalledWith(428)
    expect(blockedNext).not.toHaveBeenCalled()

    const allowedRes = response()
    const allowedNext: NextFunction = vi.fn()
    await attachMultiUserContext(request('/multiuser/password/change'), allowedRes, allowedNext)
    expect(allowedNext).toHaveBeenCalledTimes(1)
  })

  it('数据库异常时返回 503 且不放行', async () => {
    mocks.getProfile.mockRejectedValue(new Error('database unavailable'))
    const res = response()
    const next: NextFunction = vi.fn()

    await attachMultiUserContext(request(), res, next)

    expect(res.status).toHaveBeenCalledWith(503)
    expect(next).not.toHaveBeenCalled()
  })
})
