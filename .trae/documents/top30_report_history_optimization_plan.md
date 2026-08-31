# Top30 报告历史与机会指挥台优化计划

## Summary

本次优化围绕 Top30 CSP 报告从“内存态一次性结果”升级为“可追溯的历史报告系统”。实施后，生成报告会落入本地 SQLite；工作台只展示高价值摘要：报告中心展示最近 3 次报告，机会指挥台展示最新一次报告的 Top5 操作机会，二级页分别承载历史分页、报告详情、历史 Top5 折叠列表和 Prompt 详情。

## Current State Analysis

- 后端报告入口在 `api/routes/reportRoutes.ts`。当前 `POST /api/report/generate` 生成 `ReportGenerationResult` 后只写入模块级变量 `latestReport`，`GET /api/report/latest` 也只读该内存变量，服务重启后报告丢失。
- 报告生成链路是 `collectRawData` -> `analyzeCompanies` -> `renderMarkdownReport`，涉及文件：
  - `api/services/marketDataService.ts`
  - `api/services/analysisService.ts`
  - `api/services/reportRenderer.ts`
- 前端报告状态只存在 `src/stores/reportStore.ts` 的 Zustand 内存里。`src/hooks/useReportGeneration.ts` 生成后写 store，不会从后端历史补水。
- 工作台在 `src/pages/Dashboard.tsx` 组合三个相关卡片：
  - `src/components/workspace/ResearchReportPanel.tsx`：当前展示单次报告摘要和 `/report` 入口。
  - `src/components/workspace/OpportunityCommandPanel.tsx`：当前展示内存报告的 Top5，并进入 `/report`。
  - `src/components/workspace/WatchlistPanel.tsx`：当前标题是 “Top 30 观察列表”，只展示 tickers。
- 当前 `/report` 由 `src/pages/ReportView.tsx` 承载单份可读报告详情，不是历史列表，也没有分页。
- 项目已有 SQLite 持久化模式可复用：`api/simulation/simulationPersistence.ts` 调用 `api/futu_bridge/simulation_history_db.py`，支持 `read_latest`、`paginate`、`get_event_by_id`。本次报告模块应沿用这种 TypeScript service + Python sqlite bridge 的结构，但使用独立报告库，避免和交易历史混表。
- 用户已确认 Prompt 原文先用当前已收到片段保存，后续可替换完整全文。当前片段标题为 `Top 30 Mega-Cap Cash-Secured Put 分析 Prompt v3`，包含角色、目标、任务要求中股票池筛选开头。

## Proposed Changes

### 1. Shared Types

修改 `shared/types.ts`，新增报告历史与机会历史类型，供 API、前端、测试共用。

新增类型：

```ts
export type ReportPromptArchive = {
  title: string
  summary: string
  rawPrompt: string
  source: 'user-provided-fragment'
  updatedAt: string
}

export type ReportHistorySummary = {
  id: number
  batchId: string
  generatedAt: string
  rawRowCount: number
  topOpportunityTickers: string[]
  bottomLoserTickers: string[]
  isUsableForAnalysis: boolean
}

export type ReportHistoryPage = {
  items: ReportHistorySummary[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export type TopOpportunitySnapshot = {
  id: number
  reportId: number
  batchId: string
  generatedAt: string
  opportunityRank: number
  analysis: CompanyAnalysis
}

export type TopOpportunityHistoryGroup = {
  report: ReportHistorySummary
  opportunities: TopOpportunitySnapshot[]
}

export type TopOpportunityHistoryPage = {
  items: TopOpportunityHistoryGroup[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}
```

保留 `ReportGenerationResult` 作为单份报告详情载体，不引入新的报告详情结构，减少前端改造面。

### 2. Report Prompt Archive

新增 `api/services/reportPromptArchive.ts`，集中定义工作台展示文案和原始 Prompt 片段。

内容决策：
- `summary` 使用通俗中文：`按全球市值前30、且在 NYSE/NASDAQ 交易的公司，结合基本面、技术面、期权波动率和财报风险，筛选适合现金担保卖 Put / Wheel Strategy 的候选机会。`
- `rawPrompt` 保存用户当前提供的 Prompt v3 片段，不补写未收到的部分，不编造全文。
- 提供 `getReportPromptArchive(): ReportPromptArchive`，后续如果用户补全 Prompt，只需要替换该常量，不影响页面和接口。

### 3. SQLite Persistence

新增 `api/futu_bridge/report_history_db.py`，使用 `.data/top30-report-history.sqlite3`。沿用现有 Python bridge 风格：从 stdin 读取 JSON，stdout 输出单行 JSON，所有写入使用 SQLite 事务。

建表：

```sql
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL UNIQUE,
  generated_at TEXT NOT NULL,
  raw_data TEXT NOT NULL,
  data_quality TEXT NOT NULL,
  analysis TEXT NOT NULL,
  markdown TEXT NOT NULL,
  prompt_archive TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reports_generated_at
ON reports(generated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS report_top_opportunities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL,
  batch_id TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  opportunity_rank INTEGER NOT NULL,
  ticker TEXT NOT NULL,
  analysis TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(report_id) REFERENCES reports(id) ON DELETE CASCADE,
  UNIQUE(report_id, opportunity_rank)
);

CREATE INDEX IF NOT EXISTS idx_report_top_opportunities_report_rank
ON report_top_opportunities(report_id, opportunity_rank ASC);

CREATE INDEX IF NOT EXISTS idx_report_top_opportunities_ticker_generated_at
ON report_top_opportunities(ticker, generated_at DESC, id DESC);
```

支持 actions：
- `append_report`：写入一份完整报告，同时把 `analysis.topOpportunities.slice(0, 5)` 拆入 `report_top_opportunities`，以 `report_id` 和 `batch_id` 保证关联映射。
- `latest_report`：返回最近一份完整 `ReportGenerationResult`。
- `paginate_reports`：分页返回 `ReportHistorySummary`，默认 `pageSize=10`，最大 100。
- `get_report_by_batch_id`：按 `batchId` 返回完整报告详情。
- `latest_top_opportunities`：返回最新报告的 Top5。
- `paginate_top_opportunity_groups`：按报告批次分页，每个列表项包含该报告的 Top5，供折叠列表展示。
- `clear`：仅测试使用。

新增 `api/services/reportPersistence.ts`，封装 TypeScript 调用：
- 默认 DB 路径：`.data/top30-report-history.sqlite3`
- 测试环境默认关闭持久化，使用 `REPORT_PERSIST_TEST=1` 时开启，和 `simulationPersistence` 风格一致。
- 对外方法：
  - `appendReport(report: ReportGenerationResult, promptArchive: ReportPromptArchive): void`
  - `readLatestReport(): ReportGenerationResult | undefined`
  - `paginateReports(page: number, pageSize: number): ReportHistoryPage`
  - `getReportByBatchId(batchId: string): ReportGenerationResult | undefined`
  - `readLatestTopOpportunities(): TopOpportunitySnapshot[]`
  - `paginateTopOpportunityGroups(page: number, pageSize: number): TopOpportunityHistoryPage`
  - `clearForTests(): void`

### 4. Report API

修改 `api/routes/reportRoutes.ts`。

行为变更：
- `POST /api/report/generate`
  - 生成报告后调用 `reportPersistence.appendReport(latestReport, getReportPromptArchive())`。
  - 继续设置模块级 `latestReport`，作为运行期快速缓存。
  - 响应仍返回完整 `ReportGenerationResult`，兼容现有生成流程。
- `GET /api/report/latest`
  - 优先返回模块级 `latestReport`。
  - 若内存为空，从 SQLite `readLatestReport()` 补水并回填 `latestReport`。
  - 没有历史时返回 `{ message: 'unavailable' }`，保持兼容。
- `POST /api/report/render`
  - 只做渲染预览，不自动持久化，避免把手工传入 rawData 的临时渲染误认为正式报告。

新增接口：
- `GET /api/report/history?page=1&pageSize=10`
  - 返回 `ReportHistoryPage`。
- `GET /api/report/history/:batchId`
  - 返回完整 `ReportGenerationResult`；找不到返回 404。
- `GET /api/report/top-opportunities/latest`
  - 返回最新报告 Top5，用于工作台机会指挥台。
- `GET /api/report/top-opportunities/history?page=1&pageSize=10`
  - 返回按报告批次分页的 Top5 折叠列表数据。
- `GET /api/report/prompt`
  - 返回 `ReportPromptArchive`，用于工作台说明卡和 Prompt 详情页。

### 5. Frontend Hooks and Store

修改 `src/stores/reportStore.ts`：
- 保留 `report`。
- 增加 `recentReports?: ReportHistorySummary[]`、`promptArchive?: ReportPromptArchive`、`latestTopOpportunities?: TopOpportunitySnapshot[]`。
- 增加 setter，避免每个卡片重复请求。

修改 `src/hooks/useReportGeneration.ts`：
- 初次加载时继续获取 `/api/source/status`。
- 同时调用：
  - `/api/report/latest` 补水当前报告。
  - `/api/report/history?page=1&pageSize=3` 给工作台报告中心。
  - `/api/report/top-opportunities/latest` 给机会指挥台。
  - `/api/report/prompt` 给 Top30 说明卡。
- 生成新报告成功后，刷新上述三个摘要接口，确保工作台不依赖旧内存。

新增 hooks：
- `src/hooks/useReportHistory.ts`
  - 管理 `/api/report/history` 分页、加载状态、错误、页码切换。
- `src/hooks/useReportDetail.ts`
  - 通过 `batchId` 读取 `/api/report/history/:batchId`。
- `src/hooks/useTopOpportunityHistory.ts`
  - 管理 `/api/report/top-opportunities/history` 分页。
- `src/hooks/useReportPrompt.ts`
  - 读取 `/api/report/prompt`，供详情页直达时使用。

### 6. Routing and Pages

修改 `src/App.tsx`：
- 新增 `/reports` -> `ReportHistoryView`
- 新增 `/reports/:batchId` -> `ReportView`
- 新增 `/opportunities` -> `OpportunityHistoryView`
- 新增 `/top30-prompt` -> `Top30PromptView`
- 保留 `/report` 兼容旧入口：渲染 `ReportHistoryView`，或用 `<Navigate to="/reports" replace />`。

修改 `src/pages/ReportView.tsx`：
- 从单纯读 Zustand 改为：
  - 有 `batchId` 时用 `useReportDetail(batchId)` 获取历史详情。
  - 无 `batchId` 且 store 有 report 时展示当前 report。
  - 无数据时显示“暂无报告”，并提供返回 `/reports`。
- 原有 `ReportToolbar`、`UniverseTable`、`TopOpportunitiesPanel`、`BottomLosersPanel`、`RemainingStocksPanel`、`DataQualityPanel`、`MarkdownSourceDrawer` 保持复用。

新增 `src/pages/ReportHistoryView.tsx`：
- 展示报告中心历史列表，支持分页。
- 每条记录展示：生成时间、batchId、Top5 tickers、Bottom5 tickers、原始行数、数据质量状态。
- 点击进入 `/reports/:batchId` 查看完整报告详情。

新增 `src/pages/OpportunityHistoryView.tsx`：
- 展示历史 Top5 折叠列表，支持分页。
- 每个折叠项对应一份报告，标题展示 generatedAt、batchId、Top5 tickers。
- 默认展开第一页第一项；其他项折叠。
- 折叠内容复用或抽取 `TopOpportunityCard`，展示 ticker、verdict、track、optionStrategy、rationale，并提供实时行情链接 `/stocks/:ticker`。

新增 `src/pages/Top30PromptView.tsx`：
- 展示通俗说明、当前原始 Prompt 片段、来源标记和更新时间。
- 明确标注“当前保存的是已提供片段，后续可替换为完整 Prompt v3”。

### 7. Workspace Cards

修改 `src/pages/Dashboard.tsx`：
- 从 `useReportGeneration()` 取出 `recentReports`、`latestTopOpportunities`、`promptArchive`。
- 传给工作台卡片，减少各组件自行请求。

修改 `src/components/workspace/ResearchReportPanel.tsx`：
- 语义从“当前报告摘要”改为“报告中心摘要”。
- 工作台只展示最近 3 次历史记录。
- 每条记录展示 generatedAt、batchId、Top5 tickers、质量状态。
- 主按钮文案改为“查看更多报告”，链接 `/reports`。
- 如果刚生成报告，最近 3 条应包含最新报告；无历史时显示“生成报告后自动归档到这里”。

修改 `src/components/workspace/OpportunityCommandPanel.tsx`：
- 数据源改为 `latestTopOpportunities`，不再直接从 `report.analysis.topOpportunities` 读取。
- 工作台只展示最新一次报告的 Top5 操作机会。
- 按钮文案改为“查看历史 Top5”，链接 `/opportunities`。
- 若无历史 Top5，显示“生成报告后展示最新一次 Top5 操作机会”。

修改 `src/components/workspace/WatchlistPanel.tsx`：
- 改名建议：
  - 中文标题：`Top30 CSP 研究说明`
  - 英文标题：`Top30 CSP Research Brief`
  - 中文 eyebrow：`报告规则`
  - 英文 eyebrow：`Report Prompt`
- 内容不再只是 ticker badge。展示 `promptArchive.summary` 的通俗说明，并展示当前报告覆盖的 tickers badge（若有最新报告）。
- 增加入口按钮“查看原始 Prompt”，链接 `/top30-prompt`。

### 8. Navigation

修改 `src/components/common/AppNav.tsx`：
- Dashboard nav 中保留 `报告中心` hash。
- 顶层报告入口从 `/report` 调整到 `/reports`，文案为 `报告历史`。
- 增加可选入口 `机会历史` -> `/opportunities`，如果导航过密，可以只在机会指挥台卡片中提供入口。

### 9. Tests

新增 `tests/reportPersistence.test.ts`：
- 设置 `REPORT_PERSIST_TEST=1` 和临时 `REPORT_HISTORY_DB_PATH`。
- 验证 `appendReport` 后：
  - `readLatestReport` 返回完整报告。
  - `paginateReports` 返回 summary，Top5 tickers 正确。
  - `readLatestTopOpportunities` 返回 5 条且 `reportId`、`batchId` 映射一致。
  - `paginateTopOpportunityGroups` 按报告批次分页。

新增/修改 `tests/reportRoutes.test.ts`（如果当前没有 Express route 测试，则用 service 层测试覆盖 API 关键行为即可）：
- 验证 `/api/report/latest` 在内存为空时可从 SQLite 补水的逻辑可被 service 方法支持。

修改 `tests/reportRenderer.test.ts`：
- 不改变现有 Markdown 输出断言。
- 如新增 Prompt archive 测试，单独放在 `tests/reportPromptArchive.test.ts`，断言 summary 和 rawPrompt 片段存在。

前端由于当前项目没有 UI 测试框架，不新增浏览器自动化测试；通过 `npm run check` 和 `npm run test` 覆盖类型与业务逻辑。

## Assumptions & Decisions

- 使用独立 SQLite 文件 `.data/top30-report-history.sqlite3`，不复用模拟盘或实盘交易历史库，避免报告历史和交易历史生命周期混淆。
- Top5 机会必须单独落表 `report_top_opportunities`，每条通过 `report_id` 外键和 `batch_id` 双重关联报告，满足后续按报告回溯和按 ticker 检索扩展。
- `/report` 保留兼容，不作为新的主入口；新的报告中心主入口是 `/reports`，单份报告详情是 `/reports/:batchId`。
- 报告中心工作台只展示最近 3 次记录，二级页默认每页 10 条，最大 100 条。
- 机会指挥台工作台只展示最新一次报告的 Top5，历史页按报告批次分页，每页 10 个报告批次。
- 用户确认 Prompt 原文先保存当前已收到片段，不追求当前版本逐字完整；页面必须如实标注这是片段，后续可以替换完整 Prompt v3。
- `POST /api/report/render` 不持久化，只有正式生成 `/api/report/generate` 的结果持久化。
- 不改 Top5 评分算法，本次只优化存储、历史查询和展示结构。

## Verification Steps

1. 运行类型检查：

```bash
npm run check
```

2. 运行单元测试：

```bash
npm run test
```

3. 手动验证报告生成与持久化：
   - 启动服务后在工作台点击生成 Top30 报告。
   - 确认 `.data/top30-report-history.sqlite3` 生成。
   - 打开 `/reports`，确认历史列表包含最新报告且支持分页。
   - 点击某条历史进入 `/reports/:batchId`，确认完整报告详情、Top5、Bottom5、Markdown 源文件可正常展示。

4. 手动验证服务重启恢复：
   - 重启 `npm run dev`。
   - 直接打开 `/reports` 和 `/api/report/latest`，确认能从 SQLite 恢复最近报告。

5. 手动验证机会指挥台：
   - 工作台机会指挥台展示最新一次报告 Top5。
   - 点击“查看历史 Top5”进入 `/opportunities`，确认按报告批次展示多个折叠列表并支持分页。

6. 手动验证 Prompt 展示：
   - 工作台原 `Top30 观察列表` 区块已改为 `Top30 CSP 研究说明`。
   - 该卡片展示通俗说明和入口。
   - 打开 `/top30-prompt`，确认可看到当前保存的 Prompt v3 片段，并明确标注为用户提供片段。
