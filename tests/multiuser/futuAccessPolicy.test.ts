import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextFunction, Response } from 'express'
import type { MultiUserRequest, UserProfile } from '../../api/cloud/multiuser/types.js'

const mocks = vi.hoisted(() => ({
  multiUserEnabled: vi.fn(() => true),
  futuSecretConfigured: vi.fn(),
  validateFutuUnlock: vi.fn(),
  futuUnlockMaxAgeSeconds: vi.fn(() => 600),
}))

vi.mock('../../api/cloud/multiuser/auth/multiUserAuthService.js', () => ({
  multiUserEnabled: mocks.multiUserEnabled,
}))

vi.mock('../../api/cloud/multiuser/futu/futuStepUpService.js', () => ({
  futuSecretConfigured: mocks.futuSecretConfigured,
  validateFutuUnlock: mocks.validateFutuUnlock,
  futuUnlockMaxAgeSeconds: mocks.futuUnlockMaxAgeSeconds,
}))

import { enforceFutuAccess } from '../../api/cloud/multiuser/futu/futuAccessPolicy.js'

const owner: UserProfile = {
  userId: '1',
  username: 'owner',
  displayName: 'caoshaokun',
  role: 'owner',
  active: true,
  mustChangePassword: false,
  sessionsValidAfter: new Date(0).toISOString(),
}

function request(profile: UserProfile, path = '/account/dashboard', cookie?: string) {
  return {
    path,
    protocol: 'https',
    headers: cookie ? { cookie } : {},
    multiUser: profile,
  } as MultiUserRequest
}

function response() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    append: vi.fn().mockReturnThis(),
  } as unknown as Response
}

describe('Futu 服务端门禁', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.multiUserEnabled.mockReturnValue(true)
    mocks.futuSecretConfigured.mockResolvedValue(true)
    mocks.validateFutuUnlock.mockResolvedValue(false)
  })

  it.each([
    '/live-trading/dashboard',
    '/live-trading/history/signals',
    '/account/dashboard',
    '/source/status',
    '/cloud/worker-status',
    '/reports/latest',
    '/opportunities',
    '/a-share/dashboard',
  ])('member 请求 %s 时在访问数据库前直接返回 403', async (path) => {
    const req = request({ ...owner, userId: '2', role: 'member' }, path)
    const res = response()
    const next: NextFunction = vi.fn()

    await enforceFutuAccess(req, res, next)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'FUTU_FORBIDDEN' }))
    expect(mocks.futuSecretConfigured).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  it('owner 未设置二次密码时返回 428', async () => {
    mocks.futuSecretConfigured.mockResolvedValue(false)
    const res = response()
    const next: NextFunction = vi.fn()

    await enforceFutuAccess(request(owner), res, next)

    expect(res.status).toHaveBeenCalledWith(428)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'FUTU_STEP_UP_SETUP_REQUIRED',
    }))
  })

  it('owner 未解锁时返回 423 且不放行', async () => {
    const res = response()
    const next: NextFunction = vi.fn()

    await enforceFutuAccess(request(owner), res, next)

    expect(res.status).toHaveBeenCalledWith(423)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'FUTU_LOCKED' }))
    expect(next).not.toHaveBeenCalled()
  })

  it('有效解锁会话放行并滑动续期 Cookie', async () => {
    mocks.validateFutuUnlock.mockResolvedValue(true)
    const res = response()
    const next: NextFunction = vi.fn()

    await enforceFutuAccess(
      request(owner, '/live-trading/dashboard', 'fa_futu_unlock=opaque-token'),
      res,
      next,
    )

    expect(next).toHaveBeenCalledTimes(1)
    expect(res.append).toHaveBeenCalledWith(
      'Set-Cookie',
      expect.stringContaining('Max-Age=600'),
    )
    expect(res.append).toHaveBeenCalledWith(
      'Set-Cookie',
      expect.stringContaining('Secure'),
    )
  })

  it('门禁依赖异常时 fail closed 返回 503', async () => {
    mocks.futuSecretConfigured.mockRejectedValue(new Error('database unavailable'))
    const res = response()
    const next: NextFunction = vi.fn()

    await enforceFutuAccess(request(owner), res, next)

    expect(res.status).toHaveBeenCalledWith(503)
    expect(next).not.toHaveBeenCalled()
  })

  it('非 Futu 路由不触发二次验证', async () => {
    const res = response()
    const next: NextFunction = vi.fn()

    await enforceFutuAccess(request(owner, '/longbridge/workbench/dashboard'), res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(mocks.futuSecretConfigured).not.toHaveBeenCalled()
  })
})
