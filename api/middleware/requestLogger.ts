import type { NextFunction, Request, Response } from 'express'
import { createTraceId, durationMs, logger, withLogContext } from '../utils/logger.js'

const DEBUG_HTTP_EXACT_PATHS = new Set([
  '/api/simulation/dashboard',
  '/api/simulation/futu-orders',
])

const DEBUG_HTTP_PATH_PREFIXES = [
  '/api/simulation/history/',
]

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const traceId = createTraceId('req')
  const startedAt = performance.now()
  const method = req.method
  const path = req.originalUrl || req.path
  const normalizedPath = path.split('?')[0]
  const useDebug = isDebugHttpRequest(method, normalizedPath)

  withLogContext(traceId, () => {
    const startedLog = useDebug ? logger.debug.bind(logger) : logger.info.bind(logger)
    startedLog(
      {
        event: 'http.request.started',
        method,
        path,
        query: req.query,
      },
      'HTTP request started',
    )

    res.on('finish', () => {
      const completedLog = useDebug && res.statusCode < 400 ? logger.debug.bind(logger) : logger.info.bind(logger)
      completedLog(
        {
          event: 'http.request.completed',
          method,
          path,
          statusCode: res.statusCode,
          durationMs: durationMs(startedAt),
        },
        'HTTP request completed',
      )
    })

    next()
  })
}

export function isDebugHttpRequest(method: string, path: string): boolean {
  if (method.toUpperCase() !== 'GET') return false
  return DEBUG_HTTP_EXACT_PATHS.has(path) || DEBUG_HTTP_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))
}
