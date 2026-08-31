import { useCallback, useEffect } from 'react'
import type { AccountDashboardResponse } from '../../shared/types'
import { useWorkspaceStore } from '@/stores/workspaceStore'

export function useAccountDashboard() {
  const { accountDashboard, accountLoading, error, setAccountDashboard, setAccountLoading, setError } = useWorkspaceStore()

  const refreshAccount = useCallback(async () => {
    setAccountLoading(true)
    setError(undefined)
    try {
      const response = await fetch('/api/account/dashboard')
      const payload = (await response.json()) as AccountDashboardResponse
      setAccountDashboard(payload)
    } catch (accountError) {
      setError(accountError instanceof Error ? accountError.message : 'Unable to load account dashboard.')
    } finally {
      setAccountLoading(false)
    }
  }, [setAccountDashboard, setAccountLoading, setError])

  useEffect(() => {
    refreshAccount()
  }, [refreshAccount])

  return { accountDashboard, accountLoading, error, refreshAccount }
}

