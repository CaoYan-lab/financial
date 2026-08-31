import { logger } from '../utils/logger.js'

const DEFAULT_BASE_WINDOW_MS = 2500
const DEFAULT_BASE_CONCURRENCY = 26

export type LlmRequestPacingBatch = {
  batchStartedAt: number
  totalRequests: number
  enabled?: boolean
}

export type LlmRequestPacingPlan = {
  enabled: boolean
  baseWindowMs: number
  baseConcurrency: number
  slotIntervalMs: number
  totalWindowMs: number
}

export function llmRequestPacingPlan(totalRequests: number): LlmRequestPacingPlan {
  const baseWindowMs = positiveNumber(process.env.LLM_REQUEST_SPREAD_WINDOW_MS, DEFAULT_BASE_WINDOW_MS)
  const baseConcurrency = Math.max(2, Math.floor(positiveNumber(process.env.LLM_REQUEST_SPREAD_BASE_CONCURRENCY, DEFAULT_BASE_CONCURRENCY)))
  const slotIntervalMs = baseWindowMs / Math.max(1, baseConcurrency - 1)
  const totalWindowMs = Math.max(0, Math.round(slotIntervalMs * Math.max(0, totalRequests - 1)))
  return {
    enabled: process.env.LLM_REQUEST_SPREAD_DISABLED !== '1' && totalRequests > 1,
    baseWindowMs,
    baseConcurrency,
    slotIntervalMs,
    totalWindowMs,
  }
}

export function llmRequestSlotDelayMs(input: { index: number; batchStartedAt: number; now?: number; totalRequests: number }): number {
  const plan = llmRequestPacingPlan(input.totalRequests)
  if (!plan.enabled) return 0
  const targetStartedAt = input.batchStartedAt + input.index * plan.slotIntervalMs
  return Math.max(0, Math.round(targetStartedAt - (input.now ?? performance.now())))
}

export async function waitForLlmRequestSlot(input: { index: number; ticker: string; batch: LlmRequestPacingBatch }) {
  if (input.batch.enabled === false) return
  if (process.env.NODE_ENV === 'test' && process.env.LLM_REQUEST_SPREAD_TEST_DELAYS !== '1') return
  const delayMs = llmRequestSlotDelayMs({
    index: input.index,
    batchStartedAt: input.batch.batchStartedAt,
    totalRequests: input.batch.totalRequests,
  })
  if (delayMs <= 0) return
  logger.info(
    {
      event: 'llm.request.pacing.wait',
      ticker: input.ticker,
      requestIndex: input.index,
      totalRequests: input.batch.totalRequests,
      delayMs,
    },
    'LLM request pacing wait',
  )
  await sleep(delayMs)
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
