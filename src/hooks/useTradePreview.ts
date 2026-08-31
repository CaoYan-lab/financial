import { useCallback } from 'react'
import type { TradePreviewRequest, TradePreviewResponse } from '../../shared/types'
import { useWorkspaceStore } from '@/stores/workspaceStore'

export function useTradePreview() {
  const { tradePreview, tradePreviewLoading, setTradePreview, setTradePreviewLoading, setError } = useWorkspaceStore()

  const previewTrade = useCallback(
    async (request: TradePreviewRequest) => {
      setTradePreviewLoading(true)
      setError(undefined)
      try {
        const response = await fetch('/api/trade/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        })
        const payload = (await response.json()) as TradePreviewResponse
        setTradePreview(payload)
      } catch (tradeError) {
        setError(tradeError instanceof Error ? tradeError.message : 'Unable to preview trade.')
      } finally {
        setTradePreviewLoading(false)
      }
    },
    [setError, setTradePreview, setTradePreviewLoading],
  )

  return { tradePreview, tradePreviewLoading, previewTrade, clearTradePreview: () => setTradePreview(undefined) }
}

