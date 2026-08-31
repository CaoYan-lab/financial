import { create } from 'zustand'
import type { AccountDashboardResponse, TradePreviewResponse } from '../../shared/types'

type WorkspaceState = {
  accountDashboard?: AccountDashboardResponse
  tradePreview?: TradePreviewResponse
  accountLoading: boolean
  tradePreviewLoading: boolean
  error?: string
  setAccountDashboard: (accountDashboard: AccountDashboardResponse) => void
  setTradePreview: (tradePreview?: TradePreviewResponse) => void
  setAccountLoading: (accountLoading: boolean) => void
  setTradePreviewLoading: (tradePreviewLoading: boolean) => void
  setError: (error?: string) => void
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  accountLoading: false,
  tradePreviewLoading: false,
  setAccountDashboard: (accountDashboard) => set({ accountDashboard, error: undefined }),
  setTradePreview: (tradePreview) => set({ tradePreview }),
  setAccountLoading: (accountLoading) => set({ accountLoading }),
  setTradePreviewLoading: (tradePreviewLoading) => set({ tradePreviewLoading }),
  setError: (error) => set({ error }),
}))

