import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

const tempDir = mkdtempSync(join(tmpdir(), 'llm-runtime-config-'))
process.env.SIMULATION_HISTORY_DB_PATH = join(tempDir, 'history.sqlite3')
process.env.ARK_MODEL = ''
process.env.LLM_DECISION_CONCURRENCY = ''

const {
  getActiveArkModel,
  getActiveDecisionConcurrency,
  getActiveLlmModelOption,
  getLlmRuntimeConfig,
  resetLlmRuntimeConfigCacheForTests,
  updateLlmRuntimeConfig,
} = await import('../api/simulation/llmRuntimeConfigService')
const {
  llmRequestPacingPlan,
  llmRequestSlotDelayMs,
} = await import('../api/simulation/llmRequestPacing')
const {
  llmMarketSessionSkipReason,
  orderSessionForMarketState,
  orderSubmissionSessionFailureReason,
  shouldSkipHongKongClosedLlm,
  shouldSkipUsClosedLlm,
  shouldSkipUsOvernightLlm,
} = await import('../api/simulation/usOvernightLlmGate')
const {
  llmUniverseItem,
} = await import('../api/simulation/simulationUniverse')

describe('llmRuntimeConfigService', () => {
  beforeEach(() => {
    resetLlmRuntimeConfigCacheForTests()
    delete process.env.LLM_REQUEST_SPREAD_DISABLED
    delete process.env.LLM_REQUEST_SPREAD_WINDOW_MS
    delete process.env.LLM_REQUEST_SPREAD_BASE_CONCURRENCY
  })

  it('默认使用 DeepSeek-v4-Pro endpoint 和并发 12', () => {
    const response = getLlmRuntimeConfig()

    expect(response.config.model).toBe('ep-20260616231829-mnq2t')
    expect(response.config.modelLabel).toBe('DeepSeek-v4-Pro')
    expect(response.config.concurrency).toBe(12)
    expect(response.config.maxConcurrency).toBe(20)
    expect(response.config.disableUsOvernightLlm).toBe(true)
  })

  it('更新并发时最大不超过股票池数量', () => {
    const response = updateLlmRuntimeConfig({ concurrency: 999 })

    expect(response.config.concurrency).toBe(20)
    expect(getActiveDecisionConcurrency(20)).toBe(20)
  })

  it('允许关闭或开启美股夜盘 LLM 跳过开关', () => {
    const disabled = updateLlmRuntimeConfig({ disableUsOvernightLlm: false })
    expect(disabled.config.disableUsOvernightLlm).toBe(false)

    const enabled = updateLlmRuntimeConfig({ disableUsOvernightLlm: true })
    expect(enabled.config.disableUsOvernightLlm).toBe(true)
  })

  it('只在开关开启时跳过美股夜盘，不影响港股盘前盘中', () => {
    expect(shouldSkipUsOvernightLlm({ ticker: 'AAPL', marketState: 'OVERNIGHT', disableUsOvernightLlm: true, now: new Date('2026-06-24T07:30:00.000Z') })).toBe(true)
    expect(shouldSkipUsOvernightLlm({ ticker: 'AAPL', marketState: 'RTH', disableUsOvernightLlm: true })).toBe(false)
    expect(shouldSkipUsOvernightLlm({ ticker: 'AAPL', marketState: 'PRE_MARKET_BEGIN', disableUsOvernightLlm: true })).toBe(false)
    expect(shouldSkipUsOvernightLlm({ ticker: 'AAPL', marketState: 'PRE_MARKET_END', disableUsOvernightLlm: true })).toBe(false)
    expect(shouldSkipUsOvernightLlm({ ticker: 'AAPL', marketState: 'OVERNIGHT', disableUsOvernightLlm: false })).toBe(false)
    expect(shouldSkipUsOvernightLlm({ ticker: 'AAPL', marketState: 'OVERNIGHT', disableUsOvernightLlm: true, now: new Date('2026-06-24T08:30:00.000Z') })).toBe(true)
    expect(shouldSkipUsOvernightLlm({ ticker: '09660', marketState: 'MORNING', disableUsOvernightLlm: true })).toBe(false)
    expect(shouldSkipUsOvernightLlm({ ticker: '07709', marketState: 'PRE_MARKET_HK', disableUsOvernightLlm: true })).toBe(false)
  })

  it('港股休市和等待开市时跳过指定标的，不影响竞价和盘中', () => {
    expect(shouldSkipHongKongClosedLlm({ ticker: '07709', marketState: 'CLOSED' })).toBe(true)
    expect(shouldSkipHongKongClosedLlm({ ticker: '07747', marketState: 'REST' })).toBe(true)
    expect(shouldSkipHongKongClosedLlm({ ticker: '09660', marketState: 'NONE' })).toBe(true)
    expect(shouldSkipHongKongClosedLlm({ ticker: '07709', marketState: 'PRE_MARKET_HK' })).toBe(false)
    expect(shouldSkipHongKongClosedLlm({ ticker: '09660', marketState: 'WAITING_OPEN' })).toBe(true)
    expect(shouldSkipHongKongClosedLlm({ ticker: '09660', marketState: 'AUCTION' })).toBe(false)
    expect(shouldSkipHongKongClosedLlm({ ticker: '07747', marketState: 'MORNING' })).toBe(false)
    expect(shouldSkipHongKongClosedLlm({ ticker: '09660', marketState: 'AFTERNOON' })).toBe(false)
    expect(shouldSkipHongKongClosedLlm({ ticker: '00700', marketState: 'CLOSED' })).toBe(false)
    expect(shouldSkipHongKongClosedLlm({ ticker: '07709', marketState: 'Normal', now: new Date('2026-06-24T08:15:00.000Z') })).toBe(true)
    expect(shouldSkipHongKongClosedLlm({ ticker: '09660', marketState: '0', now: new Date('2026-06-24T08:25:00.000Z') })).toBe(true)
    expect(shouldSkipHongKongClosedLlm({ ticker: '07709', marketState: 'PostMarket', now: new Date('2026-06-24T08:25:00.000Z') })).toBe(true)
    expect(shouldSkipHongKongClosedLlm({ ticker: '07709', marketState: 'Normal', now: new Date('2026-06-24T07:30:00.000Z') })).toBe(false)
  })

  it('统一市场状态 gate 会跳过美股夜盘和港股休市，但不会跳过美股盘前', () => {
    expect(llmMarketSessionSkipReason({ ticker: 'AAPL', marketState: 'OVERNIGHT', disableUsOvernightLlm: true, now: new Date('2026-06-24T07:30:00.000Z') })).toContain('美股夜盘')
    expect(llmMarketSessionSkipReason({ ticker: 'AAPL', marketState: 'OvernightTrading', disableUsOvernightLlm: true, now: new Date('2026-06-24T07:30:00.000Z') })).toContain('美股夜盘')
    expect(llmMarketSessionSkipReason({ ticker: '07709', marketState: 'CLOSED', disableUsOvernightLlm: true })).toContain('港股休市后')
    expect(llmMarketSessionSkipReason({ ticker: '07709', marketState: 'Closed', disableUsOvernightLlm: true })).toContain('港股休市后')
    expect(llmMarketSessionSkipReason({ ticker: '7709.HK', marketState: 'Closed', disableUsOvernightLlm: true })).toContain('港股休市后')
    expect(llmMarketSessionSkipReason({ ticker: '7747.HK', marketState: 'Closed', disableUsOvernightLlm: true })).toContain('港股休市后')
    expect(llmMarketSessionSkipReason({ ticker: '9660.HK', marketState: 'Closed', disableUsOvernightLlm: true })).toContain('港股休市后')
    expect(llmMarketSessionSkipReason({ ticker: 'AAPL', marketState: 'PRE_MARKET_BEGIN', disableUsOvernightLlm: true })).toBeUndefined()
    expect(llmMarketSessionSkipReason({ ticker: 'AAPL', marketState: 'PreMarket', disableUsOvernightLlm: true })).toBeUndefined()
    expect(llmMarketSessionSkipReason({ ticker: 'AAPL', marketState: 'PostMarket', disableUsOvernightLlm: true })).toBeUndefined()
    expect(llmMarketSessionSkipReason({
      ticker: 'AAPL',
      marketState: 'OVERNIGHT',
      disableUsOvernightLlm: true,
      now: new Date('2026-06-24T08:30:00.000Z'),
    })).toContain('美股夜盘')
  })

  it('美股周末和休市始终跳过评估，不受夜盘开关影响', () => {
    const sunday = new Date('2026-09-06T07:00:00.000Z')
    expect(shouldSkipUsClosedLlm({ ticker: 'AAPL', marketState: 'CLOSED', now: sunday })).toBe(true)
    expect(llmMarketSessionSkipReason({
      ticker: 'AAPL',
      marketState: 'CLOSED',
      disableUsOvernightLlm: false,
      now: sunday,
    })).toContain('周末、节假日或休市')
    expect(llmMarketSessionSkipReason({
      ticker: 'AAPL',
      disableUsOvernightLlm: false,
      now: sunday,
    })).toContain('周末、节假日或休市')
  })

  it('订单时段只映射盘中和盘前盘后，夜盘与休市禁止真实提交', () => {
    expect(orderSessionForMarketState('MORNING')).toBe('RTH')
    expect(orderSessionForMarketState('NORMAL')).toBe('RTH')
    expect(orderSessionForMarketState('PRE_MARKET_BEGIN')).toBe('ETH')
    expect(orderSessionForMarketState('PostMarket')).toBe('ETH')
    expect(orderSessionForMarketState('OVERNIGHT')).toBeUndefined()
    expect(orderSessionForMarketState('CLOSED')).toBeUndefined()
    expect(orderSubmissionSessionFailureReason({
      ticker: 'AAPL',
      marketState: 'OVERNIGHT',
      orderSession: 'ETH',
      now: new Date('2026-06-24T07:30:00.000Z'),
    })).toContain('夜盘')
    expect(orderSubmissionSessionFailureReason({
      ticker: 'AAPL',
      marketState: 'PRE_MARKET_BEGIN',
      orderSession: 'RTH',
      now: new Date('2026-06-24T12:30:00.000Z'),
    })).toContain('请重新生成订单')
  })

  it('Longbridge preflight 缺少 quote 状态时按交易所时区推断 gate', () => {
    expect(llmMarketSessionSkipReason({
      ticker: 'AAPL',
      disableUsOvernightLlm: true,
      now: new Date('2026-06-24T07:30:00.000Z'),
    })).toContain('美股夜盘')
    expect(llmMarketSessionSkipReason({
      ticker: 'AAPL',
      disableUsOvernightLlm: true,
      now: new Date('2026-06-24T12:30:00.000Z'),
    })).toBeUndefined()
    expect(llmMarketSessionSkipReason({
      ticker: '7709.HK',
      disableUsOvernightLlm: true,
      now: new Date('2026-06-24T08:30:00.000Z'),
    })).toContain('港股休市后')
    expect(llmMarketSessionSkipReason({
      ticker: '7709.HK',
      marketState: 'Normal',
      disableUsOvernightLlm: true,
      now: new Date('2026-06-24T08:30:00.000Z'),
    })).toContain('港股休市后')
    expect(llmMarketSessionSkipReason({
      ticker: '7709.HK',
      disableUsOvernightLlm: true,
      now: new Date('2026-06-24T07:30:00.000Z'),
    })).toBeUndefined()
  })

  it('股票池包含港股地平线', () => {
    expect(llmUniverseItem('09660')).toMatchObject({
      label: 'Horizon Robotics',
      market: 'HK',
      futuCode: 'HK.09660',
      tradingCurrency: 'HKD',
    })
  })

  it('允许切换到 Doubao endpoint 并立即成为当前 Ark 模型', () => {
    updateLlmRuntimeConfig({ model: 'ep-20260410101451-dq9sg', concurrency: 3 })

    expect(getActiveArkModel()).toBe('ep-20260410101451-dq9sg')
    expect(getLlmRuntimeConfig().config.modelLabel).toBe('Doubao-2.0-pro')
    expect(getActiveDecisionConcurrency(26)).toBe(3)
  })

  it('允许切换到 GLM5.2 并使用独立调用配置', () => {
    const response = updateLlmRuntimeConfig({ model: 'glm-5.2', concurrency: 2 })
    const option = getActiveLlmModelOption()

    expect(response.modelOptions.some((item) => item.id === 'glm-5.2' && item.label === 'GLM5.2')).toBe(true)
    expect(getActiveArkModel()).toBe('glm-5.2')
    expect(response.config.modelLabel).toBe('GLM5.2')
    expect(option.apiKeyEnv).toBe('GLM_API_KEY')
    expect(option.urlEnv).toBe('GLM_RESPONSES_URL')
    expect(option.defaultUrl).toBe('https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions')
    expect(option.requestProtocol).toBe('chat_completions')
  })

  it('拒绝非白名单模型并保留当前模型', () => {
    updateLlmRuntimeConfig({ model: 'ep-20260410101451-dq9sg', concurrency: 4 })
    const response = updateLlmRuntimeConfig({ model: 'unknown-model' })

    expect(response.config.model).toBe('ep-20260410101451-dq9sg')
    expect(response.config.concurrency).toBe(4)
  })

  it('实盘 LLM 请求按固定槽位打散，26 个请求约 2.5 秒完成发起', () => {
    const plan = llmRequestPacingPlan(26)

    expect(plan.enabled).toBe(true)
    expect(plan.baseWindowMs).toBe(2500)
    expect(plan.baseConcurrency).toBe(26)
    expect(plan.slotIntervalMs).toBe(100)
    expect(plan.totalWindowMs).toBe(2500)
    expect(llmRequestSlotDelayMs({ index: 25, batchStartedAt: 1000, now: 1000, totalRequests: 26 })).toBe(2500)
  })

  it('实盘 LLM 请求打散窗口随并发倍数线性放大', () => {
    expect(llmRequestPacingPlan(52).totalWindowMs).toBe(5100)
    expect(llmRequestSlotDelayMs({ index: 51, batchStartedAt: 1000, now: 1000, totalRequests: 52 })).toBe(5100)
  })
})

process.on('exit', () => {
  rmSync(tempDir, { recursive: true, force: true })
})
