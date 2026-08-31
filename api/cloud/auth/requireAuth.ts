import type { NextFunction, Request, Response } from 'express'
import { verifyToken, type JwtPayload } from './jwt.js'

export type AuthedRequest = Request & { user?: JwtPayload }

function extractToken(req: Request): string | null {
  const header = req.headers.authorization
  if (header && header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length).trim()
  }
  const cookieHeader = req.headers.cookie
  if (cookieHeader) {
    for (const part of cookieHeader.split(';')) {
      const [key, ...rest] = part.trim().split('=')
      if (key === 'fa_session') {
        return decodeURIComponent(rest.join('='))
      }
    }
  }
  return null
}

export function authEnabled(): boolean {
  return process.env.AUTH_ENABLED === 'true'
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!authEnabled()) {
    next()
    return
  }
  // 健康检查与登录接口免鉴权
  if (req.path === '/health' || req.path === '/auth/login') {
    next()
    return
  }
  const token = extractToken(req)
  const payload = token ? verifyToken(token) : null
  if (!payload) {
    res.status(401).json({ success: false, error: '未登录或登录已过期' })
    return
  }
  req.user = payload
  next()
}
