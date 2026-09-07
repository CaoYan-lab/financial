import { createHmac, timingSafeEqual } from 'node:crypto'

export type JwtPayload = {
  sub: string
  username: string
  iat: number
  exp: number
}

const BASE64_REPLACER = /[=]+$/g

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url').replace(BASE64_REPLACER, '')
}

function secret(): string {
  const value = process.env.AUTH_JWT_SECRET
  if (!value || value.length < 16) {
    throw new Error('AUTH_JWT_SECRET 未配置或长度不足（至少 16 字符）')
  }
  return value
}

export function signToken(payload: Omit<JwtPayload, 'iat' | 'exp'>, ttlSeconds = 12 * 3600): string {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const fullPayload: JwtPayload = {
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  }
  const body = base64Url(JSON.stringify(fullPayload))
  const signature = createHmac('sha256', secret()).update(`${header}.${body}`).digest('base64url')
  return `${header}.${body}.${signature}`
}

export function verifyToken(token: string): JwtPayload | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [header, body, signature] = parts
  const expected = createHmac('sha256', secret()).update(`${header}.${body}`).digest('base64url')
  const signatureBuffer = Buffer.from(signature)
  const expectedBuffer = Buffer.from(expected)
  if (signatureBuffer.length !== expectedBuffer.length || !timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null
  }
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as JwtPayload
    if (!payload.sub || !payload.username) return null
    if (payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload
  } catch {
    return null
  }
}
