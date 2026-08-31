import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextFunction, Request, Response } from 'express'
import { requireAuth } from '../../api/cloud/auth/requireAuth.js'
import { signToken } from '../../api/cloud/auth/jwt.js'

function mockReqRes(overrides: Partial<Request> = {}) {
  const req = {
    path: '/live-trading/dashboard',
    headers: {},
    ...overrides,
  } as unknown as Request
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response
  const next: NextFunction = vi.fn()
  return { req, res, next }
}

describe('云端鉴权中间件 requireAuth', () => {
  const originalEnabled = process.env.AUTH_ENABLED
  const originalSecret = process.env.AUTH_JWT_SECRET

  beforeEach(() => {
    process.env.AUTH_JWT_SECRET = 'test-secret-at-least-16-chars'
  })

  afterEach(() => {
    process.env.AUTH_ENABLED = originalEnabled
    if (originalSecret === undefined) delete process.env.AUTH_JWT_SECRET
    else process.env.AUTH_JWT_SECRET = originalSecret
  })

  it('AUTH_ENABLED 未开启时直接放行', () => {
    delete process.env.AUTH_ENABLED
    const { req, res, next } = mockReqRes()
    requireAuth(req, res, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(res.status).not.toHaveBeenCalled()
  })

  it('开启鉴权后无 token 返回 401', () => {
    process.env.AUTH_ENABLED = 'true'
    const { req, res, next } = mockReqRes()
    requireAuth(req, res, next)
    expect(res.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('健康检查与登录接口豁免鉴权', () => {
    process.env.AUTH_ENABLED = 'true'
    for (const path of ['/health', '/auth/login']) {
      const { req, res, next } = mockReqRes({ path } as Partial<Request>)
      requireAuth(req, res, next)
      expect(next).toHaveBeenCalledTimes(1)
    }
  })

  it('Bearer token 合法时放行并写入用户', () => {
    process.env.AUTH_ENABLED = 'true'
    const token = signToken({ sub: '7', username: 'admin' })
    const { req, res, next } = mockReqRes({
      headers: { authorization: `Bearer ${token}` },
    } as Partial<Request>)
    requireAuth(req as Request & { user?: unknown }, res, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect((req as unknown as { user?: { username: string } }).user?.username).toBe('admin')
  })

  it('Cookie token 合法时放行', () => {
    process.env.AUTH_ENABLED = 'true'
    const token = signToken({ sub: '7', username: 'admin' })
    const { req, res, next } = mockReqRes({
      headers: { cookie: `fa_session=${encodeURIComponent(token)}` },
    } as Partial<Request>)
    requireAuth(req, res, next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('伪造 token 返回 401', () => {
    process.env.AUTH_ENABLED = 'true'
    const { req, res, next } = mockReqRes({
      headers: { authorization: 'Bearer fake.token.value' },
    } as Partial<Request>)
    requireAuth(req, res, next)
    expect(res.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })
})
