import { describe, expect, it } from 'vitest'
import { runPythonBridge } from '../api/utils/runPythonBridge'
import type { TradePreviewResponse } from '../shared/types'

describe('trade preview bridge', () => {
  it('只生成订单预览，不允许默认提交实盘订单', async () => {
    const result = await runPythonBridge<TradePreviewResponse>('futu_trade_preview.py', {
      ticker: 'AAPL',
      side: 'BUY',
      quantity: 1,
      orderType: 'LIMIT',
      limitPrice: 100,
    })

    expect(result.ok).toBe(true)
    expect(result.data?.ok).toBe(true)
    expect(result.data?.estimatedNotional).toBe('$100.00')
    expect(result.data?.canSubmitLiveOrder).toBe(false)
    expect(result.data?.riskWarnings.join(' ')).toContain('No order is submitted')
  })

  it('即使携带确认短语也不开放实盘提交能力', async () => {
    const result = await runPythonBridge<TradePreviewResponse>('futu_trade_preview.py', {
      ticker: 'AAPL',
      side: 'BUY',
      quantity: 1,
      orderType: 'LIMIT',
      limitPrice: 100,
      confirmLiveTrade: true,
      confirmationText: 'I understand this is a live order',
    })

    expect(result.ok).toBe(true)
    expect(result.data?.ok).toBe(true)
    expect(result.data?.canSubmitLiveOrder).toBe(false)
  })
})
