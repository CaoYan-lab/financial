import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const sources = [
  'api/app.ts',
  'api/cloud/http/cloudWebApp.ts',
  'api/cloud/http/routeOverrides.ts',
  'api/cloud/multiuser/http/publicAuthRouter.ts',
  'api/cloud/multiuser/http/privateRouter.ts',
  'api/routes/accountRoutes.ts',
  'api/routes/aShareRoutes.ts',
  'api/routes/liveTradingRoutes.ts',
  'api/routes/longbridgeRoutes.ts',
  'api/routes/realtimeRoutes.ts',
  'api/routes/reportRoutes.ts',
  'api/routes/simulationRoutes.ts',
  'api/routes/sourceRoutes.ts',
  'api/routes/tradeRoutes.ts',
].map((path) => readFileSync(path, 'utf8')).join('\n')

const productionPaths = [
  '/api/auth/config', '/api/auth/login', '/api/auth/logout', '/api/auth/me', '/api/health',
  '/multiuser/session', '/multiuser/password/change', '/multiuser/users',
  '/multiuser/users/:id/status', '/multiuser/users/:id/reset-password',
  '/multiuser/futu/access', '/multiuser/futu/secondary-password',
  '/multiuser/futu/unlock', '/multiuser/futu/lock',
  '/multiuser/longbridge/connection', '/multiuser/longbridge/connection/verify',
  '/cloud/worker-status', '/cloud/worker-status/:platform',
  '/account/dashboard', '/account/summary', '/account/positions',
  '/live-trading/dashboard', '/live-trading/accounts', '/live-trading/settings',
  '/live-trading/managed-orders', '/live-trading/futu-orders',
  '/live-trading/futu-orders/:orderId/detail', '/live-trading/futu-orders/:orderId/cancel',
  '/live-trading/pending-orders/:id/confirm', '/live-trading/pending-orders/:id/reject',
  '/live-trading/pending-orders/batch-expire',
  '/longbridge/workbench/dashboard', '/longbridge/source/status',
  '/longbridge/realtime/status/subscription', '/longbridge/live-trading/dashboard',
  '/longbridge/live-trading/config', '/longbridge/live-trading/accounts',
  '/longbridge/live-trading/settings', '/longbridge/live-trading/history/:kind',
  '/longbridge/live-trading/managed-orders', '/longbridge/live-trading/orders',
  '/longbridge/live-trading/orders/:orderId/detail',
  '/longbridge/live-trading/orders/:orderId/cancel',
  '/longbridge/live-trading/pending-orders/:id/confirm',
  '/longbridge/live-trading/pending-orders/:id/reject',
  '/longbridge/live-trading/pending-orders/batch-expire',
  '/report/generate', '/report/latest', '/report/history',
  '/simulation/dashboard', '/simulation/start', '/simulation/stop', '/simulation/run-once',
  '/realtime/status', '/realtime/:ticker', '/trade/preview', '/source/status',
] as const

describe('云端生产 API 清单', () => {
  it.each(productionPaths)('%s 有明确路由声明', (path) => {
    const withoutApi = path.replace(/^\/api/, '')
    const mountedRelative = withoutApi.replace(/^\/[^/]+/, '') || '/'
    expect(
      [path, withoutApi, mountedRelative].some((candidate) => sources.includes(`'${candidate}'`)),
    ).toBe(true)
  })
})
