import { useCallback, useState } from 'react'

export type AShareInstrumentLookupCandidate = {
  ticker: string
  futuCode: string
  name: string
  market: 'CN'
  exchange: 'SH' | 'SZ'
  tradingCurrency: 'CNY'
  assetType: 'STOCK' | 'ETF'
  board?: 'SH_MAIN' | 'STAR' | 'SZ_MAIN' | 'CHINEXT' | 'BSE' | 'UNKNOWN'
}

export type AShareInstrumentLookupResponse = {
  ok: boolean
  query: string
  candidates: AShareInstrumentLookupCandidate[]
  error?: string
  updatedAt: string
}

export type AShareUniverseResponse = {
  ok: boolean
  universe: Array<AShareInstrumentLookupCandidate & { addedAt: string }>
  error?: string
  updatedAt: string
}

export function useAshareInstrumentLookup() {
  const [query, setQuery] = useState('')
  const [lookupResult, setLookupResult] = useState<AShareInstrumentLookupResponse>()
  const [universeResult, setUniverseResult] = useState<AShareUniverseResponse>()
  const [loading, setLoading] = useState(false)
  const [subscribingTicker, setSubscribingTicker] = useState<string>()
  const [error, setError] = useState<string>()

  const lookup = useCallback(async () => {
    const normalized = query.trim()
    if (!normalized) {
      setError('请输入 A 股代码、名称或板块关键词。')
      return undefined
    }
    setLoading(true)
    try {
      const response = await fetch('/api/a-share/instruments/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: normalized }),
      })
      const payload = (await response.json()) as AShareInstrumentLookupResponse
      if (!response.ok || !payload.ok) throw new Error(payload.error ?? `A 股查询失败：HTTP ${response.status}`)
      setLookupResult(payload)
      setError(undefined)
      return payload
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'A 股查询失败。')
      return undefined
    } finally {
      setLoading(false)
    }
  }, [query])

  const subscribe = useCallback(async (candidate: AShareInstrumentLookupCandidate) => {
    setSubscribingTicker(candidate.ticker)
    try {
      const response = await fetch('/api/a-share/universe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(candidate),
      })
      const payload = (await response.json()) as AShareUniverseResponse
      if (!response.ok || !payload.ok) throw new Error(payload.error ?? `A 股订阅失败：HTTP ${response.status}`)
      setUniverseResult(payload)
      setError(undefined)
      return payload
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'A 股订阅失败。')
      return undefined
    } finally {
      setSubscribingTicker(undefined)
    }
  }, [])

  return {
    query,
    setQuery,
    lookupResult,
    universeResult,
    loading,
    subscribingTicker,
    error,
    lookup,
    subscribe,
  }
}
