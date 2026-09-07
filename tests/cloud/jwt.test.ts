import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { signToken, verifyToken } from '../../api/cloud/auth/jwt.js'

describe('云端 JWT 签发与校验', () => {
  const originalSecret = process.env.AUTH_JWT_SECRET

  beforeEach(() => {
    process.env.AUTH_JWT_SECRET = 'test-secret-at-least-16-chars'
  })

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.AUTH_JWT_SECRET
    else process.env.AUTH_JWT_SECRET = originalSecret
  })

  it('合法 token 可验签并还原载荷', () => {
    const token = signToken({ sub: '1', username: 'admin' })
    const payload = verifyToken(token)
    expect(payload).not.toBeNull()
    expect(payload?.username).toBe('admin')
    expect(payload?.sub).toBe('1')
  })

  it('篡改签名后校验失败', () => {
    const token = signToken({ sub: '1', username: 'admin' })
    const tampered = token.slice(0, -2) + (token.endsWith('a') ? 'b' : 'a')
    expect(verifyToken(tampered)).toBeNull()
  })

  it('密钥变更后旧 token 校验失败', () => {
    const token = signToken({ sub: '1', username: 'admin' })
    process.env.AUTH_JWT_SECRET = 'another-secret-at-least-16-chars'
    expect(verifyToken(token)).toBeNull()
  })

  it('过期 token 校验失败', () => {
    const token = signToken({ sub: '1', username: 'admin' }, -1)
    expect(verifyToken(token)).toBeNull()
  })

  it('非法格式 token 校验失败', () => {
    expect(verifyToken('not-a-jwt')).toBeNull()
    expect(verifyToken('a.b')).toBeNull()
    expect(verifyToken('')).toBeNull()
  })
})
