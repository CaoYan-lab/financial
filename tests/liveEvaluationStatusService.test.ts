import { describe, expect, it } from 'vitest'
import {
  buildLiveEvaluationStatus,
  liveEvaluationSkipReason,
} from '../api/trading/liveEvaluationStatusService.js'

const updatedAt = '2026-09-07T12:00:00.000Z'

describe('实盘评估状态聚合', () => {
  it('引擎停止时统一返回停止态', () => {
    const status = buildLiveEvaluationStatus({
      running: false,
      items: [
        { ticker: 'AAPL', marketState: 'RTH', updatedAt },
        { ticker: '07747', marketState: 'CLOSED', updatedAt },
      ],
      disableUsOvernightLlm: true,
    })
    expect(status).toMatchObject({
      state: 'STOPPED',
      activeCount: 0,
      waitingCount: 2,
      totalCount: 2,
    })
    expect(status.items.every((item) => item.evaluationState === 'DISABLED')).toBe(true)
  })

  it('全部处于允许时段时返回正常评估', () => {
    const status = buildLiveEvaluationStatus({
      running: true,
      items: [
        { ticker: 'AAPL.US', marketState: 'RTH', updatedAt },
        { ticker: '07747', marketState: 'MORNING', updatedAt },
      ],
      disableUsOvernightLlm: true,
    })
    expect(status).toMatchObject({
      state: 'RUNNING',
      activeCount: 2,
      waitingCount: 0,
      totalCount: 2,
    })
    expect(status.items.map((item) => item.marketLabel)).toEqual(['盘中', '盘中'])
  })

  it('部分市场休市时返回部分运行', () => {
    const status = buildLiveEvaluationStatus({
      running: true,
      items: [
        { ticker: 'AAPL', marketState: 'RTH', updatedAt },
        { ticker: '07747', marketState: 'CLOSED', updatedAt },
      ],
      disableUsOvernightLlm: true,
    })
    expect(status).toMatchObject({
      state: 'PARTIAL',
      activeCount: 1,
      waitingCount: 1,
    })
    expect(status.items[1]).toMatchObject({
      ticker: '07747',
      market: '港股',
      evaluationState: 'WAITING_MARKET',
      marketLabel: '休市',
    })
  })

  it('全部休市时等待开市且不产生信号语义', () => {
    const status = buildLiveEvaluationStatus({
      running: true,
      items: [
        { ticker: 'AAPL', marketState: 'CLOSED', updatedAt },
        { ticker: '07747', marketState: 'REST', updatedAt },
      ],
      disableUsOvernightLlm: true,
    })
    expect(status).toMatchObject({
      state: 'WAITING_MARKET',
      activeCount: 0,
      waitingCount: 2,
    })
    expect(status.summary).toContain('不会生成策略信号')
  })

  it('美股夜盘开关决定是否参与评估', () => {
    const disabled = buildLiveEvaluationStatus({
      running: true,
      items: [{ ticker: 'AAPL', marketState: 'OVERNIGHT', updatedAt }],
      disableUsOvernightLlm: true,
    })
    const enabled = buildLiveEvaluationStatus({
      running: true,
      items: [{ ticker: 'AAPL', marketState: 'OVERNIGHT', updatedAt }],
      disableUsOvernightLlm: false,
    })
    expect(disabled.items[0].evaluationState).toBe('DISABLED')
    expect(enabled.items[0].evaluationState).toBe('ACTIVE')
  })

  it('市场状态不可用时按异常保护', () => {
    const status = buildLiveEvaluationStatus({
      running: true,
      items: [{ ticker: 'AAPL', marketState: 'UNAVAILABLE', updatedAt }],
      disableUsOvernightLlm: true,
    })
    expect(status).toMatchObject({
      state: 'ERROR',
      activeCount: 0,
      waitingCount: 0,
    })
    expect(status.items[0]).toMatchObject({
      evaluationState: 'ERROR',
      marketLabel: '状态不可用',
    })
    expect(liveEvaluationSkipReason({
      ticker: 'AAPL',
      marketState: undefined,
      disableUsOvernightLlm: false,
    })).toContain('无法确认')
  })

  it('市场时段允许但行情数据未就绪时显示异常而非正在评估', () => {
    const status = buildLiveEvaluationStatus({
      running: true,
      items: [{
        ticker: 'AAPL',
        marketState: 'PRE_MARKET_BEGIN',
        updatedAt,
        evaluationError: '长桥行情缓存 1 分钟 K 线不足',
      }],
      disableUsOvernightLlm: true,
    })

    expect(status).toMatchObject({
      state: 'ERROR',
      activeCount: 0,
      waitingCount: 0,
    })
    expect(status.items[0]).toMatchObject({
      evaluationState: 'ERROR',
      marketLabel: '盘前',
      reason: '长桥行情缓存 1 分钟 K 线不足',
    })
  })
})
