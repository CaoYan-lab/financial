import { Router } from 'express'
import type { TradePreviewRequest, TradePreviewResponse } from '../../shared/types.js'
import { runPythonBridge } from '../utils/runPythonBridge.js'

const router = Router()

router.post('/preview', async (req, res, next) => {
  try {
    const payload = req.body as TradePreviewRequest
    const bridge = await runPythonBridge<TradePreviewResponse>('futu_trade_preview.py', payload)
    if (!bridge.ok || !bridge.data) {
      res.json({
        ok: false,
        orderSide: payload.side ?? 'unavailable',
        ticker: payload.ticker ?? 'unavailable',
        quantity: String(payload.quantity ?? 'unavailable'),
        orderType: payload.orderType ?? 'unavailable',
        limitPrice: payload.limitPrice ? `$${payload.limitPrice}` : 'unavailable',
        estimatedNotional: 'unavailable',
        riskWarnings: [`Trade preview failed: ${bridge.error ?? 'unknown error'}`],
        canSubmitLiveOrder: false,
      } satisfies TradePreviewResponse)
      return
    }
    res.json(bridge.data)
  } catch (error) {
    next(error)
  }
})

export default router

