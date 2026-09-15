import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import SignalDecisionDetails from '../src/components/trading/SignalDecisionDetails'
import type { QuantSignal } from '../shared/types'

describe('策略信号结构化说明', () => {
  it('展示风险、证据、反证、退出条件、后续动作和实际数据窗口', () => {
    const signal: QuantSignal = {
      id: 'signal-a',
      ticker: 'AAPL',
      strategy: 'LLM_AUTONOMOUS_STOCK_TRADER',
      side: 'HOLD',
      confidence: 'low',
      reason: '趋势尚未确认。',
      price: '180',
      quantity: '0',
      limitPrice: '180',
      riskAssessment: '继续等待不会增加风险。',
      generatedAt: '2026-09-15T08:00:00.000Z',
      dataWindow: '120 x 1m K线 / 240 分时点 / 5 档摆盘',
      evidence: [{ id: 'E3', path: 'marketData', summary: '现价180，盘口正常。' }],
      counterEvidence: [{ id: 'E4', path: 'trendContext', summary: '趋势仍为横盘弱势。' }],
      exitCondition: '趋势转强并突破阻力后重新评估。',
      requestedFollowUp: 'REFRESH_DATA',
      source: 'longbridge-sdk-cache',
    }

    const html = renderToStaticMarkup(createElement(SignalDecisionDetails, { signal }))

    expect(html).toContain('风险评估')
    expect(html).toContain('继续等待不会增加风险')
    expect(html).toContain('支持证据')
    expect(html).toContain('现价180，盘口正常')
    expect(html).toContain('关键反证')
    expect(html).toContain('趋势仍为横盘弱势')
    expect(html).toContain('退出或重新评估条件')
    expect(html).toContain('刷新账户与行情数据')
    expect(html).toContain('120 x 1m K线 / 240 分时点 / 5 档摆盘')
  })
})
