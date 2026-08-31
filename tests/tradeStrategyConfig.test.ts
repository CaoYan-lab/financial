import { describe, expect, it } from 'vitest'
import {
  buildRiskModelDescription,
  getActiveLivePortfolioReviewPrompt,
  getTradeStrategyRuntimeConfig,
  resetTradeStrategyConfigCacheForTests,
  updateTradeStrategyRuntimeConfig,
} from '../api/trade_strategy/tradeStrategyConfigService'

process.env.SIMULATION_HISTORY_DB_PATH = `/tmp/financial-trade-strategy-config-test-${process.pid}.sqlite3`

describe('trade strategy config', () => {
  it('加载默认机构风控策略和 prompt pack', () => {
    resetTradeStrategyConfigCacheForTests()
    const config = updateTradeStrategyRuntimeConfig('live', {
      strategyId: 'institutional_risk_guard_v1',
      promptPackId: 'llm_autonomous_stock_trader_v1',
      executionMode: 'legacy_direct',
    })

    expect(config.activeStrategy.id).toBe('institutional_risk_guard_v1')
    expect(config.activePromptPack.id).toBe('llm_autonomous_stock_trader_v1')
    expect(config.selection.executionMode).toBe('legacy_direct')
    expect(config.activeStrategy.rawYaml).toContain('机构风控兜底策略')
    expect(config.activePromptPack.rawYaml).toContain('LLM 自主正股/ETF交易')
    expect(config.activePromptPack.hardConstraints.common).toContain('若短期信号与 7 日趋势方向不一致，不要自动 HOLD；应在 trendAlignment 标记 AGAINST_TREND 或 REVERSAL_ATTEMPT，并在 reason 中说明反转证据、风险收益比和费用覆盖理由。')
    expect(config.activePromptPack.rawYaml).not.toContain('若短期信号与 7 日趋势方向冲突，默认 HOLD')
    expect(buildRiskModelDescription('live')).toContain('最低名义金额默认不再作为硬拦截')
  })

  it('实盘可显式开启和关闭组合策略模式', () => {
    resetTradeStrategyConfigCacheForTests()
    try {
      const enabled = updateTradeStrategyRuntimeConfig('live', { executionMode: 'candidate_pool' })
      expect(enabled.selection.executionMode).toBe('candidate_pool')

      const disabled = updateTradeStrategyRuntimeConfig('live', { executionMode: 'legacy_direct' })
      expect(disabled.selection.executionMode).toBe('legacy_direct')
    } finally {
      updateTradeStrategyRuntimeConfig('live', {
        strategyId: 'institutional_risk_guard_v1',
        promptPackId: 'llm_autonomous_stock_trader_v1',
        executionMode: 'legacy_direct',
      })
    }
  })

  it('组合裁决 Prompt 和时间预设来自配置文件', () => {
    resetTradeStrategyConfigCacheForTests()
    const prompt = getActiveLivePortfolioReviewPrompt()

    expect(prompt.id).toBe('live_portfolio_candidate_review_v1')
    expect(prompt.systemPrompt).toContain('实盘组合裁决员')
    expect(prompt.decisionRules).toContain('不要把每个 BUY 都推进到订单队列；候选之间必须比较优先级。')
    expect(prompt.decisionRules).toContain('同组候选、同标的同方向候选、已有 pendingOrders 只能作为组合风险说明，不能作为硬性不推进理由。')
    expect(prompt.defaultPresetId).toBe('deepseek_balanced_v1')
    expect(prompt.timingPresets.find((item) => item.id === 'deepseek_balanced_v1')?.portfolioReviewIntervalMinutes).toBe(5)
    expect(prompt.rawYaml).toContain('live_portfolio_candidate_review_v1')
  })

  it('模拟盘强制保持老逻辑模式', () => {
    resetTradeStrategyConfigCacheForTests()
    const simulation = updateTradeStrategyRuntimeConfig('simulation', { executionMode: 'candidate_pool' })
    expect(simulation.selection.executionMode).toBe('legacy_direct')
  })

  it('实盘和模拟盘策略选择独立保存', () => {
    resetTradeStrategyConfigCacheForTests()
    try {
      const simulation = updateTradeStrategyRuntimeConfig('simulation', {
        strategyId: 'aggressive_research_preview_v1',
        promptPackId: 'llm_autonomous_stock_trader_v1',
      })
      const live = getTradeStrategyRuntimeConfig('live')

      expect(simulation.selection.strategyId).toBe('aggressive_research_preview_v1')
      expect(live.selection.strategyId).toBe('institutional_risk_guard_v1')
    } finally {
      updateTradeStrategyRuntimeConfig('simulation', {
        strategyId: 'institutional_risk_guard_v1',
        promptPackId: 'llm_autonomous_stock_trader_v1',
      })
    }
  })

  it('禁止实盘选择仅模拟盘可用的进取策略', () => {
    resetTradeStrategyConfigCacheForTests()
    expect(() => updateTradeStrategyRuntimeConfig('live', { strategyId: 'aggressive_research_preview_v1' })).toThrow('不支持 live')
  })
})
