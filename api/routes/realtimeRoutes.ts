import { Router } from 'express'
import { getLatestReport } from './reportRoutes.js'
import { realtimeStore } from '../realtime/realtimeStore.js'
import { realtimeSubscriptionService } from '../realtime/realtimeSubscriptionService.js'

const router = Router()

router.get('/status', (_req, res) => {
  res.json(realtimeSubscriptionService.status())
})

router.get('/:ticker', (req, res) => {
  res.json(realtimeStore.snapshot(req.params.ticker))
})

router.post('/subscribe-top30', async (_req, res, next) => {
  try {
    const latestReport = getLatestReport()
    if (latestReport?.rawData?.length) {
      realtimeSubscriptionService.start(latestReport.rawData.slice(0, 30).map((row) => row.ticker))
      res.json(realtimeSubscriptionService.status())
      return
    }

    res.json(await realtimeSubscriptionService.subscribeTop30())
  } catch (error) {
    next(error)
  }
})

router.post('/subscribe', (req, res) => {
  const tickers = Array.isArray(req.body?.tickers)
    ? req.body.tickers.map((ticker) => String(ticker).trim().toUpperCase()).filter(Boolean)
    : []
  realtimeSubscriptionService.start(tickers)
  res.json(realtimeSubscriptionService.status())
})

router.post('/stop', (_req, res) => {
  realtimeSubscriptionService.stop()
  res.json(realtimeSubscriptionService.status())
})

export default router
