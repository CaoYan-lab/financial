import {
  SELL_PUT_PROMPT_VERSION,
  type SellPutObservation,
  type SellPutReportAnalysis,
} from './sellPutResearch.js'

export const SELL_PUT_PROMPT_TITLE = 'Top 30 Mega-Cap Cash-Secured Put 分析 Prompt v3'

export const SELL_PUT_RAW_PROMPT_FRAGMENT = `# Top 30 Mega-Cap Cash-Secured Put 分析 Prompt v3

## 角色 Role

你是一家华尔街顶级机构的高级投资组合经理兼衍生品策略师，投资风格结合基本面价值分析、技术面择时，以及通过期权获取收益，尤其擅长现金担保卖出 Put 和 Wheel Strategy。

You are a Senior Portfolio Manager and Derivatives Strategist at a top-tier Wall Street firm. Your investment philosophy combines fundamental value analysis, technical timing, and income generation through options, especially cash-secured puts and the Wheel Strategy.

-----

## 目标 Objective

基于今天的实时市场数据，分析当前在美国交易所（NYSE/NASDAQ）上市交易的全球市值前30大公司，包括非美国公司/ADR，例如 TSM、ASML、NVO、AZN，只要它们位列前30。

Using today’s real-time market data, analyze the current Top 30 global companies by market capitalization that are listed on US exchanges (NYSE/NASDAQ), including non-US ADRs or foreign listings such as TSM, ASML, NVO, AZN, and others if they rank in the top 30.

-----

## 任务要求 Tasks

### 1. 股票池筛选 Universe Selection

- **Universe 以 https://stockanalysis.com/list/biggest-companies/ 当日排名为准。** 若该来源不可用，以 https://companiesmarketcap.com 为备用。必须明确引用来源URL和访问时间。
`

export type SellPutPromptMessage = { role: 'system' | 'user'; content: string }

export function buildSellPutReportPrompt(input: {
  runId: string
  providerId: 'FUTU' | 'LONGBRIDGE'
  generatedAt: string
  observations: SellPutObservation[]
  deterministicBaseline: SellPutReportAnalysis
}): SellPutPromptMessage[] {
  const providerName = input.providerId === 'FUTU' ? 'Futu API' : 'Longbridge API'
  const optionSource = input.providerId === 'FUTU'
    ? 'Futu option snapshot'
    : 'Longbridge option snapshot'
  return [
    {
      role: 'system',
      content:
        `你是华尔街顶级机构的高级投资组合经理兼衍生品策略师。你要基于后端提供的 ${providerName} Top30 数据、历史趋势字段、期权快照、市场资讯摘要和数据质量报告，生成一份可直接阅读的 Top30 Mega-Cap Cash-Secured Put 30D 综合研究报告。输出必须是 Markdown，不要 JSON，不要代码块。严禁编造不在输入上下文中的事实；期权权利金必须逐字使用 rawData.selectedOptionPremium 和 rawData.selectedOptionPremiumSource；缺失字段必须写 unavailable，严禁 estimate、估算、推断或补齐。`,
    },
    {
      role: 'user',
      content: JSON.stringify({
        task: '生成 Top30 Mega-Cap Cash-Secured Put 30D 综合研究报告',
        reportWindowDays: 30,
        promptVersion: SELL_PUT_PROMPT_VERSION,
        promptArchive: {
          title: SELL_PUT_PROMPT_TITLE,
          summary: '按全球市值前30、且在 NYSE/NASDAQ 交易的公司，结合基本面、技术面、期权波动率和财报风险，筛选适合现金担保卖 Put / Wheel Strategy 的候选机会。',
          rawPromptFragment: SELL_PUT_RAW_PROMPT_FRAGMENT,
        },
        reportRequirements: [
          '先中文、后英文。',
          '必须包含第零部分纯数据表 Raw Data Table，且只使用 rawData 字段。',
          'Raw Data Table 必须包含 selectedOptionStrike、selectedOptionExpiry、selectedOptionPremium、selectedOptionDelta、selectedOptionPremiumSource；这些字段必须与 rawData 完全一致。',
          `必须综合分析 ${providerName} 当前价格、估值、RSI、均线、期权快照、20/60/120 日趋势、52 周位置、30 日实现波动率、数据质量和市场资讯标题。`,
          '本次报告窗口为 30 日；结论、风险排序和 CSP/Wheel 观点必须围绕 30 日持仓/观察周期展开。',
          '30 日报告必须重点解释短期趋势、IV30、30 日实现波动率和近月 CSP 合约质量。',
          '必须给出 Top 5 最值得操作机会、Bottom 5 风险/Losers、其余股票分组总结。',
          `CSP/Wheel 建议必须说明 strike、expiry、premium、annualized return 是否来自 ${optionSource}；premium 只能来自 selectedOptionPremium，不可得时必须写 unavailable，不能估算冒充事实。`,
          '禁止出现 EST premium、estimated premium、估算权利金、推算权利金等表达。',
          '每个核心结论要说明为什么，不允许只复述规则基线。',
          '输出 Markdown 正文，不要 JSON。',
          '报告仅供研究，不构成投资建议，不自动触发交易。',
        ],
        batchId: input.runId,
        generatedAt: input.generatedAt,
        rawData: input.observations.map(observation => toRawData(observation, input.providerId)),
        deterministicBaseline: {
          note: '这是后端规则基线，只供模型参考。最终报告必须做综合评测，可以不同意基线，但必须解释原因。',
          topOpportunities: input.deterministicBaseline.topOpportunities,
          bottomLosers: input.deterministicBaseline.bottomRisks,
          groupedSummary: {
            candidates: input.deterministicBaseline.items
              .filter(item => item.candidate)
              .map(item => item.symbol),
            unavailableOrRejected: input.deterministicBaseline.items
              .filter(item => !item.candidate)
              .map(item => item.symbol),
          },
        },
      }),
    },
  ]
}

function toRawData(
  observation: SellPutObservation,
  providerId: 'FUTU' | 'LONGBRIDGE',
): Record<string, unknown> {
  const option = observation.option
  const optionSource = providerId === 'FUTU'
    ? 'Futu option snapshot'
    : 'Longbridge option snapshot'
  const marketDataSource = providerId === 'FUTU' ? 'Futu OpenD' : 'Longbridge OpenAPI'
  const premium = option && option.bid !== null && option.bid > 0
    && option.ask !== null && option.ask > 0
    ? (option.bid + option.ask) / 2
    : option?.bid ?? option?.ask ?? option?.lastPrice ?? null
  const premiumSource = premium === null
    ? 'unavailable'
    : option?.bid !== null && option?.bid !== undefined && option.bid > 0
      && option.ask !== null && option.ask !== undefined && option.ask > 0
      ? `${optionSource} bid_ask_mid`
      : option?.bid !== null && option?.bid !== undefined && option.bid > 0
        ? `${optionSource} bid_price`
        : option?.ask !== null && option?.ask !== undefined && option.ask > 0
          ? `${optionSource} ask_price`
          : `${optionSource} last_price`
  return {
    rank: observation.rank,
    ticker: observation.symbol.replace(/^US\./, '').replace(/\.US$/, ''),
    companyName: observation.displayName,
    country: observation.country,
    currentPrice: value(observation.currentPrice),
    marketCap: value(observation.marketCap),
    peRatio: value(observation.peRatio),
    rsi14: value(observation.rsi14),
    ma50: value(observation.ma50),
    ma200: value(observation.ma200),
    ivRank: value(observation.ivRank),
    iv30: value(observation.iv30),
    nextEarningsDate: observation.nextEarningsDate ?? 'unavailable',
    capitalPerContract: option ? value(option.strikePrice * option.contractMultiplier) : 'unavailable',
    sevenDayNews: observation.sevenDayNews.length > 0
      ? observation.sevenDayNews.join('；')
      : 'unavailable',
    selectedOptionCode: option?.code ?? 'unavailable',
    selectedOptionStrike: value(option?.strikePrice ?? null),
    selectedOptionExpiry: option?.expiryDate ?? 'unavailable',
    selectedOptionPremium: value(premium),
    selectedOptionDelta: value(option?.delta ?? null),
    selectedOptionPremiumSource: premiumSource,
    trend20d: value(observation.trend20d),
    trend60d: value(observation.trend60d),
    trend120d: value(observation.trend120d),
    distanceTo52wHigh: value(observation.distanceTo52wHigh),
    distanceTo52wLow: value(observation.distanceTo52wLow),
    realizedVol30d: value(observation.realizedVol30d),
    source: {
      source: marketDataSource,
      accessedAt: observation.capturedAt,
      timestamp: observation.capturedAt,
    },
    dataGaps: observation.dataGaps,
    requestId: observation.requestId,
  }
}

function value(input: number | null): number | 'unavailable' {
  return input === null ? 'unavailable' : input
}
