import { createServer, type Server } from 'node:http'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(() => true),
  authenticate: vi.fn(),
  verifyToken: vi.fn(),
  revoke: vi.fn(),
}))

vi.mock('../../api/cloud/multiuser/auth/multiUserAuthService.js', () => ({
  multiUserEnabled: mocks.enabled,
  authenticateMultiUser: mocks.authenticate,
}))
vi.mock('../../api/cloud/auth/jwt.js', () => ({ verifyToken: mocks.verifyToken }))
vi.mock('../../api/cloud/multiuser/futu/futuStepUpService.js', () => ({
  revokeFutuUnlock: mocks.revoke,
}))

import { createMultiUserPublicRouter } from '../../api/cloud/multiuser/http/publicAuthRouter.js'

describe('多用户公开认证路由', () => {
  let server: Server
  let baseUrl: string

  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.enabled.mockReturnValue(true)
    mocks.revoke.mockResolvedValue(undefined)
    const app = express()
    app.set('trust proxy', true)
    app.use(express.json())
    app.use(createMultiUserPublicRouter())
    app.use((_req, res) => res.status(418).json({ fallback: true }))
    server = createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试端口不可用')
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(() => new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())))

  it('关闭开关时回落旧路由', async () => {
    mocks.enabled.mockReturnValue(false)
    const response = await fetch(`${baseUrl}/auth/login`, { method: 'POST' })
    expect(response.status).toBe(418)
  })

  it('登录成功设置 HttpOnly、SameSite Cookie 且不泄漏 token', async () => {
    mocks.authenticate.mockResolvedValue({
      ok: true,
      token: 'secret-token',
      profile: { userId: '1', username: 'owner', displayName: '所有者', role: 'owner' },
    })
    const response = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: ' owner ', password: 'Password1234' }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toContain('HttpOnly')
    expect(response.headers.get('set-cookie')).toContain('SameSite=Strict')
    expect(JSON.stringify(await response.json())).not.toContain('secret-token')
    expect(mocks.authenticate).toHaveBeenCalledWith('owner', 'Password1234', expect.any(String), expect.anything())
  })

  it('HTTPS 登录设置 Secure Cookie', async () => {
    mocks.authenticate.mockResolvedValue({
      ok: true,
      token: 'secret-token',
      profile: { userId: '1', username: 'owner', displayName: '所有者', role: 'owner' },
    })
    const response = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-proto': 'https',
        'x-forwarded-for': '10.0.0.1',
      },
      body: JSON.stringify({ username: 'owner', password: 'Password1234' }),
    })
    expect(response.headers.get('set-cookie')).toContain('Secure')
  })

  it('认证失败返回统一中文错误', async () => {
    mocks.authenticate.mockResolvedValue({ ok: false, error: '用户名或密码错误' })
    const response = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ success: false, error: '用户名或密码错误' })
  })

  it('依赖异常时 fail closed', async () => {
    mocks.authenticate.mockRejectedValue(new Error('database unavailable'))
    const response = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(503)
  })

  it('退出同时撤销 Futu 会话并清除两个 Cookie', async () => {
    mocks.verifyToken.mockReturnValue({ sub: '1' })
    const response = await fetch(`${baseUrl}/auth/logout`, {
      method: 'POST',
      headers: { cookie: 'fa_session=session; fa_futu_unlock=unlock' },
    })
    expect(response.status).toBe(200)
    expect(mocks.revoke).toHaveBeenCalledWith('1', 'unlock')
    const cookies = response.headers.getSetCookie()
    expect(cookies).toHaveLength(2)
    expect(cookies.join(' ')).toContain('fa_session=')
    expect(cookies.join(' ')).toContain('fa_futu_unlock=')
    expect(cookies.every((value) => value.includes('Max-Age=0'))).toBe(true)
  })

  it('退出在无会话、撤销失败或功能关闭时仍有确定行为', async () => {
    mocks.verifyToken.mockReturnValueOnce(null)
    expect((await fetch(`${baseUrl}/auth/logout`, { method: 'POST' })).status).toBe(200)
    expect(mocks.revoke).not.toHaveBeenCalled()

    mocks.verifyToken.mockReturnValueOnce({ sub: '1' })
    mocks.revoke.mockRejectedValueOnce(new Error('database unavailable'))
    expect((await fetch(`${baseUrl}/auth/logout`, {
      method: 'POST', headers: { cookie: 'fa_session=session' },
    })).status).toBe(200)

    mocks.enabled.mockReturnValue(false)
    expect((await fetch(`${baseUrl}/auth/logout`, { method: 'POST' })).status).toBe(418)
  })

  it('同一地址连续失败十次后返回 429', async () => {
    mocks.authenticate.mockResolvedValue({ ok: false, error: '用户名或密码错误' })
    for (let index = 0; index < 10; index += 1) {
      const response = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.99' },
        body: '{}',
      })
      expect(response.status).toBe(401)
    }
    const limited = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.99' },
      body: '{}',
    })
    expect(limited.status).toBe(429)
    expect(mocks.authenticate).toHaveBeenCalledTimes(10)
  })
})
