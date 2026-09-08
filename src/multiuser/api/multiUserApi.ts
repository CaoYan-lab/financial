export type MultiUserProfile = {
  userId: string
  username: string
  displayName: string
  role: 'owner' | 'member'
  active: boolean
  mustChangePassword: boolean
  sessionsValidAfter: string
}

export type SafeConnection = {
  id: string
  platform: 'longbridge'
  status: 'pending' | 'verified' | 'invalid' | 'disabled'
  credentialSource: 'legacy_env' | 'encrypted_bundle'
  accountFingerprint?: string
  tokenExpiresAt?: string
  lastVerifiedAt?: string
}

export type LongbridgeLiveGate = {
  shadowVerifiedAt?: string
  liveTradingEnabled: boolean
  autoSubmitEnabled: boolean
}

export type ManagedUserProfile = MultiUserProfile & {
  longbridgeConnection?: SafeConnection | null
  longbridgeLiveGate?: LongbridgeLiveGate
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  const payload = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new Error(payload.error || `请求失败，HTTP ${response.status}`)
  return payload
}

export async function loadMultiUserSession(): Promise<MultiUserProfile | null> {
  try {
    const result = await request<{ success: boolean; profile?: MultiUserProfile }>(
      '/api/multiuser/session',
      { cache: 'no-store' },
    )
    return result.profile ?? null
  } catch {
    return null
  }
}

export async function changeOwnPassword(currentPassword: string, newPassword: string): Promise<void> {
  await request('/api/multiuser/password/change', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  })
}

export async function loadUsers(): Promise<ManagedUserProfile[]> {
  const result = await request<{
    users: ManagedUserProfile[]
  }>('/api/multiuser/users')
  return result.users
}

export async function createUser(input: {
  username: string
  displayName: string
  temporaryPassword: string
}): Promise<void> {
  await request('/api/multiuser/users', { method: 'POST', body: JSON.stringify(input) })
}

export async function updateUserStatus(userId: string, active: boolean): Promise<void> {
  await request(`/api/multiuser/users/${encodeURIComponent(userId)}/status`, {
    method: 'PUT',
    body: JSON.stringify({ active }),
  })
}

export async function resetUserPassword(userId: string, temporaryPassword: string): Promise<void> {
  await request(`/api/multiuser/users/${encodeURIComponent(userId)}/reset-password`, {
    method: 'POST',
    body: JSON.stringify({ temporaryPassword }),
  })
}

export async function updateLongbridgeLiveGate(userId: string, enabled: boolean): Promise<void> {
  await request(`/api/multiuser/users/${encodeURIComponent(userId)}/longbridge-live-gate`, {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  })
}

export async function loadFutuAccess(): Promise<'forbidden' | 'locked' | 'unlocked' | 'setup_required'> {
  const result = await request<{ status: 'forbidden' | 'locked' | 'unlocked' | 'setup_required' }>(
    '/api/multiuser/futu/access',
    { cache: 'no-store' },
  )
  return result.status
}

export async function unlockFutu(secondaryPassword: string): Promise<void> {
  await request('/api/multiuser/futu/unlock', {
    method: 'POST',
    body: JSON.stringify({ secondaryPassword }),
  })
}

export async function lockFutu(): Promise<void> {
  await request('/api/multiuser/futu/lock', { method: 'POST' })
}

export async function setFutuSecondaryPassword(
  currentPassword: string,
  secondaryPassword: string,
): Promise<void> {
  await request('/api/multiuser/futu/secondary-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, secondaryPassword }),
  })
}

export async function loadLongbridgeConnection(): Promise<SafeConnection | null> {
  const result = await request<{ connection?: SafeConnection | null }>(
    '/api/multiuser/longbridge/connection',
    { cache: 'no-store' },
  )
  return result.connection ?? null
}

export async function saveLongbridgeConnection(input: {
  appKey: string
  appSecret: string
  accessToken: string
}): Promise<SafeConnection> {
  const result = await request<{ connection: SafeConnection }>(
    '/api/multiuser/longbridge/connection',
    { method: 'PUT', body: JSON.stringify(input) },
  )
  return result.connection
}

export async function disconnectLongbridge(): Promise<void> {
  await request('/api/multiuser/longbridge/connection', { method: 'DELETE' })
}
