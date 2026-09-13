import { Router, type Request, type Response } from 'express'
import type { TradingPromptBroker } from '../../shared/tradingPromptTypes.js'
import type { MultiUserRequest } from '../cloud/multiuser/types.js'
import { latestTradingPromptComparison } from '../live/tradingPromptComparisonStore.js'
import { PromptModeError, saveTradingPromptMode, tradingPromptReleaseStatus } from '../live/tradingPromptReleaseService.js'

export async function handlePromptMode(req: Request, res: Response, broker: TradingPromptBroker, scope = 'default') {
  res.setHeader('Cache-Control', 'no-store')
  try {
    const remote = req.socket.remoteAddress
    const authenticated = Boolean((req as MultiUserRequest).user)
    if (!authenticated && (process.env.CLOUD_MODE === '1' || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote ?? ''))) {
      throw new PromptModeError('提示词配置需要登录或本机访问。', 401)
    }
    if (req.method === 'PUT') {
      const origin = req.get('origin')
      const originUrl = parseOrigin(origin)
      const localOrigin = isLocalOrigin(originUrl)
      if (!promptModeOriginAllowed(req, authenticated)) {
        throw new PromptModeError('拒绝非同源模式切换。', 403)
      }
      if (!authenticated && !localOrigin) throw new PromptModeError('本地模式切换仅允许本机来源。', 403)
      res.json(await saveTradingPromptMode(broker, scope, req.body))
    } else res.json(await tradingPromptReleaseStatus(broker, scope))
  } catch (error) {
    res.status(error instanceof PromptModeError ? error.status : 503).json({
      ok: false, error: error instanceof PromptModeError ? error.message : '提示词配置暂不可用，未修改模式。',
    })
  }
}

export function promptModeOriginAllowed(req: Request, authenticated: boolean): boolean {
  const originUrl = parseOrigin(req.get('origin'))
  if (!originUrl) return false
  const configuredOrigin = parseOrigin(process.env.TRADING_PROMPT_PUBLIC_ORIGIN)
  const directOrigin = parseOrigin(`${req.protocol}://${req.get('host')}`)
  if (isLocalOrigin(originUrl)
    || originUrl.origin === configuredOrigin?.origin
    || originUrl.origin === directOrigin?.origin) return true
  return authenticated
    && process.env.CLOUD_MODE === '1'
    && req.get('sec-fetch-site') === 'same-origin'
}

export function createTradingPromptRouter(broker: TradingPromptBroker) {
  const router = Router()
  router.get('/comparison/latest', (req, res) => {
    const remote = req.socket.remoteAddress
    const authenticated = Boolean((req as MultiUserRequest).user)
    if (!authenticated && (process.env.CLOUD_MODE === '1' || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote ?? ''))) {
      res.status(401).json({ ok: false, error: '提示词测试记录需要登录或本机访问。' })
      return
    }
    res.setHeader('Cache-Control', 'no-store')
    res.json(latestTradingPromptComparison(broker))
  })
  router.get('/', (req, res) => { void handlePromptMode(req, res, broker) })
  router.put('/', (req, res) => { void handlePromptMode(req, res, broker) })
  return router
}

function parseOrigin(value: string | undefined): URL | undefined {
  if (!value) return undefined
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : undefined
  } catch {
    return undefined
  }
}

function isLocalOrigin(origin: URL | undefined): boolean {
  return process.env.CLOUD_MODE !== '1'
    && Boolean(origin && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))
}
