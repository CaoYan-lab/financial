import { Router, type Request, type Response } from 'express'
import { verifyToken } from '../../auth/jwt.js'
import { authenticateMultiUser, multiUserEnabled } from '../auth/multiUserAuthService.js'
import { readCookie } from '../futu/futuAccessPolicy.js'
import { revokeFutuUnlock } from '../futu/futuStepUpService.js'

const SESSION_MAX_AGE_SECONDS = 12 * 3600
const attempts = new Map<string, { count: number; resetAt: number }>()

function ip(req: Request): string {
  const forwarded = req.headers['x-forwarded-for']
  return typeof forwarded === 'string'
    ? forwarded.split(',')[0].trim()
    : req.ip || req.socket.remoteAddress || 'unknown'
}

function loginLimited(address: string): boolean {
  const now = Date.now()
  const current = attempts.get(address)
  if (!current || current.resetAt <= now) return false
  return current.count >= 10
}

function recordLoginFailure(address: string): void {
  const now = Date.now()
  const current = attempts.get(address)
  if (!current || current.resetAt <= now) {
    attempts.set(address, { count: 1, resetAt: now + 5 * 60_000 })
    return
  }
  current.count += 1
}

function secure(req: Request): boolean {
  return req.protocol === 'https' || process.env.CLOUD_COOKIE_SECURE === 'true'
}

function cookie(name: string, value: string, maxAge: number, isSecure: boolean): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=Strict',
  ]
  if (isSecure) parts.push('Secure')
  return parts.join('; ')
}

export function createMultiUserPublicRouter(): Router {
  const router = Router()

  router.post('/auth/login', async (req: Request, res: Response, next) => {
    if (!multiUserEnabled()) {
      next()
      return
    }
    const address = ip(req)
    if (loginLimited(address)) {
      res.status(429).json({ success: false, error: '登录尝试过于频繁，请稍后再试' })
      return
    }
    const body = req.body as { username?: string; password?: string }
    try {
      const result = await authenticateMultiUser(
        String(body?.username ?? '').trim(),
        String(body?.password ?? ''),
        address,
        req.headers['user-agent'],
      )
      if (!result.ok) {
        recordLoginFailure(address)
        res.status(401).json({
          success: false,
          error: 'error' in result ? result.error : '登录失败',
        })
        return
      }
      attempts.delete(address)
      res.setHeader('Set-Cookie', cookie('fa_session', result.token, SESSION_MAX_AGE_SECONDS, secure(req)))
      res.json({
        success: true,
        username: result.profile.username,
        profile: result.profile,
      })
    } catch {
      res.status(503).json({ success: false, error: '多用户登录服务暂不可用' })
    }
  })

  router.post('/auth/logout', async (req: Request, res: Response, next) => {
    if (!multiUserEnabled()) {
      next()
      return
    }
    const session = readCookie(req, 'fa_session')
    const payload = session ? verifyToken(session) : null
    if (payload) {
      await revokeFutuUnlock(payload.sub, readCookie(req, 'fa_futu_unlock')).catch(() => undefined)
    }
    res.append('Set-Cookie', cookie('fa_session', '', 0, secure(req)))
    res.append('Set-Cookie', cookie('fa_futu_unlock', '', 0, secure(req)))
    res.json({ success: true })
  })

  return router
}
