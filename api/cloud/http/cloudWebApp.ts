import express from 'express'
import cors from 'cors'
import fs from 'node:fs'
import path from 'node:path'
import app from '../../app.js'
import { requestLogger } from '../../middleware/requestLogger.js'
import { login } from '../auth/authService.js'
import { authEnabled, requireAuth, type AuthedRequest } from '../auth/requireAuth.js'
import { createRouteOverrideRouter } from './routeOverrides.js'
import { logger } from '../../utils/logger.js'

const COOKIE_NAME = 'fa_session'
const COOKIE_MAX_AGE_SECONDS = 12 * 3600

type LoginAttempt = { count: number; resetAt: number }
const loginAttempts = new Map<string, LoginAttempt>()
const LOGIN_WINDOW_MS = 5 * 60 * 1000
const LOGIN_MAX_ATTEMPTS = 10

function clientIp(req: express.Request): string {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0].trim()
  return req.ip || req.socket.remoteAddress || 'unknown'
}

function rateLimited(ip: string): boolean {
  const now = Date.now()
  const record = loginAttempts.get(ip)
  if (!record || record.resetAt < now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS })
    return false
  }
  record.count += 1
  return record.count > LOGIN_MAX_ATTEMPTS
}

function setSessionCookie(res: express.Response, token: string, secure: boolean): void {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
    'HttpOnly',
    'SameSite=Strict',
  ]
  if (secure) parts.push('Secure')
  res.setHeader('Set-Cookie', parts.join('; '))
}

function clearSessionCookie(res: express.Response, secure: boolean): void {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Strict']
  if (secure) parts.push('Secure')
  res.setHeader('Set-Cookie', parts.join('; '))
}

export function createCloudApp(): express.Application {
  const cloudApp = express()
  cloudApp.use(cors())
  cloudApp.use(express.json({ limit: '10mb' }))
  cloudApp.use(requestLogger)

  // ---- 认证接口（在 requireAuth 之前，登录本身免鉴权） ----
  cloudApp.get('/api/auth/config', (_req: express.Request, res: express.Response) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json({ enabled: authEnabled() })
  })

  cloudApp.post('/api/auth/login', async (req: express.Request, res: express.Response) => {
    const ip = clientIp(req)
    if (rateLimited(ip)) {
      res.status(429).json({ success: false, error: '登录尝试过于频繁，请稍后再试' })
      return
    }
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string }
    try {
      const result = await login(String(username ?? '').trim(), String(password ?? ''), ip)
      if (!result.ok) {
        res.status(401).json({ success: false, error: result.error })
        return
      }
      const secure = req.protocol === 'https' || process.env.CLOUD_COOKIE_SECURE === 'true'
      setSessionCookie(res, result.token, secure)
      logger.info({ event: 'auth.login.success', username: result.username }, '管理员登录成功')
      res.json({ success: true, username: result.username })
    } catch (error) {
      logger.error({ event: 'auth.login.error', error: error instanceof Error ? error.message : String(error) }, '登录处理失败')
      res.status(500).json({ success: false, error: '登录服务暂不可用' })
    }
  })

  cloudApp.post('/api/auth/logout', (_req: express.Request, res: express.Response) => {
    const secure = _req.protocol === 'https' || process.env.CLOUD_COOKIE_SECURE === 'true'
    clearSessionCookie(res, secure)
    res.json({ success: true })
  })

  // ---- 全部 /api 接口鉴权（health 与 login 在 requireAuth 内豁免） ----
  cloudApp.use('/api', requireAuth)

  cloudApp.get('/api/auth/me', (req: AuthedRequest, res: express.Response) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json({ success: true, username: req.user?.username ?? null })
  })

  // ---- 云端拦截路由：引擎控制指令入队 + worker 状态快照（在兜底 app 之前） ----
  cloudApp.use('/api', createRouteOverrideRouter())

  // ---- 前端静态站（同源托管 dist，仅存在时启用） ----
  const distDir = path.resolve(process.cwd(), 'dist')
  if (fs.existsSync(distDir)) {
    cloudApp.use(express.static(distDir))
    cloudApp.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (req.path.startsWith('/api') || req.method !== 'GET') {
        next()
        return
      }
      res.sendFile(path.join(distDir, 'index.html'))
    })
  }

  // ---- 兜底：未拦截的 /api 请求原样转发给现有应用（app.ts 零改动） ----
  cloudApp.use(app)

  return cloudApp
}
