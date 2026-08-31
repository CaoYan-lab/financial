import { describe, expect, it } from 'vitest'
import { isDebugHttpRequest } from '../api/middleware/requestLogger'
import { createTraceId, currentTraceId, withLogContext } from '../api/utils/logger'

describe('logger context', () => {
  it('createTraceId 使用前缀并保持唯一', () => {
    const first = createTraceId('simulation-run')
    const second = createTraceId('simulation-run')

    expect(first).toMatch(/^simulation-run-/)
    expect(second).toMatch(/^simulation-run-/)
    expect(first).not.toBe(second)
  })

  it('withLogContext 可以读取当前 traceId', () => {
    const traceId = createTraceId('req')
    const observed = withLogContext(traceId, () => currentTraceId())

    expect(observed).toBe(traceId)
  })

  it('不同上下文不会串用 traceId', () => {
    const first = createTraceId('first')
    const second = createTraceId('second')

    const observedFirst = withLogContext(first, () => currentTraceId())
    const observedSecond = withLogContext(second, () => currentTraceId())

    expect(observedFirst).toBe(first)
    expect(observedSecond).toBe(second)
  })

  it('高频轮询接口使用 debug 级 HTTP 日志', () => {
    expect(isDebugHttpRequest('GET', '/api/simulation/futu-orders')).toBe(true)
    expect(isDebugHttpRequest('GET', '/api/simulation/history/skipped')).toBe(true)
    expect(isDebugHttpRequest('GET', '/api/simulation/history/signals')).toBe(true)
    expect(isDebugHttpRequest('GET', '/api/simulation/dashboard')).toBe(true)
    expect(isDebugHttpRequest('POST', '/api/simulation/start')).toBe(false)
    expect(isDebugHttpRequest('PUT', '/api/simulation/llm-config')).toBe(false)
  })
})
