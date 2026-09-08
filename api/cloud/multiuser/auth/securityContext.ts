import type { NextFunction, Response } from 'express'
import { ensureOwnerProfile, getProfile } from './profileStore.js'
import { multiUserEnabled } from './multiUserAuthService.js'
import type { MultiUserRequest } from '../types.js'

const PASSWORD_CHANGE_ALLOWLIST = new Set([
  '/auth/me',
  '/auth/logout',
  '/multiuser/session',
  '/multiuser/password/change',
])

export async function attachMultiUserContext(
  req: MultiUserRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!multiUserEnabled()) {
    next()
    return
  }
  if (req.path === '/health') {
    next()
    return
  }
  if (!req.user?.sub) {
    res.status(401).json({ success: false, code: 'AUTH_REQUIRED', error: '未登录或登录已过期' })
    return
  }
  try {
    let profile = await getProfile(req.user.sub)
    if (!profile) {
      await ensureOwnerProfile()
      profile = await getProfile(req.user.sub)
    }
    if (!profile || !profile.active) {
      res.status(403).json({ success: false, code: 'ACCOUNT_DISABLED', error: '账号未启用' })
      return
    }
    const validAfterSeconds = Math.floor(new Date(profile.sessionsValidAfter).getTime() / 1_000)
    if (req.user.iat < validAfterSeconds) {
      res.status(401).json({ success: false, code: 'SESSION_REVOKED', error: '登录态已失效，请重新登录' })
      return
    }
    req.multiUser = profile
    if (profile.mustChangePassword && !PASSWORD_CHANGE_ALLOWLIST.has(req.path)) {
      res.status(428).json({
        success: false,
        code: 'PASSWORD_CHANGE_REQUIRED',
        error: '首次登录必须修改临时密码',
      })
      return
    }
    next()
  } catch {
    res.status(503).json({
      success: false,
      code: 'MULTIUSER_CONTEXT_UNAVAILABLE',
      error: '用户安全上下文暂不可用',
    })
  }
}
