/**
 * This is a API server
 */

import express, {
  type Request,
  type Response,
  type NextFunction,
} from 'express'
import cors from 'cors'
import path from 'path'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import accountRoutes from './routes/accountRoutes.js'
import aShareRoutes from './routes/aShareRoutes.js'
import authRoutes from './routes/auth.js'
import reportRoutes from './routes/reportRoutes.js'
import realtimeRoutes from './routes/realtimeRoutes.js'
import liveTradingRoutes from './routes/liveTradingRoutes.js'
import longbridgeRoutes from './routes/longbridgeRoutes.js'
import sourceRoutes from './routes/sourceRoutes.js'
import simulationRoutes from './routes/simulationRoutes.js'
import tradeRoutes from './routes/tradeRoutes.js'
import { requestLogger } from './middleware/requestLogger.js'
import { warmTradeStrategyConfigCatalog } from './trade_strategy/tradeStrategyConfigService.js'
import { errorMessage, errorStack, logger } from './utils/logger.js'

// for esm mode
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// load env
dotenv.config({ path: ['.env.local', '.env'] })
warmTradeStrategyConfigCatalog()

const app: express.Application = express()

app.use(cors())
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))
app.use(requestLogger)

/**
 * API Routes
 */
app.use('/api/auth', authRoutes)
app.use('/api/account', accountRoutes)
app.use('/api/a-share', aShareRoutes)
app.use('/api/report', reportRoutes)
app.use('/api/realtime', realtimeRoutes)
app.use('/api/live-trading', liveTradingRoutes)
app.use('/api/longbridge', longbridgeRoutes)
app.use('/api/simulation', simulationRoutes)
app.use('/api/source', sourceRoutes)
app.use('/api/trade', tradeRoutes)

/**
 * health
 */
app.use(
  '/api/health',
  (req: Request, res: Response, next: NextFunction): void => {
    res.status(200).json({
      success: true,
      message: 'ok',
    })
  },
)

/**
 * error handler middleware
 */
app.use((error: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error(
    {
      event: 'http.request.failed',
      method: req.method,
      path: req.path,
      error: errorMessage(error),
      stack: errorStack(error),
    },
    'HTTP request failed',
  )
  res.status(500).json({
    success: false,
    error: errorMessage(error),
  })
})

/**
 * 404 handler
 */
app.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: 'API not found',
  })
})

export default app
