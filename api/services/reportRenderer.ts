import type { AnalysisResult, DataQualityReport, RawCompanyData, ReportGenerationResult } from '../../shared/types.js'

const disclaimerZh =
  '本分析仅供信息参考，不构成任何投资建议。市场变化迅速，期权策略具有较高风险，包括被迫买入标的股票的风险。'
const disclaimerEn =
  'This analysis is for informational purposes only and does not constitute investment advice. Market conditions can change rapidly, and options strategies involve significant risk, including the potential obligation to buy shares.'

export function renderMarkdownReport(result: Omit<ReportGenerationResult, 'markdown'>): string {
  return [
    renderChinese(result),
    '',
    '---',
    '',
    renderEnglish(result),
  ].join('\n')
}

function renderChinese(result: Omit<ReportGenerationResult, 'markdown'>): string {
  const reportWindowDays = result.reportWindowDays ?? 30
  return [
    `# Top 30 Mega-Cap Cash-Secured Put ${reportWindowDays} 日分析`,
    '',
    `报告窗口：${reportWindowDays} 日`,
    `生成时间：${result.generatedAt}`,
    `批次 ID：${result.batchId}`,
    '',
    '## A. 第零部分：纯数据表 Raw Data Table',
    '',
    renderRawDataTable(result.rawData),
    '',
    renderDataSources(result.dataQuality),
    '',
    '## B. 第一部分：Top 5 最值得操作机会',
    '',
    renderTopTable(result.analysis),
    '',
    '## C. 第二部分：Bottom 5 Losers',
    '',
    renderBottomTable(result.analysis),
    '',
    '## D. 第三部分：其余20只股票总结',
    '',
    renderGroupedSummary(result.analysis),
    '',
    '## 免责声明',
    '',
    disclaimerZh,
  ].join('\n')
}

function renderEnglish(result: Omit<ReportGenerationResult, 'markdown'>): string {
  const reportWindowDays = result.reportWindowDays ?? 30
  return [
    `# Top 30 Mega-Cap Cash-Secured Put ${reportWindowDays}D Analysis`,
    '',
    `Report window: ${reportWindowDays} days`,
    `Generated at: ${result.generatedAt}`,
    `Batch ID: ${result.batchId}`,
    '',
    '## A. Zero Section: Raw Data Table',
    '',
    renderRawDataTable(result.rawData),
    '',
    renderDataSources(result.dataQuality),
    '',
    '## B. Top 5 Actionable Opportunities',
    '',
    renderTopTable(result.analysis),
    '',
    '## C. Bottom 5 Losers',
    '',
    renderBottomTable(result.analysis),
    '',
    '## D. Summary of the Remaining 20 Stocks',
    '',
    renderGroupedSummary(result.analysis),
    '',
    '## Disclaimer',
    '',
    disclaimerEn,
  ].join('\n')
}

function renderRawDataTable(rows: RawCompanyData[]): string {
  const header =
    '| Rank | Ticker | Company Name | Country | Current Price | Market Cap | P/E Ratio | 14-Day RSI | 50-Day MA | 200-Day MA | IV Rank | IV (30-Day) | Next Earnings Date | Capital per Contract | 7-Day News |'
  const separator =
    '|---:|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---|'
  const body = rows
    .map(
      (row) =>
        `| ${row.rank} | ${row.ticker} | ${escapeCell(row.companyName)} | ${row.country} | ${row.currentPrice} | ${row.marketCap} | ${row.peRatio} | ${row.rsi14} | ${row.ma50} | ${row.ma200} | ${row.ivRank} | ${row.iv30} | ${row.nextEarningsDate} | ${row.capitalPerContract} | ${escapeCell(row.sevenDayNews)} |`,
    )
    .join('\n')

  return [header, separator, body].join('\n')
}

function renderTopTable(analysis: AnalysisResult): string {
  const header =
    '| Rank | Ticker | Company Name | Country of Origin | Current Price | IV Rank | Track | Verdict | Rationale | Sell Put Strategy | Support Level | Earnings Flag | Capital per Contract |'
  const separator = '|---:|---|---|---|---:|---:|---|---|---|---|---|---|---:|'
  const body = analysis.topOpportunities
    .map((item) => {
      const strategy = item.optionStrategy
        ? `${item.optionStrategy.strike} / ${item.optionStrategy.expirationDate} / ${item.optionStrategy.premium} / Annualized Return ${item.optionStrategy.annualizedReturn}`
        : 'Avoid'
      return `| ${item.rank} | ${item.ticker} | ${escapeCell(item.companyName)} | ${item.country} | ${item.currentPrice} | ${item.ivRank} | ${item.track} | ${item.verdict} | ${escapeCell(item.rationale)} | ${escapeCell(strategy)} | ${item.supportLevel} | ${item.earningsFlag} | ${item.optionStrategy?.capitalPerContract ?? 'unavailable'} |`
    })
    .join('\n')
  return [header, separator, body].join('\n')
}

function renderBottomTable(analysis: AnalysisResult): string {
  const header =
    '| Rank | Ticker | Company Name | Current Price | Verdict | Why It’s a Loser | Risk Factor | Put-Selling View |'
  const separator = '|---:|---|---|---:|---|---|---|---|'
  const body = analysis.bottomLosers
    .map(
      (item) =>
        `| ${item.rank} | ${item.ticker} | ${escapeCell(item.companyName)} | ${item.currentPrice} | ${item.verdict} | ${escapeCell(item.rationale)} | ${escapeCell(item.riskFactor ?? 'unavailable')} | ${item.putSellingView ?? 'Avoid'} |`,
    )
    .join('\n')
  return [header, separator, body].join('\n')
}

function renderGroupedSummary(analysis: AnalysisResult): string {
  const lines = [
    `**Attractive but not top 5**: ${formatTickers(analysis.groupedSummary.attractiveButNotTop5)}`,
    `**Neutral / Hold**: ${formatTickers(analysis.groupedSummary.neutralHold)}`,
    `**Trim / Watchlist risk**: ${formatTickers(analysis.groupedSummary.trimWatchlistRisk)}`,
  ]
  return lines.join('\n\n')
}

function renderDataSources(dataQuality: DataQualityReport): string {
  const sources = dataQuality.sources
    .map((source) => `- ${source.source}${source.url ? `: ${source.url}` : ''}; accessed at ${source.accessedAt}`)
    .join('\n')
  const unavailable = Object.entries(dataQuality.unavailableSummary)
    .map(([field, count]) => `${field}: ${count}`)
    .join(', ')

  return [
    '### 数据来源 Data source(s)',
    sources || '- unavailable',
    '',
    `### 数据时间戳 Timestamp`,
    dataQuality.generatedAt,
    '',
    '### unavailable 字段汇总',
    unavailable || 'None',
  ].join('\n')
}

function formatTickers(items: Array<{ ticker: string; track: string }>): string {
  if (!items.length) return 'None'
  return items.map((item) => `${item.ticker} (${item.track})`).join(', ')
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '/')
}
