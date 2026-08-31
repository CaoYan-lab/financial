import type { ReportPromptArchive } from '../../shared/types.js'

const RAW_PROMPT_FRAGMENT = `# Top 30 Mega-Cap Cash-Secured Put 分析 Prompt v3

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

export function getReportPromptArchive(): ReportPromptArchive {
  return {
    title: 'Top 30 Mega-Cap Cash-Secured Put 分析 Prompt v3',
    summary:
      '按全球市值前30、且在 NYSE/NASDAQ 交易的公司，结合基本面、技术面、期权波动率和财报风险，筛选适合现金担保卖 Put / Wheel Strategy 的候选机会。',
    rawPrompt: RAW_PROMPT_FRAGMENT,
    source: 'user-provided-fragment',
    updatedAt: '2026-06-17T00:00:00.000Z',
  }
}
