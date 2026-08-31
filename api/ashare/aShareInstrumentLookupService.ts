import { runPythonBridge } from '../utils/runPythonBridge.js'
import type { AShareExchange, AShareInstrumentLookupCandidate, AShareInstrumentLookupResponse } from './types.js'

const A_SHARE_CODE_PATTERN = /^(?:(SH|SZ)\.)?(\d{6})$/i
const A_SHARE_NAME_PATTERN = /^[\p{Script=Han}A-Za-z0-9（）()·*+\-\s]{1,40}$/u

export function normalizeAshareLookupQuery(query: string): { exchange?: AShareExchange; code: string } | undefined {
  const normalized = query.trim().toUpperCase()
  const match = normalized.match(A_SHARE_CODE_PATTERN)
  if (!match) return undefined
  return {
    exchange: match[1] as AShareExchange | undefined,
    code: match[2],
  }
}

export async function lookupAshareInstrument(query: string): Promise<AShareInstrumentLookupResponse> {
  const parsed = normalizeAshareLookupQuery(query)
  const updatedAt = new Date().toISOString()
  const normalizedQuery = query.trim()
  if (!parsed && !A_SHARE_NAME_PATTERN.test(normalizedQuery)) {
    return {
      ok: false,
      query,
      candidates: [],
      error: '请输入 6 位 A 股代码、SH./SZ. 前缀代码、股票名称，或“科创板/STAR”。',
      updatedAt,
    }
  }

  const bridge = await runPythonBridge<AShareInstrumentLookupResponse>('futu_instrument_lookup.py', {
    query: normalizedQuery,
    mode: parsed ? 'code' : 'name',
    host: process.env.FUTU_OPEND_HOST || '127.0.0.1',
    port: Number(process.env.FUTU_OPEND_PORT || 11111),
  })
  if (!bridge.ok || !bridge.data) {
    return {
      ok: false,
      query,
      candidates: [],
      error: bridge.error ?? bridge.stderr ?? 'Futu A 股查询桥未返回结果。',
      updatedAt,
    }
  }
  return {
    ...bridge.data,
    candidates: bridge.data.candidates.filter(isAshareCandidate),
    updatedAt: bridge.data.updatedAt || updatedAt,
  }
}

function isAshareCandidate(candidate: AShareInstrumentLookupCandidate): candidate is AShareInstrumentLookupCandidate {
  return (
    candidate.market === 'CN' &&
    candidate.tradingCurrency === 'CNY' &&
    (candidate.exchange === 'SH' || candidate.exchange === 'SZ') &&
    candidate.futuCode === candidate.futuCode.toUpperCase() &&
    /^(SH|SZ)\.\d{6}$/.test(candidate.futuCode)
  )
}
