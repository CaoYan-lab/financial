import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import type { RealtimeBar, RealtimeOrderBookLevel, RealtimePoint, RealtimeQuote, RealtimeSubscriptionStatus } from '../../shared/types.js'
import { aShareRealtimeStore, emptyCallbackStatus } from './aShareRealtimeStore.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

type RealtimeProcessEvent =
  | { kind: 'ready'; tickers: string[]; updatedAt: string }
  | { kind: 'error'; message: string; updatedAt: string }
  | { kind: 'quote'; ticker: string; quote: RealtimeQuote; updatedAt: string }
  | { kind: 'ticker'; ticker: string; points: RealtimePoint[]; updatedAt: string }
  | { kind: 'kline'; ticker: string; bars: RealtimeBar[]; updatedAt: string }
  | { kind: 'orderBook'; ticker: string; asks: RealtimeOrderBookLevel[]; bids: RealtimeOrderBookLevel[]; updatedAt: string }

class AShareRealtimeSubscriptionService {
  private child?: ChildProcessWithoutNullStreams
  private startedAt?: string
  private lastEventAt?: string
  private lastError?: string
  private stdoutBuffer = ''

  start(tickers: string[]) {
    const nextTickers = [...new Set(tickers.map(normalizeAshareTicker))].filter(isAshareTicker)
    aShareRealtimeStore.setSubscribedTickers(nextTickers)
    this.stop()
    if (!nextTickers.length) return
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

    const child = spawn(pythonBin, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: bridgeHome, PYTHONPATH: pythonPath, PYTHONUNBUFFERED: '1' },
    })
    this.child = child
    child.stdout.on('data', (chunk) => this.handleStdout(chunk.toString()))
    child.stderr.on('data', (chunk) => {
      const message = chunk.toString().trim()
      if (message) this.lastError = message
    })
    child.on('error', (error) => {
      this.lastError = error.message
    })
    child.on('close', (code) => {
      if (code !== 0 && code !== null) this.lastError = `A-share realtime subscriber exited with code ${code}`
      if (this.child === child) this.child = undefined
    })
    child.stdin.write(
      JSON.stringify({
        host: process.env.FUTU_OPEND_HOST || '127.0.0.1',
        port: Number(process.env.FUTU_OPEND_PORT || 11111),
        tickers: nextTickers,
        preserveFutuCodeTicker: true,
      }),
    )
    child.stdin.end()
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
      subscribedTickers: aShareRealtimeStore.getSubscribedTickers(),
      startedAt: this.startedAt,
      lastEventAt: this.lastEventAt,
      lastError: this.lastError,
      eventCounts: aShareRealtimeStore.eventCounts() ?? emptyCallbackStatus(),
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
        this.lastError = error instanceof Error ? error.message : 'Unable to parse A-share realtime callback event.'
      }
    }
  }

  private applyEvent(event: RealtimeProcessEvent) {
    this.lastEventAt = event.updatedAt
    if (event.kind === 'ready') {
      aShareRealtimeStore.setSubscribedTickers(event.tickers.map(normalizeAshareTicker).filter(isAshareTicker))
      return
    }
    if (event.kind === 'error') {
      this.lastError = event.message
      return
    }
    aShareRealtimeStore.applyEvent(event)
  }
}

export const aShareRealtimeSubscriptionService = new AShareRealtimeSubscriptionService()

function normalizeAshareTicker(ticker: string): string {
  return ticker.trim().toUpperCase()
}

function isAshareTicker(ticker: string): boolean {
  return /^(SH|SZ)\.\d{6}$/.test(ticker)
}
