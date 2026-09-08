import type { NextFunction, Response } from 'express'
import type { MultiUserRequest } from '../types.js'
import { multiUserEnabled } from '../auth/multiUserAuthService.js'
import {
  futuSecretConfigured,
  futuUnlockMaxAgeSeconds,
  validateFutuUnlock,
} from './futuStepUpService.js'

const FUTU_PREFIXES = [
  '/live-trading',
  '/account',
  '/source/status',
  '/report',
  '/reports',
  '/opportunities',
  '/cloud/worker-status',
  '/a-share',
]

export function readCookie(req: MultiUserRequest, name: string): string | null {
  const cookieHeader = req.headers.cookie
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return null
}

function isFutuProtectedPath(path: string): boolean {
  return FUTU_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
}

export async function enforceFutuAccess(
  req: MultiUserRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!multiUserEnabled() || !isFutuProtectedPath(req.path)) {
    next()
    return
  }
  const profile = req.multiUser
  if (!profile || profile.role !== 'owner') {
    res.status(403).json({
      success: false,
      code: 'FUTU_FORBIDDEN',
      error: '当前账号无权访问 Futu 账户',
    })
    return
  }
  try {
    if (!await futuSecretConfigured(profile.userId)) {
      res.status(428).json({
        success: false,
        code: 'FUTU_STEP_UP_SETUP_REQUIRED',
        error: '请先设置 Futu 独立二次密码',
      })
      return
    }
    const unlocked = await validateFutuUnlock(profile.userId, readCookie(req, 'fa_futu_unlock'))
    if (!unlocked) {
      res.status(423).json({
        success: false,
        code: 'FUTU_LOCKED',
        error: 'Futu 账户已锁定，请完成二次验证',
      })
      return
    }
    const token = readCookie(req, 'fa_futu_unlock')!
    const parts = [
      `fa_futu_unlock=${encodeURIComponent(token)}`,
      'Path=/',
      `Max-Age=${futuUnlockMaxAgeSeconds()}`,
      'HttpOnly',
      'SameSite=Strict',
    ]
    if (req.protocol === 'https' || process.env.CLOUD_COOKIE_SECURE === 'true') parts.push('Secure')
    res.append('Set-Cookie', parts.join('; '))
    next()
  } catch {
    res.status(503).json({
      success: false,
      code: 'FUTU_ACCESS_UNAVAILABLE',
      error: 'Futu 安全门禁暂不可用',
    })
  }
}
