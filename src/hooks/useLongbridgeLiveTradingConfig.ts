import { useCallback, useEffect, useState } from 'react'
import type { LongbridgeLiveTradingConfigResponse } from '../../shared/longbridgeTypes'
import type { UpdateLlmRuntimeConfigRequest, UpdateTradeStrategyConfigRequest } from '../../shared/types'

export function useLongbridgeLiveTradingConfig() {
  const [config, setConfig] = useState<LongbridgeLiveTradingConfigResponse>()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/longbridge/live-trading/config')
      if (!response.ok) throw new Error(`Longbridge live config failed with HTTP ${response.status}`)
      const payload = (await response.json()) as LongbridgeLiveTradingConfigResponse
      setConfig(payload)
      setError(undefined)
      return payload
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to load Longbridge live config.')
      return undefined
    }
  }, [])

  const saveLlmConfig = useCallback(async (input: UpdateLlmRuntimeConfigRequest) => {
    setSaving(true)
    try {
      const response = await fetch('/api/longbridge/live-trading/llm-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
      if (!response.ok) throw new Error(`Longbridge LLM config failed with HTTP ${response.status}`)
      const payload = (await response.json()) as LongbridgeLiveTradingConfigResponse
      setConfig(payload)
      setError(undefined)
      return payload
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to save Longbridge LLM config.')
      return undefined
    } finally {
      setSaving(false)
    }
  }, [])

  const saveTradeStrategyConfig = useCallback(async (input: UpdateTradeStrategyConfigRequest) => {
    setSaving(true)
    try {
      const response = await fetch('/api/longbridge/live-trading/trade-strategy-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
      if (!response.ok) throw new Error(`Longbridge strategy config failed with HTTP ${response.status}`)
      const payload = (await response.json()) as LongbridgeLiveTradingConfigResponse
      setConfig(payload)
      setError(undefined)
      return payload
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to save Longbridge strategy config.')
      return undefined
    } finally {
      setSaving(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { config, saving, error, refresh, saveLlmConfig, saveTradeStrategyConfig }
}
