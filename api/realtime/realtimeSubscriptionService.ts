import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import type { RealtimeBar, RealtimeOrderBookLevel, RealtimePoint, RealtimeQuote, RealtimeSubscriptionStatus } from '../../shared/types.js'
import { fetchUniverseFromStockAnalysis } from '../providers/stockAnalysisUniverseProvider.js'
import { lockTopThirtyUniverse } from '../services/universeService.js'
import { emptyCallbackStatus, realtimeStore } from './realtimeStore.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

type RealtimeProcessEvent =
  | { kind: 'ready'; tickers: string[]; updatedAt: string }
  | { kind: 'error'; message: string; updatedAt: string }
  | { kind: 'quote'; ticker: string; quote: RealtimeQuote; updatedAt: string }
  | { kind: 'ticker'; ticker: string; points: RealtimePoint[]; updatedAt: string }
  | { kind: 'kline'; ticker: string; bars: RealtimeBar[]; updatedAt: string }
  | { kind: 'orderBook'; ticker: string; asks: RealtimeOrderBookLevel[]; bids: RealtimeOrderBookLevel[]; updatedAt: string }

class RealtimeSubscriptionService {
  private child?: ChildProcessWithoutNullStreams
  private startedAt?: string
  private lastEventAt?: string
  private lastError?: string
  private stdoutBuffer = ''

  async subscribeTop30(): Promise<RealtimeSubscriptionStatus> {
    const universe = lockTopThirtyUniverse(await fetchUniverseFromStockAnalysis())
    const tickers = universe.map((company) => company.ticker)
    this.start(tickers)
    return this.status()
  }

  start(tickers: string[]) {
    this.startInternal(tickers, false)
  }

  refresh(tickers: string[] = realtimeStore.getSubscribedTickers()) {
    this.startInternal(tickers.length ? tickers : realtimeStore.getSubscribedTickers(), true)
  }

  private startInternal(tickers: string[], forceRestart: boolean) {
    const uniqueTickers = [...new Set(tickers.map(normalizeTickerForSubscription))].slice(0, 30)
    const currentTickers = realtimeStore.getSubscribedTickers()
    const nextTickers = this.child ? mergeTickers(currentTickers, uniqueTickers).slice(0, 30) : uniqueTickers
    if (this.child && !forceRestart && sameTickerSet(currentTickers, nextTickers)) {
      realtimeStore.setSubscribedTickers(nextTickers)
      return
    }
    realtimeStore.setSubscribedTickers(nextTickers)
    this.stop()
    this.startedAt = new Date().toISOString()
    this.lastError = undefined
    this.stdoutBuffer = ''

    const pythonBin = process.env.FUTU_PYTHON_BIN || 'python3'
    const scriptPath = path.resolve(__dirname, '..', 'futu_bridge', 'futu_realtime_subscribe.py')
    const projectRoot = path.resolve(__dirname, '..', '..')
    const bridgeHome = process.env.FUTU_BRIDGE_HOME || path.join(projectRoot, '.futu-home')
    const defaultUserSite = '/Users/bytedance/Library/Python/3.9/lib/python/site-packages'
    const pythonPath = [process.env.PYTHONPATH, defaultUserSite].filter(Boolean).join(':')
    fs.mkdirSync(bridgeHome, { recursive: true })

    this.child = spawn(pythonBin, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: bridgeHome, PYTHONPATH: pythonPath, PYTHONUNBUFFERED: '1' },
    })

    this.child.stdout.on('data', (chunk) => this.handleStdout(chunk.toString()))
    this.child.stderr.on('data', (chunk) => {
      const message = chunk.toString().trim()
      if (message) this.lastError = message
    })
    this.child.on('error', (error) => {
      this.lastError = error.message
    })
    this.child.on('close', (code) => {
      if (code !== 0 && code !== null) this.lastError = `Realtime subscriber exited with code ${code}`
      this.child = undefined
    })

    this.child.stdin.write(
      JSON.stringify({
        host: process.env.FUTU_OPEND_HOST || '127.0.0.1',
        port: Number(process.env.FUTU_OPEND_PORT || 11111),
        tickers: nextTickers,
      }),
    )
    this.child.stdin.end()
  }

  stop() {
    if (this.child) {
      this.child.kill('SIGTERM')
      this.child = undefined
    }
  }

  status(): RealtimeSubscriptionStatus {
    return {
      running: Boolean(this.child),
      subscribedTickers: realtimeStore.getSubscribedTickers(),
      startedAt: this.startedAt,
      lastEventAt: this.lastEventAt,
      lastError: this.lastError,
      eventCounts: this.child ? realtimeStore.eventCounts() : realtimeStore.eventCounts() ?? emptyCallbackStatus(),
    }
  }

  private handleStdout(chunk: string) {
    this.stdoutBuffer += chunk
    const lines = this.stdoutBuffer.split('\n')
    this.stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue
      try {
        this.applyEvent(JSON.parse(trimmed) as RealtimeProcessEvent)
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : 'Unable to parse realtime callback event.'
      }
    }
  }

  private applyEvent(event: RealtimeProcessEvent) {
    this.lastEventAt = event.updatedAt
    if (event.kind === 'ready') {
      realtimeStore.setSubscribedTickers(event.tickers)
      return
    }
    if (event.kind === 'error') {
      this.lastError = event.message
      return
    }
    realtimeStore.applyEvent(event)
  }
}

export const realtimeSubscriptionService = new RealtimeSubscriptionService()

function normalizeTickerForSubscription(ticker: string): string {
  const upper = ticker.toUpperCase()
  if (upper === 'GOOGL') return 'GOOG'
  return upper
}

function mergeTickers(currentTickers: string[], requestedTickers: string[]): string[] {
  return [...new Set([...currentTickers, ...requestedTickers].map(normalizeTickerForSubscription))]
}

function sameTickerSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const rightSet = new Set(right)
  return left.every((ticker) => rightSet.has(ticker))
}
