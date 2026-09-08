let installed = false

export const MULTIUSER_EVENT = 'financial:multiuser-action'

export type MultiUserAction =
  | 'futu-unlock'
  | 'futu-setup'
  | 'longbridge-connect'
  | 'password-change'
  | 'forbidden'

export function installMultiUserFetchGuard(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  const originalFetch = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await originalFetch(input, init)
    const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url
    if (!url.includes('/api/') || url.includes('/api/multiuser/')) return response
    if (![403, 409, 423, 428].includes(response.status)) return response
    const payload = await response.clone().json().catch(() => ({})) as { code?: string }
    const action: MultiUserAction | undefined = {
      FUTU_LOCKED: 'futu-unlock',
      FUTU_STEP_UP_SETUP_REQUIRED: 'futu-setup',
      FUTU_FORBIDDEN: 'forbidden',
      LONGBRIDGE_CONNECTION_REQUIRED: 'longbridge-connect',
      LONGBRIDGE_CONNECTION_INVALID: 'longbridge-connect',
      PASSWORD_CHANGE_REQUIRED: 'password-change',
    }[payload.code ?? ''] as MultiUserAction | undefined
    if (action) window.dispatchEvent(new CustomEvent(MULTIUSER_EVENT, { detail: action }))
    return response
  }
}
