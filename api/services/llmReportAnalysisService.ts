import type { AnalysisResult, DataQualityReport, RawCompanyData, ReportMarketContext } from '../../shared/types.js'
import { durationMs, logger } from '../utils/logger.js'
import { getReportPromptArchive } from './reportPromptArchive.js'
import { callArkResponses } from '../simulation/llmResponseUtils.js'
import { getLlmRuntimeConfig } from '../simulation/llmRuntimeConfigService.js'

export async function generateLlmMarkdownReport(input: {
  batchId: string
  generatedAt: string
  reportWindowDays?: 30 | 60
  rawData: RawCompanyData[]
  dataQuality: DataQualityReport
  baselineAnalysis: AnalysisResult
  marketContext: ReportMarketContext
}): Promise<string> {
  const startedAt = performance.now()
  const runtimeConfig = getLlmRuntimeConfig().config
  logger.info({ event: 'report.llm.generation.started', batchId: input.batchId, model: runtimeConfig.model, rowCount: input.rawData.length }, 'Report LLM generation started')

  const response = await callArkResponses(buildReportGenerationPrompt(input))
  if (response.ok === false) {
    logger.error(
      { event: 'report.llm.generation.failed', batchId: input.batchId, model: runtimeConfig.model, durationMs: durationMs(startedAt), error: response.error },
      'Report LLM generation failed',
    )
    throw new Error(`Top30 报告大模型生成失败：${response.error}`)
  }

  const markdown = normalizeMarkdown(response.text, input)
  logger.info(
    {
      event: 'report.llm.generation.succeeded',
      batchId: input.batchId,
      model: runtimeConfig.model,
      modelLabel: runtimeConfig.modelLabel,
      durationMs: durationMs(startedAt),
      outputLength: markdown.length,
    },
    'Report LLM generation succeeded',
  )
  return markdown
}

export function buildReportGenerationPrompt(input: {
  batchId: string
  generatedAt: string
  reportWindowDays?: 30 | 60
  rawData: RawCompanyData[]
  dataQuality: DataQualityReport
  baselineAnalysis: AnalysisResult
  marketContext: ReportMarketContext
}): Array<{ role: string; content: string }> {
  const promptArchive = getReportPromptArchive()
  const reportWindowDays = input.reportWindowDays ?? 30
  const reportTitle = `Top30 Mega-Cap Cash-Secured Put ${reportWindowDays}D 综合研究报告`
  return [
    {
      role: 'system',
      content:
        `你是华尔街顶级机构的高级投资组合经理兼衍生品策略师。你要基于后端提供的 Futu API Top30 数据、历史趋势字段、期权快照、市场资讯摘要和数据质量报告，生成一份可直接阅读的 ${reportTitle}。输出必须是 Markdown，不要 JSON，不要代码块。严禁编造不在输入上下文中的事实；期权权利金必须逐字使用 rawData.selectedOptionPremium 和 rawData.selectedOptionPremiumSource；缺失字段必须写 unavailable，严禁 estimate、估算、推断或补齐。`,
    },
    {
      role: 'user',
      content: JSON.stringify({
        task: `生成 ${reportTitle}`,
        reportWindowDays,
        promptArchive: {
          title: promptArchive.title,
          summary: promptArchive.summary,
          rawPromptFragment: promptArchive.rawPrompt,
        },
        reportRequirements: [
          '先中文、后英文。',
          '必须包含第零部分纯数据表 Raw Data Table，且只使用 rawData 字段。',
          'Raw Data Table 必须包含 selectedOptionStrike、selectedOptionExpiry、selectedOptionPremium、selectedOptionDelta、selectedOptionPremiumSource；这些字段必须与 rawData 完全一致。',
          '必须综合分析 Futu API 当前价格、估值、RSI、均线、期权快照、20/60/120 日趋势、52 周位置、30 日实现波动率、数据质量和市场资讯标题。',
          `本次报告窗口为 ${reportWindowDays} 日；结论、风险排序和 CSP/Wheel 观点必须围绕 ${reportWindowDays} 日持仓/观察周期展开。`,
          reportWindowDays === 60
            ? '60 日报告必须重点解释 trend60d、trend120d、52 周位置与 MA50/MA200 的中期结构，不能只复述 30 日波动率。'
            : '30 日报告必须重点解释短期趋势、IV30、30 日实现波动率和近月 CSP 合约质量。',
          '必须给出 Top 5 最值得操作机会、Bottom 5 风险/Losers、其余股票分组总结。',
          'CSP/Wheel 建议必须说明 strike、expiry、premium、annualized return 是否来自 Futu option snapshot；premium 只能来自 selectedOptionPremium，不可得时必须写 unavailable，不能估算冒充事实。',
          '禁止出现 EST premium、estimated premium、估算权利金、推算权利金等表达。',
          '每个核心结论要说明为什么，不允许只复述规则基线。',
          '输出 Markdown 正文，不要 JSON。',
          '报告仅供研究，不构成投资建议，不自动触发交易。',
        ],
        batchId: input.batchId,
        generatedAt: input.generatedAt,
        dataQuality: input.dataQuality,
        marketContext: input.marketContext,
        rawData: input.rawData,
        deterministicBaseline: {
          note: '这是后端规则基线，只供模型参考。最终报告必须做综合评测，可以不同意基线，但必须解释原因。',
          topOpportunities: input.baselineAnalysis.topOpportunities,
          bottomLosers: input.baselineAnalysis.bottomLosers,
          groupedSummary: {
            attractiveButNotTop5: input.baselineAnalysis.groupedSummary.attractiveButNotTop5.map((item) => item.ticker),
            neutralHold: input.baselineAnalysis.groupedSummary.neutralHold.map((item) => item.ticker),
            trimWatchlistRisk: input.baselineAnalysis.groupedSummary.trimWatchlistRisk.map((item) => item.ticker),
          },
        },
      }),
    },
  ]
}

function normalizeMarkdown(text: string, input: { batchId: string; generatedAt: string; reportWindowDays?: 30 | 60; rawData: RawCompanyData[] }): string {
  const cleaned = text.replace(/^```(?:markdown)?\s*/i, '').replace(/```\s*$/i, '').trim()
  if (!cleaned) throw new Error('Top30 报告大模型生成失败：模型返回内容为空。')
  const reportWindowDays = input.reportWindowDays ?? 30
  const auditTable = renderProgramOptionPremiumTable(input.rawData, reportWindowDays)
  const body = cleaned.includes(input.batchId)
    ? cleaned
    : [`报告窗口：${reportWindowDays} 日`, `生成时间：${input.generatedAt}`, `批次 ID：${input.batchId}`, '', cleaned].join('\n')
  if (body.includes('## 程序落地：Futu 期权权利金核对表')) return body
  return [auditTable, '', body].join('\n')
}

function renderProgramOptionPremiumTable(rows: RawCompanyData[], reportWindowDays: 30 | 60): string {
  return [
    '## 程序落地：Futu 期权权利金核对表',
    '',
    `本报告窗口：${reportWindowDays} 日。下表由后端直接根据 \`rawData\` 渲染，不经过模型改写；权利金只使用 Futu option snapshot 字段，缺失则保持 \`unavailable\`。`,
    '',
    '| Rank | Ticker | Strike | Expiry | Delta | Premium | Premium Source |',
    '| :--- | :--- | :--- | :--- | :--- | :--- | :--- |',
    ...rows.map((row) => `| ${row.rank} | ${row.ticker} | ${row.selectedOptionStrike ?? 'unavailable'} | ${row.selectedOptionExpiry ?? 'unavailable'} | ${row.selectedOptionDelta ?? 'unavailable'} | ${row.selectedOptionPremium ?? 'unavailable'} | ${row.selectedOptionPremiumSource ?? 'unavailable'} |`),
  ].join('\n')
}
