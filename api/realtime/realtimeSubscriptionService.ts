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
    // 云端/容器模式（CLOUD_PYTHON=1 或 PG_HISTORY_DRIVER=1）使用自带完整依赖的 python 环境，
    // 不注入本机 macOS 专用 site-packages（避免 3.9 路径污染容器/venv 的 3.x 环境导致 pandas/futu 加载失败）。
    const cloudPython = process.env.CLOUD_PYTHON === '1' || process.env.PG_HISTORY_DRIVER === '1'
    const defaultUserSite = cloudPython ? '' : '/Users/bytedance/Library/Python/3.9/lib/python/site-packages'
    const pythonPath = [process.env.PYTHONPATH, defaultUserSite].filter(Boolean).join(':')
    // 云端模式下 HOME 不强制隔离为 .futu-home（订阅进程使用运行用户的 OpenD 连接环境）
    const bridgeHomeEnv = cloudPython ? (process.env.HOME || bridgeHome) : bridgeHome
    fs.mkdirSync(bridgeHome, { recursive: true })

    const child = spawn(pythonBin, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: bridgeHomeEnv, PYTHONPATH: pythonPath, PYTHONUNBUFFERED: '1' },
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
      if (code !== 0 && code !== null) this.lastError = `Realtime subscriber exited with code ${code}`
      if (this.child === child) this.child = undefined
    })

    child.stdin.write(
      JSON.stringify({
        host: process.env.FUTU_OPEND_HOST || '127.0.0.1',
        port: Number(process.env.FUTU_OPEND_PORT || 11111),
        tickers: nextTickers,
      }),
    )
    child.stdin.end()
  }

  stop() {
    const child = this.child
    this.child = undefined
    child?.kill('SIGTERM')
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
    // 基于花括号配平逐段提取完整 JSON 事件：
    // - 单个事件可能跨多个 chunk（orderBook 等大对象），未配平的部分留在 buffer 等后续数据
    // - 多个事件可能粘在同一 chunk
    // - futu SDK 的非 JSON 日志行直接跳过，不作为解析错误
    let index = 0
    const buffer = this.stdoutBuffer
    while (index < buffer.length) {
      const start = buffer.indexOf('{', index)
      if (start === -1) {
        index = buffer.length
        break
      }
      const end = this.findJsonObjectEnd(buffer, start)
      if (end === -1) {
        // 尚未收到完整对象，保留从 start 开始的部分等待下一个 chunk
        index = start
        break
      }
      const candidate = buffer.slice(start, end + 1)
      try {
        this.applyEvent(JSON.parse(candidate) as RealtimeProcessEvent)
      } catch {
        // 配平但仍无法解析（如 SDK 日志中含花括号）：跳过该片段，不污染 lastError
      }
      index = end + 1
    }
    this.stdoutBuffer = index < buffer.length ? buffer.slice(index) : ''
  }

  /**
   * 从 start（'{' 位置）开始做花括号配平，返回匹配对象末尾 '}' 的下标；
   * 考虑字符串内的括号与转义；未配平返回 -1。
   */
  private findJsonObjectEnd(text: string, start: number): number {
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < text.length; i += 1) {
      const char = text[i]
      if (inString) {
        if (escaped) {
          escaped = false
        } else if (char === '\\') {
          escaped = true
        } else if (char === '"') {
          inString = false
        }
        continue
      }
      if (char === '"') {
        inString = true
      } else if (char === '{') {
        depth += 1
      } else if (char === '}') {
        depth -= 1
        if (depth === 0) return i
      }
    }
    return -1
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
