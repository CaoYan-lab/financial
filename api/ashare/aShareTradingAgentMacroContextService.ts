import { runLongbridgeCli } from '../longbridge/longbridgeCli.js'
import { errorMessage, logger } from '../utils/logger.js'
import type { MacroNewsArticle, MacroNewsPromptContext, MacroNewsRiskLevel } from './aShareTradingAgentTypes.js'

const TTL_MS = Math.max(60_000, Number(process.env.ASHARE_TRADING_AGENT_MACRO_TTL_MS ?? 10 * 60_000))
const DOUBAO_SEARCH_CUSTOM_URL = 'https://open.feedcoopapi.com/search_api/web_search'
let cached: { createdAt: number; context: MacroNewsPromptContext } | undefined
let pending: Promise<MacroNewsPromptContext> | undefined

const TOPICS = [
  '美联储 FOMC 利率 路径',
  '中国 美国 CPI PPI PMI CMI 制造业景气',
  '美国 非农 就业 失业率 薪资',
  '美债收益率 美元指数 人民币汇率',
  '中美 政策 地缘政治 贸易限制 行业监管',
  '全球指数 港股 商品 能源 A股 风险偏好',
]

const RULES = [
  '该新闻快照是本轮所有 ticker 共享上下文，不是针对单个 ticker 的新闻搜索。',
  '不得在每个 ticker 决策中重新搜索新闻。',
  'macroNewsContext 的优先级低于 hardConstraints、平台订单语义、账户/持仓/行情事实和后端硬风控。',
  '新闻快照只能提高风险约束，不得覆盖原有交易定义，不得伪造缺失数据。',
  '不得仅凭新闻标题开仓；必须结合 marketData、trendContext、orderBook、账户风险和平台交易约束。',
  '新闻快照只用于识别宏观/地缘政治风险，不是单票利好或利空结论。',
  'HIGH 或 EXTREME 时，优先降低高 beta 标的和低流动性新开仓，允许合理平仓/降风险。',
  'UNAVAILABLE 时不得编造新闻，不得假设没有风险事件，也不得因为新闻不可用而放松风控。',
]

export async function getAshareMacroNewsContextForRun(): Promise<MacroNewsPromptContext> {
  const now = Date.now()
  if (cached && now - cached.createdAt < TTL_MS) return cached.context
  if (pending) return pending
  pending = loadMacroNewsContext().finally(() => {
    pending = undefined
  })
  const context = await pending
  cached = { createdAt: Date.now(), context }
  return context
}

async function loadMacroNewsContext(): Promise<MacroNewsPromptContext> {
  const generatedAt = new Date().toISOString()
  const warnings: string[] = []
  const articles: MacroNewsArticle[] = []
  const enabled = process.env.ASHARE_TRADING_AGENT_MACRO_NEWS_ENABLED !== 'false'
  if (!enabled) {
    warnings.push('macroNewsContext: UNAVAILABLE - disabled by ASHARE_TRADING_AGENT_MACRO_NEWS_ENABLED=false.')
    return buildContext(generatedAt, 'UNAVAILABLE', articles, warnings)
  }

  const provider = process.env.ASHARE_TRADING_AGENT_MACRO_PROVIDER ?? 'doubao_search'
  if (provider !== 'longbridge') {
    const doubaoResult = await tryDoubaoWebSearch()
    if (doubaoResult.ok === true) {
      return buildContext(
        generatedAt,
        doubaoResult.riskLevel,
        doubaoResult.articles.slice(0, 30),
        doubaoResult.warnings,
        'Doubao Search Custom shared snapshot',
        doubaoResult.summary,
        doubaoResult.keyRisks,
      )
    }
    warnings.push(`Doubao web search unavailable: ${doubaoResult.error}`)
    if (provider === 'doubao_search') return buildContext(generatedAt, 'UNAVAILABLE', articles, warnings, 'Doubao Search Custom shared snapshot')
  }

  for (const topic of TOPICS) {
    const result = await tryLongbridgeNewsSearch(topic)
    if (result.ok === false) {
      warnings.push(`Longbridge news query unavailable for "${topic}": ${result.error}`)
      continue
    }
    for (const article of result.articles) {
      if (!articles.some((item) => item.title === article.title && item.source === article.source)) articles.push(article)
    }
  }
  if (!articles.length) warnings.push('macroNewsContext: UNAVAILABLE - no macro news articles returned from Longbridge CLI.')
  return buildContext(generatedAt, inferRiskLevel(articles, warnings), articles.slice(0, 30), warnings)
}

async function tryDoubaoWebSearch(): Promise<{ ok: true; riskLevel: MacroNewsRiskLevel; summary: string; keyRisks: string[]; articles: MacroNewsArticle[]; warnings: string[] } | { ok: false; error: string }> {
  const apiKey = process.env.DOUBAO_SEARCH_API_KEY || process.env.SEARCH_INFINITY_API_KEY
  if (!apiKey) return { ok: false, error: 'DOUBAO_SEARCH_API_KEY/SEARCH_INFINITY_API_KEY missing.' }

  const warnings: string[] = []
  const articles: MacroNewsArticle[] = []
  for (const topic of TOPICS) {
    const result = await requestDoubaoSearch(topic, apiKey)
    if (result.ok === false) {
      warnings.push(`Doubao search query unavailable for "${topic}": ${result.error}`)
      continue
    }
    for (const article of result.articles) {
      if (!articles.some((item) => item.title === article.title && item.url === article.url)) articles.push(article)
    }
  }
  if (!articles.length) return { ok: false, error: warnings.join('; ') || 'Doubao Search returned no macro articles.' }
  return {
    ok: true,
    riskLevel: inferRiskLevel(articles, warnings),
    summary: `豆包搜索 Custom 版返回 ${articles.length} 条宏观/市场风险候选结果；仅作为 Trading Agent 风险约束上下文。`,
    keyRisks: extractKeyRisks(articles, warnings),
    articles,
    warnings,
  }
}

async function requestDoubaoSearch(topic: string, apiKey: string): Promise<{ ok: true; articles: MacroNewsArticle[] } | { ok: false; error: string }> {
  const url = process.env.DOUBAO_SEARCH_CUSTOM_URL || DOUBAO_SEARCH_CUSTOM_URL
  const count = Math.max(1, Math.min(50, Number(process.env.DOUBAO_SEARCH_COUNT ?? 5)))
  const timeoutMs = Math.max(3_000, Number(process.env.DOUBAO_SEARCH_TIMEOUT_MS ?? 15_000))
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        Query: topic,
        SearchType: 'web',
        Count: count,
        Filter: {
          NeedContent: process.env.DOUBAO_SEARCH_NEED_CONTENT === 'true',
          NeedUrl: true,
          AuthInfoLevel: Number(process.env.DOUBAO_SEARCH_AUTH_INFO_LEVEL ?? 0),
        },
        NeedSummary: process.env.DOUBAO_SEARCH_NEED_SUMMARY !== 'false',
        TimeRange: process.env.DOUBAO_SEARCH_TIME_RANGE || 'OneMonth',
        QueryControl: {
          QueryRewrite: process.env.DOUBAO_SEARCH_QUERY_REWRITE === 'true',
        },
        ContentFormats: process.env.DOUBAO_SEARCH_CONTENT_FORMATS || 'text',
        Industry: process.env.DOUBAO_SEARCH_INDUSTRY || 'finance',
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const payload = await response.json().catch(() => undefined)
    if (!response.ok) return { ok: false, error: typeof payload === 'object' ? JSON.stringify(payload) : response.statusText }
    const error = (payload as { ResponseMetadata?: { Error?: unknown } } | undefined)?.ResponseMetadata?.Error
    if (error) return { ok: false, error: JSON.stringify(error) }
    const rows = (payload as { Result?: { WebResults?: unknown[] } } | undefined)?.Result?.WebResults ?? []
    return { ok: true, articles: normalizeDoubaoWebItems(rows, topic) }
  } catch (error) {
    logger.warn({ event: 'ashare.trading_agent.macro.doubao_search_failed', topic, error: errorMessage(error) }, 'Doubao search query failed')
    return { ok: false, error: errorMessage(error) }
  }
}

async function tryLongbridgeNewsSearch(topic: string): Promise<{ ok: true; articles: MacroNewsArticle[] } | { ok: false; error: string }> {
  const commandCandidates = [
    ['news', 'search', topic, '--format', 'json'],
    ['content', 'news', 'search', topic, '--format', 'json'],
  ]
  for (const args of commandCandidates) {
    const result = await runLongbridgeCli(args, { timeoutMs: 20_000 })
    if (!result.ok) continue
    const parsed = parseJson(result.stdout)
    const articles = normalizeArticles(parsed, topic)
    if (articles.length) return { ok: true, articles }
  }
  return { ok: false, error: 'Longbridge CLI news search command failed or returned no parseable articles.' }
}

function buildContext(
  generatedAt: string,
  riskLevel: MacroNewsRiskLevel,
  articles: MacroNewsArticle[],
  warnings: string[],
  source: MacroNewsPromptContext['source'] = 'Longbridge CLI shared snapshot',
  summary?: string,
  keyRisks?: string[],
): MacroNewsPromptContext {
  return {
    source,
    priority: 'below_hard_constraints_and_market_facts',
    snapshot: {
      generatedAt,
      riskLevel,
      summary: summary || (articles.length ? `本轮宏观新闻快照包含 ${articles.length} 条候选新闻；仅作为风险约束上下文。` : '宏观新闻快照不可用；不得假设没有宏观风险。'),
      keyRisks: keyRisks?.length ? keyRisks : extractKeyRisks(articles, warnings),
      articles,
      warnings,
    },
    rules: RULES,
  }
}

function inferRiskLevel(articles: MacroNewsArticle[], warnings: string[]): MacroNewsRiskLevel {
  if (!articles.length) return warnings.length ? 'UNAVAILABLE' : 'LOW'
  const text = articles.map((item) => `${item.title} ${item.summary ?? ''}`).join(' ')
  if (/战争|制裁|熔断|危机|暴跌|加息超预期|通胀失控|war|sanction|crisis|crash/i.test(text)) return 'HIGH'
  if (/FOMC|美联储|CPI|PPI|非农|PMI|汇率|收益率|regulation|inflation|payroll/i.test(text)) return 'MEDIUM'
  return 'LOW'
}

function extractKeyRisks(articles: MacroNewsArticle[], warnings: string[]): string[] {
  if (!articles.length) return warnings.slice(0, 5)
  return articles.slice(0, 6).map((item) => `${item.topic ?? 'macro'}: ${item.title}`)
}

function normalizeDoubaoWebItems(rows: unknown[], topic: string): MacroNewsArticle[] {
  return rows
    .map((row) => row as Record<string, unknown>)
    .map((row) => ({
      title: String(row.Title ?? '').trim(),
      source: String(row.SiteName ?? 'Doubao Search'),
      publishedAt: typeof row.PublishTime === 'string' ? row.PublishTime : undefined,
      url: typeof row.Url === 'string' ? row.Url : undefined,
      summary: typeof row.Summary === 'string' ? row.Summary : typeof row.Snippet === 'string' ? row.Snippet : undefined,
      topic,
    }))
    .filter((item) => item.title)
}

function normalizeArticles(parsed: unknown, topic: string): MacroNewsArticle[] {
  const rows = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { items?: unknown[] })?.items) ? (parsed as { items: unknown[] }).items : Array.isArray((parsed as { data?: unknown[] })?.data) ? (parsed as { data: unknown[] }).data : []
  return rows
    .map((row) => row as Record<string, unknown>)
    .map((row) => ({
      title: String(row.title ?? row.headline ?? row.name ?? '').trim(),
      source: String(row.source ?? row.publisher ?? 'Longbridge CLI'),
      publishedAt: typeof row.publishedAt === 'string' ? row.publishedAt : typeof row.time === 'string' ? row.time : undefined,
      url: typeof row.url === 'string' ? row.url : typeof row.link === 'string' ? row.link : undefined,
      summary: typeof row.summary === 'string' ? row.summary : typeof row.content === 'string' ? row.content.slice(0, 500) : undefined,
      topic: typeof row.topic === 'string' ? row.topic : topic,
    }))
    .filter((item) => item.title)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
