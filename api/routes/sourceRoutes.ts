import { Router } from 'express'
import { FutuOpenDProvider } from '../providers/futuOpenDProvider.js'

const router = Router()

router.get('/status', async (_req, res, next) => {
  try {
    const provider = new FutuOpenDProvider()
    res.json(await provider.getStatus())
  } catch (error) {
    next(error)
  }
})

router.post('/test', async (_req, res, next) => {
  try {
    const provider = new FutuOpenDProvider()
    const status = await provider.getStatus()
    res.json({
      ok: status.futuOpenDAvailable && status.futuPythonSdkAvailable,
      status,
    })
  } catch (error) {
    next(error)
  }
})

export default router
