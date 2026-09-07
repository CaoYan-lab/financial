import { useAuthStore } from './authStore'

let installed = false

/**
 * 鉴权启用时安装全局 fetch 包装：
 * 任何 /api 请求返回 401 时，将登录态置为未登录（由 AuthGate 重新展示登录页）。
 * 不修改现有业务请求代码。
 */
export function installCloudFetchGuard(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  const originalFetch = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await originalFetch(input, init)
    const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url
    if (response.status === 401 && url.includes('/api/')) {
      useAuthStore.getState().setAnon()
    }
    return response
  }
}

export type CloudLoginResult = {
  success: boolean
  username?: string
  error?: string
}

export async function fetchAuthConfig(): Promise<boolean> {
  try {
    const response = await fetch('/api/auth/config', { credentials: 'same-origin', cache: 'no-store' })
    if (!response.ok) return true
    const payload = (await response.json()) as { enabled?: boolean }
    return payload.enabled === true
  } catch {
    return true
  }
}

export async function cloudLogin(username: string, password: string): Promise<CloudLoginResult> {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ username, password }),
  })
  const payload = (await response.json().catch(() => ({}))) as { success?: boolean; username?: string; error?: string }
  if (response.ok && payload.success) {
    return { success: true, username: payload.username ?? username }
  }
  return { success: false, error: payload.error || '登录失败' }
}

export async function cloudLogout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => undefined)
}

export async function fetchCurrentUser(): Promise<string | null> {
  try {
    const response = await fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' })
    if (!response.ok) return null
    const payload = (await response.json()) as { username?: string | null }
    return payload.username ?? null
  } catch {
    return null
  }
}
