import { createHash, randomBytes } from 'node:crypto'

export const adminSessionCookie = 'changfu_admin_session'

function durationFromEnv(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const configured = Number(process.env[name] ?? fallback)
  return Number.isInteger(configured) && configured >= minimum && configured <= maximum
    ? configured
    : fallback
}

export const adminSessionAbsoluteTtlMs = durationFromEnv(
  'CHANGFU_ADMIN_SESSION_ABSOLUTE_TTL_MS',
  12 * 60 * 60 * 1_000,
  5 * 60 * 1_000,
  7 * 24 * 60 * 60 * 1_000,
)
export const adminSessionIdleTtlMs = Math.min(
  adminSessionAbsoluteTtlMs,
  durationFromEnv(
    'CHANGFU_ADMIN_SESSION_IDLE_TTL_MS',
    30 * 60 * 1_000,
    60 * 1_000,
    24 * 60 * 60 * 1_000,
  ),
)

export function randomOpaqueToken(): string {
  return randomBytes(48).toString('base64url')
}

export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function parseCookies(value: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>()
  for (const part of value?.split(';') ?? []) {
    const separator = part.indexOf('=')
    if (separator < 1) continue
    const name = part.slice(0, separator).trim()
    const encoded = part.slice(separator + 1).trim()
    try {
      cookies.set(name, decodeURIComponent(encoded))
    } catch {
      // Ignore malformed cookie values.
    }
  }
  return cookies
}

export function sessionCookie(token: string, secure: boolean): string {
  return [
    `${adminSessionCookie}=${encodeURIComponent(token)}`,
    'HttpOnly',
    secure ? 'Secure' : '',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${Math.floor(adminSessionAbsoluteTtlMs / 1_000)}`,
  ].filter(Boolean).join('; ')
}

export function expiredSessionCookie(secure: boolean): string {
  return [
    `${adminSessionCookie}=`,
    'HttpOnly',
    secure ? 'Secure' : '',
    'SameSite=Strict',
    'Path=/',
    'Max-Age=0',
  ].filter(Boolean).join('; ')
}
