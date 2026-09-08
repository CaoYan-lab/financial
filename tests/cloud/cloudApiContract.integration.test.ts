import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCloudApp } from '../../api/cloud/http/cloudWebApp.js'
import { closePool, query, queryOne } from '../../api/cloud/db/pgClient.js'
import { hashPassword } from '../../api/cloud/multiuser/auth/passwordService.js'

const enabled = process.env.RUN_PG_INTEGRATION === '1'
const describePg = enabled ? describe : describe.skip

describePg('云端 API 鉴权与数据隔离合约', () => {
  let server: Server
  let baseUrl: string
  let memberCookie = ''
  let ownerCookie = ''

  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toContain('/financial_test')
    process.env.MULTIUSER_ENABLED = 'true'
    process.env.AUTH_ENABLED = 'true'
    process.env.CLOUD_COOKIE_SECURE = 'false'
    process.env.AUTH_JWT_SECRET = 'integration-jwt-secret-at-least-32-bytes'
    process.env.MULTIUSER_OWNER_USERNAME = 'api_owner'
    await query(
      `INSERT INTO cloud_users (username, password_hash)
       VALUES ('api_owner', $1), ('api_member', $2)`,
      [hashPassword('OwnerPassword12'), hashPassword('MemberPassword12')],
    )
    const member = await queryOne<{ id: string }>("SELECT id FROM cloud_users WHERE username='api_member'")
    await query(
      `INSERT INTO multiuser.user_profiles
         (user_id, display_name, role, active, must_change_password, created_by)
       VALUES ($1, '接口成员', 'member', TRUE, FALSE, $1)`,
      [member!.id],
    )
    server = createServer(createCloudApp())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试端口不可用')
    baseUrl = `http://127.0.0.1:${address.port}`
    memberCookie = await login('api_member', 'MemberPassword12')
    ownerCookie = await login('api_owner', 'OwnerPassword12')
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()))
    await closePool()
  })

  async function login(username: string, password: string): Promise<string> {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    expect(response.status).toBe(200)
    return response.headers.get('set-cookie')!.split(';')[0]
  }

  it('公开接口可访问，私有接口未登录统一返回 401', async () => {
    expect((await fetch(`${baseUrl}/api/health`)).status).toBe(200)
    expect((await fetch(`${baseUrl}/api/auth/config`)).status).toBe(200)
    for (const path of ['/api/auth/me', '/api/multiuser/session', '/api/account/dashboard']) {
      const response = await fetch(`${baseUrl}${path}`)
      expect(response.status, path).toBe(401)
    }
  })

  it('owner 与 member 登录态返回各自身份', async () => {
    const owner = await fetch(`${baseUrl}/api/multiuser/session`, { headers: { cookie: ownerCookie } })
    const member = await fetch(`${baseUrl}/api/multiuser/session`, { headers: { cookie: memberCookie } })
    expect((await owner.json()).profile).toMatchObject({ username: 'api_owner', role: 'owner' })
    expect((await member.json()).profile).toMatchObject({ username: 'api_member', role: 'member' })
  })

  it('member 对全部 Futu 数据入口在业务读取前返回 403', async () => {
    const paths = [
      '/api/live-trading/dashboard',
      '/api/live-trading/accounts',
      '/api/live-trading/settings',
      '/api/live-trading/history/signals',
      '/api/live-trading/futu-orders',
      '/api/live-trading/futu-orders/order-1/detail',
      '/api/live-trading/managed-orders',
      '/api/account/dashboard',
      '/api/account/summary',
      '/api/account/positions',
      '/api/source/status',
      '/api/cloud/worker-status',
      '/api/a-share/dashboard',
      '/api/report/latest',
    ]
    for (const path of paths) {
      const response = await fetch(`${baseUrl}${path}`, { headers: { cookie: memberCookie } })
      const body = await response.text()
      expect(response.status, path).toBe(403)
      expect(body, path).toContain('FUTU_FORBIDDEN')
      expect(body, path).not.toMatch(/accountId|buyingPower|accessToken|appSecret/)
    }
  })

  it('member 的 owner 管理接口返回 403', async () => {
    for (const request of [
      fetch(`${baseUrl}/api/multiuser/users`, { headers: { cookie: memberCookie } }),
      fetch(`${baseUrl}/api/multiuser/users`, {
        method: 'POST',
        headers: { cookie: memberCookie, 'content-type': 'application/json' },
        body: '{}',
      }),
    ]) {
      expect((await request).status).toBe(403)
    }
  })

  it('owner 未设置 Futu 二次密码时所有数据入口返回 428', async () => {
    for (const path of ['/api/account/dashboard', '/api/live-trading/dashboard', '/api/cloud/worker-status']) {
      const response = await fetch(`${baseUrl}${path}`, { headers: { cookie: ownerCookie } })
      expect(response.status, path).toBe(428)
      expect(await response.json()).toMatchObject({ code: 'FUTU_STEP_UP_SETUP_REQUIRED' })
    }
  })

  it('member 未绑定 Longbridge 时返回 428，未知 Longbridge 路由不回落', async () => {
    const dashboard = await fetch(`${baseUrl}/api/longbridge/workbench/dashboard`, {
      headers: { cookie: memberCookie },
    })
    expect(dashboard.status).toBe(428)
    const unknown = await fetch(`${baseUrl}/api/longbridge/private-global-endpoint`, {
      headers: { cookie: memberCookie },
    })
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toMatchObject({ code: 'TENANT_ROUTE_NOT_AVAILABLE' })
  })

  it('退出清除会话和二次验证 Cookie', async () => {
    const response = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie: `${ownerCookie}; fa_futu_unlock=fake` },
    })
    expect(response.status).toBe(200)
    const cookies = response.headers.getSetCookie()
    expect(cookies).toHaveLength(2)
    expect(cookies.every((cookie) => cookie.includes('HttpOnly') && cookie.includes('SameSite=Strict'))).toBe(true)
  })
})
