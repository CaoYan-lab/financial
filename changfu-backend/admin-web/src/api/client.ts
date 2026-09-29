export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code)
  }
}

const csrfKey = 'changfu-admin-csrf'

export function csrfToken(): string {
  return sessionStorage.getItem(csrfKey) ?? ''
}

export function clearCsrf(): void {
  sessionStorage.removeItem(csrfKey)
}

export async function api<T>(
  path: string,
  options: RequestInit & { mutation?: boolean } = {},
): Promise<T> {
  const headers = new Headers(options.headers)
  if (options.body) headers.set('content-type', 'application/json')
  if (options.mutation) {
    headers.set('x-csrf-token', csrfToken())
    headers.set('idempotency-key', crypto.randomUUID())
  }
  const response = await fetch(path, {
    ...options,
    headers,
    credentials: 'same-origin',
  })
  const body = response.status === 204 ? null : await response.json()
  if (!response.ok) {
    const code = typeof body?.code === 'string' ? body.code : `HTTP_${response.status}`
    throw new ApiError(response.status, code)
  }
  return body as T
}

export async function login(username: string, password: string): Promise<AdminSession> {
  const session = await api<AdminSession>('/api/v1/admin/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
  if (!session.csrfToken) throw new Error('ADMIN_CSRF_TOKEN_MISSING')
  sessionStorage.setItem(csrfKey, session.csrfToken)
  return session
}

export type AdminSession = {
  adminUserId: string
  username: string
  role: 'SUPER_ADMIN'
  mustChangePassword: boolean
  csrfToken?: string
  expiresAt?: string
}

export type UserSummary = {
  userId: string
  username: string
  displayName: string
  active: boolean
  mustChangePassword: boolean
  createdAt: string
  lastLoginAt: string | null
}

export type Slot = {
  slotId: string
  slotOrdinal: number
  providerId: string | null
  status: 'ACTIVE' | 'FROZEN' | 'EMPTY'
  boundAt: string | null
  nextRebindAt: string | null
  version: number
}

export type Subscription = {
  subscriptionId: string
  planVersionId: string
  planCode: 'LITE' | 'PRO' | 'FLAGSHIP'
  planVersion: number
  planDisplayName: string
  billingPeriod: 'MONTHLY' | 'QUARTERLY' | 'YEARLY'
  status: 'ACTIVE' | 'FROZEN' | 'CANCELLED'
  source: 'PAYMENT' | 'ADMIN_GRANT'
  version: number
  startsAt: string
  expiresAt: string
  usedSlots: number
  totalSlots: number
  slots: Slot[]
  providerPools: Array<{
    providerId: string
    status: string
    used: number
    capacity: number | null
  }>
}

export type Plan = {
  planVersionId: string
  planCode: 'LITE' | 'PRO' | 'FLAGSHIP'
  version: number
  displayName: string
  status: 'DRAFT' | 'ACTIVE' | 'RETIRED'
  effectiveFrom: string
  effectiveUntil: string | null
  brokerSlotLimit: number
  poolCapacityPerProvider: number | null
  monthlyReplacementLimit: number | null
  features: {
    batchSize: number
    optionResearch: boolean
    optionTrading: boolean
    poolCapacityProtectionLimit?: number
  }
  prices: Array<{
    priceId: string
    billingPeriod: 'MONTHLY' | 'QUARTERLY' | 'YEARLY'
    durationMonths: number
    amountMinor: number
  }>
}

export type OfficialModel = {
  configVersionId: string
  version: number
  displayName: string
  protocol: 'OPENAI_RESPONSES' | 'OPENAI_CHAT_COMPLETIONS'
  endpoint: string
  model: string
  keyLastFour: string
  status: 'DRAFT' | 'ACTIVE' | 'RETIRED'
  testStatus: 'UNTESTED' | 'SUCCEEDED' | 'FAILED'
  testErrorCode: string | null
  testedAt: string | null
  activatedAt: string | null
  createdAt: string
}
