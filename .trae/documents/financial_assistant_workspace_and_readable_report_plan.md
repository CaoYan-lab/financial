# 金融助手工作台与可读 Web 报告重构规划

## 1. Summary

本次重构目标有两部分：

1. **报告页重构**：当前 `ReportView` 只是把 Markdown 源文件放进 `<pre>`，Top 5、Bottom 5、卖 Put 操作指引都在 Markdown 表格里，不适合阅读和操作。需要改成 Web 原生可读报告视图：30 行纯数据表可读，Top 5/Bottom 5/其余 20 只股票以卡片、结构化表格、风险标签、策略区块展示；Markdown 保留为“复制/下载源文件”，不再作为主阅读界面。
2. **首页工作台重构**：当前 `Dashboard` 是简单研究报告入口。由于 Futu OpenD / futuapi 已具备账户、持仓、交易等接口能力，首页应升级为用户的“绝对股票金融助手工作台”：双栏并重，左侧账户/持仓/风险，右侧研究/机会/CSP 报告，并预留实盘交易入口。

已确认用户偏好：

- Google/Alphabet 多股权类别使用 **Google-C / GOOG**，不要使用 Google-A / GOOGL。
- 首页工作台：**双栏并重**。
- 交易范围：**预留实盘入口**。
- Web 报告语言：**语言切换**，而不是双语长页面或只中文。

## 2. Current State Analysis

### 2.1 报告页当前状态

相关文件：

- `src/pages/ReportView.tsx`
  - 当前只显示：
    - 返回工作台按钮
    - `UniverseTable`
    - `MarkdownReport`
    - 数据质量摘要
  - 没有结构化展示 `report.analysis.topOpportunities`、`bottomLosers`、`groupedSummary`。

- `src/components/MarkdownReport.tsx`
  - 当前主视图是：
    - 标题“中英双语报告”
    - 复制按钮
    - 下载 `.md` 按钮
    - 一个 `<pre>` 展示完整 Markdown 字符串
  - 这导致 Top 5、Bottom 5、Sell Put Strategy 等长表格非常不可读。

- `src/components/UniverseTable.tsx`
  - 已经展示 30 行纯数据表，但只是宽表。
  - 可改进点：
    - 增加列分组和字段强调。
    - 增加 sticky ticker/rank。
    - 增加 compact/detail 切换或横向滚动提示。

- `api/services/reportRenderer.ts`
  - 后端仍生成 Markdown 源文件，适合保留作复制/下载。
  - 不应再依赖解析 Markdown 来渲染页面，因为 `ReportGenerationResult` 已经包含结构化数据：
    - `rawData`
    - `analysis.companyAnalyses`
    - `analysis.topOpportunities`
    - `analysis.bottomLosers`
    - `analysis.groupedSummary`

### 2.2 首页工作台当前状态

相关文件：

- `src/pages/Dashboard.tsx`
  - 当前是报告生成控制 + 数据源状态 + 最近报告摘要 + pipeline。
  - 不包含账户、资产、现金、持仓、风险敞口、交易入口、观察列表等金融助手能力。

- `src/components/DataSourcePanel.tsx`
  - 当前已展示 Futu OpenD、Python SDK、登录、期权、K 线等状态。
  - 可复用为工作台系统状态区。

- `src/hooks/useReportGeneration.ts`
  - 只负责 source status 和 report generation。
  - 需要拆分或新增账户/持仓 hook。

- `src/stores/reportStore.ts`
  - 只存 report/sourceStatus/generation 状态。
  - 需要新增 portfolio/account/trading state。

### 2.3 Google-C / GOOG 当前问题

相关文件：

- `api/services/universeService.ts`

当前逻辑：

```ts
GOOG: { group: 'Alphabet', preferredTicker: 'GOOGL' },
GOOGL: { group: 'Alphabet', preferredTicker: 'GOOGL' },
```

需要改为：

```ts
GOOG: { group: 'Alphabet', preferredTicker: 'GOOG' },
GOOGL: { group: 'Alphabet', preferredTicker: 'GOOG' },
```

同时更新测试中关于 Google ticker 的断言。

### 2.4 Futu OpenD 当前能力与缺口

已存在：

- `api/providers/futuOpenDProvider.ts`
  - 行情 provider。
  - 已调用 Python Bridge 获取市场快照、K 线、期权链。

- `api/futu_bridge/futu_snapshot.py`
  - 市场快照、技术指标、期权数据。

- `api/futu_bridge/futu_status.py`
  - OpenD、SDK、登录、期权、技术指标状态。

需要新增：

- 账户资产查询 bridge。
- 持仓查询 bridge。
- 订单/交易入口 bridge 或 route。
- 前端账户和持仓展示。
- 实盘交易入口门禁。

安全决策：

- 第一版实现“实盘入口”但必须有强安全门禁：
  - 页面上明确区分“只读账户/持仓”和“实盘交易入口”。
  - 下单 API 默认不自动执行。
  - 如果实现提交订单 route，必须要求请求体显式包含 `confirmLiveTrade: true` 和用户输入确认短语。
  - UI 上先做 Order Ticket / Preview，提交按钮默认 disabled，直到用户确认。
  - 不在后台自动根据 Top 5 直接下单。

## 3. Proposed Changes

### 3.1 报告页改为 Web 原生可读报告

更新 `src/pages/ReportView.tsx`

改为以下结构：

1. 顶部报告工具栏
   - 返回工作台
   - 语言切换：`中文 / English`
   - 复制 Markdown
   - 下载 Markdown
   - 批次 ID、生成时间、数据质量状态

2. 报告导航锚点
   - `Raw Data`
   - `Top 5 Opportunities`
   - `Bottom 5 Risks`
   - `Remaining 20`
   - `Data Quality`

3. 原始数据区
   - 继续使用 `UniverseTable`，但优化可读性。
   - 原始数据表仍不混入分析判断。

4. Top 5 机会区
   - 新增 `TopOpportunitiesPanel`。
   - 每个 Top 5 用 card 展示：
     - rank / ticker / company / country
     - verdict badge
     - Track A/B/Both badge
     - current price / IV rank / support level / capital per contract
     - Sell Put Strategy 独立策略框：
       - Strike
       - Expiry
       - Premium
       - Annualized Return
       - Earnings Flag
       - Flags
     - Rationale 用短段落展示，不放 Markdown 表格里。

5. Bottom 5 风险区
   - 新增 `BottomLosersPanel`。
   - 每个 loser 用风险卡片：
     - verdict
     - why loser
     - risk factor
     - put-selling view
   - 使用红/琥珀风险视觉。

6. 其余 20 只分组区
   - 新增 `RemainingStocksPanel`。
   - 三组：
     - Attractive but not top 5
     - Neutral / Hold
     - Trim / Watchlist risk
   - 每组用 ticker chips + 展开明细。

7. Markdown 源文件区
   - `MarkdownReport` 改名或变成 `MarkdownSourceDrawer`。
   - 默认折叠。
   - 保留复制和下载。
   - 明确标注“源文件 / Source Markdown，不是主阅读视图”。

### 3.2 新增报告展示组件

新增 `src/components/report/ReportToolbar.tsx`

职责：
- 显示标题、语言切换、复制/下载、批次信息。
- 语言状态由 `ReportView` 控制，类型为 `'zh' | 'en'`。

新增 `src/components/report/TopOpportunitiesPanel.tsx`

职责：
- 接收 `topOpportunities: CompanyAnalysis[]` 和 `language`。
- 用卡片展示 Top 5 可操作机会。
- Sell Put Strategy 独立拆字段展示，不再拼成长字符串。

新增 `src/components/report/BottomLosersPanel.tsx`

职责：
- 接收 `bottomLosers: CompanyAnalysis[]` 和 `language`。
- 用风险卡片展示 Bottom 5。

新增 `src/components/report/RemainingStocksPanel.tsx`

职责：
- 接收 `groupedSummary` 和 `language`。
- 三组展示其余股票，支持展开/收起。

新增 `src/components/report/DataQualityPanel.tsx`

职责：
- 接收 `dataQuality`。
- 展示 sources、timestamp、unavailable summary、issues。

新增 `src/components/report/MarkdownSourceDrawer.tsx`

职责：
- 替代当前 `MarkdownReport` 主展示。
- 默认折叠，保留复制/下载。

新增 `src/components/common/Badge.tsx`

职责：
- 统一渲染 verdict、track、risk、unavailable、source status 等标签。

新增 `src/components/common/MetricCard.tsx`

职责：
- 统一渲染数值卡片，供首页和报告页复用。

### 3.3 优化 30 行纯数据表

更新 `src/components/UniverseTable.tsx`

改进：
- 增加 `language` prop。
- 表头支持中文/英文切换。
- ticker/rank sticky left。
- 对 `unavailable`、非美国 ADR、High Capital、Low IV 等字段用 badge。
- 列分组：
  - Identity：Rank、Ticker、Company、Country
  - Market：Price、Market Cap、P/E
  - Technical：RSI、50MA、200MA
  - Options：IV Rank、IV 30D、Capital
  - Events：Earnings、News
- 保持事实表纯数据，不加入 verdict 或 strategy。

### 3.4 首页升级为“绝对股票金融助手工作台”

更新 `src/pages/Dashboard.tsx`

采用双栏并重布局：

1. 顶部 Command Center
   - 标题：`Financial Assistant Command Center`
   - Futu OpenD 状态
   - 账户连接状态
   - 生成报告按钮
   - 刷新账户/持仓按钮
   - 实盘交易入口状态提示

2. 左栏：账户与持仓
   - `AccountSummaryPanel`
     - 总资产
     - 现金
     - 可用购买力
     - 当日 P/L
     - 总 P/L
     - 币种
   - `PositionsPanel`
     - ticker
     - qty
     - market value
     - cost
     - unrealized P/L
     - position ratio
   - `RiskExposurePanel`
     - 单票集中度
     - 现金占比
     - 高资本需求 CSP exposure
     - Top 30 overlap

3. 右栏：研究与机会
   - `OpportunityCommandPanel`
     - Top 5 CSP 快览
     - Bottom 5 风险快览
     - 低 IV 等待清单
   - `ResearchReportPanel`
     - 最近报告摘要
     - 进入可读报告页
     - Markdown 下载
   - `WatchlistPanel`
     - 第一版可从 Top 30 rawData 自动生成 watchlist。
     - 后续再扩展手动添加。

4. 底部：实盘交易入口
   - `LiveTradingPanel`
   - 第一版只作为安全门禁入口和订单预览入口：
     - 显示“实盘交易高风险”
     - 显示账户/交易环境状态
     - 提供“创建订单草稿”入口
     - 不自动下单

### 3.5 新增账户/持仓后端能力

新增 `api/futu_bridge/futu_account.py`

职责：
- 调用 Futu trade context 获取账户资产和持仓。
- 只读接口：
  - 账户资金/资产摘要。
  - 持仓列表。
- 输出结构化 JSON。
- 如果交易解锁、账户权限、OpenD 登录不足，返回 `unavailable` 和 missing capabilities。

注意：
- Futu 账户/持仓通常需要 TradeContext，并可能涉及交易环境、市场、账户 ID。
- 第一版不在后台执行 `unlock_trade`。
- 如必须解锁才能查询，返回清晰提示，让用户在 OpenD 或 Futu 客户端完成必要动作。

新增 `api/routes/accountRoutes.ts`

路由：
- `GET /api/account/summary`
- `GET /api/account/positions`
- `GET /api/account/dashboard`

`/api/account/dashboard` 聚合 summary + positions，供首页一次请求。

更新 `api/app.ts`

- 注册 `app.use('/api/account', accountRoutes)`。

新增共享类型 `shared/types.ts`

- `AccountSummary`
- `Position`
- `PortfolioRiskSummary`
- `AccountDashboardResponse`
- `TradingEnvironmentStatus`

### 3.6 实盘交易入口规划

新增 `api/futu_bridge/futu_trade_preview.py`

职责：
- 根据用户输入 order draft 做字段校验。
- 不直接下单。
- 返回：
  - orderSide
  - ticker
  - qty
  - orderType
  - limitPrice
  - estimatedNotional
  - riskWarnings

可选新增 `api/routes/tradeRoutes.ts`

第一版建议只实现：
- `POST /api/trade/preview`

暂不实现真实 `place-order`，或者实现但默认不在 UI 暴露。若执行阶段必须加入真实入口，则必须：
- 请求体含 `confirmLiveTrade: true`
- 请求体含 `confirmationText: 'I understand this is a live order'`
- 后端重复校验。
- UI 二次确认弹窗。

本计划默认第一阶段实现 **实盘交易入口 + 订单预览**，不自动提交实盘订单。

### 3.7 前端账户与交易组件

新增目录 `src/components/workspace/`

新增：
- `CommandCenterHeader.tsx`
- `AccountSummaryPanel.tsx`
- `PositionsPanel.tsx`
- `RiskExposurePanel.tsx`
- `OpportunityCommandPanel.tsx`
- `ResearchReportPanel.tsx`
- `WatchlistPanel.tsx`
- `LiveTradingPanel.tsx`
- `OrderPreviewDrawer.tsx`

新增 hooks：
- `src/hooks/useAccountDashboard.ts`
- `src/hooks/useTradePreview.ts`

更新 store：
- `src/stores/reportStore.ts`
  - 保持 report/sourceStatus。
- 新增 `src/stores/workspaceStore.ts`
  - 存 account dashboard、positions、trade preview、loading/error。

### 3.8 Google-C / GOOG 修正

更新 `api/services/universeService.ts`

- Alphabet preferred ticker 改为 `GOOG`。
- selectedTickerReason 改为：
  - `Selected GOOG (Google-C) as the requested analysis ticker.`

更新测试：
- `tests/universeService.test.ts`
  - 断言包含 `GOOG`。
  - 断言不包含 `GOOGL`。

更新文案：
- 报告和 UI 中若出现 Google/Alphabet ticker，以 `GOOG` 展示。

### 3.9 更新 Markdown 源文件策略

保留 `api/services/reportRenderer.ts`

- 后端仍生成 Markdown 源文件，满足下载、复制、留档。
- 不把 Markdown 当 Web 主报告。

前端行为：
- 主报告使用结构化 React 组件。
- Markdown 源文件放在折叠抽屉中。
- 下载文件名保持 `top30-csp-report-{batchId}.md`。

## 4. Assumptions & Decisions

- 第一版报告页语言切换只影响 Web 可读视图；Markdown 源文件仍保留中英双语完整文本。
- 第一版账户/持仓展示以 Futu OpenD 可返回字段为准；缺字段统一显示 `unavailable`。
- 第一版实盘入口实现为强安全门禁 + 订单预览，不自动下单。
- 若 Futu 账户/持仓接口需要额外权限或解锁，本应用不绕过安全机制，只展示明确提示。
- Universe 仍按 StockAnalysis / CompaniesMarketCap；只改 Alphabet 分析 ticker 为 `GOOG`。
- 不增加数据库；账户/报告状态仍以前端 store + 后端实时查询为主。
- 不删除 Markdown 下载能力，只降低它在 UI 中的主阅读地位。

## 5. Verification Steps

### 5.1 自动化验证

运行：

```bash
PATH=/Users/ShockCao/AICoding/Financial/.tools/node/bin:$PATH npm run check
PATH=/Users/ShockCao/AICoding/Financial/.tools/node/bin:$PATH npm test
PATH=/Users/ShockCao/AICoding/Financial/.tools/node/bin:$PATH npm run build
```

更新/新增测试：

- `tests/universeService.test.ts`
  - Google preferred ticker 从 `GOOGL` 改为 `GOOG`。
- 新增 `tests/accountRoutes.test.ts` 或 `tests/accountBridge.test.ts`
  - Mock 账户数据可正常标准化。
  - 权限不足时返回 `unavailable`。
- 新增/更新报告 UI 相关可测试逻辑：
  - Top 5 strategy 字段不再只能通过 Markdown 字符串读取。

### 5.2 API Smoke Test

- `GET /api/source/status`
- `GET /api/account/dashboard`
- `POST /api/report/generate`
- `POST /api/trade/preview`（如第一版实现）

预期：
- Futu OpenD 可用时返回账户/持仓或明确权限提示。
- 报告仍返回 30 行 rawData。
- GOOG 替代 GOOGL。

### 5.3 浏览器验证

- 首页：
  - 显示双栏工作台。
  - 左侧显示账户/持仓/风险。
  - 右侧显示研究机会和报告入口。
  - 实盘入口以风险门禁形式出现。
- 报告页：
  - 语言切换可用。
  - 30 行纯数据表可读。
  - Top 5 是卡片/结构化策略，不是 Markdown 表格。
  - Bottom 5 是风险卡片。
  - Markdown 源文件默认折叠，仍可复制/下载。

### 5.4 文案残留检查

- 检查不再出现“Markdown 报告”为主阅读入口。
- 检查 Alphabet/Google 不再默认使用 `GOOGL`。
- 检查实盘入口均有明确风险提示。

## 6. Execution Order

1. 修改 `universeService`，将 Alphabet preferred ticker 改为 `GOOG`，并更新测试。
2. 新增报告可读组件目录 `src/components/report/`。
3. 重构 `ReportView`，用结构化组件展示报告，保留 Markdown 折叠抽屉。
4. 优化 `UniverseTable` 的可读性和语言切换。
5. 新增账户/持仓共享类型。
6. 新增 Futu account Python Bridge 和 `/api/account/*` 路由。
7. 新增 workspace store 与账户 hook。
8. 新增工作台组件并重构 `Dashboard` 为双栏金融助手。
9. 新增实盘交易入口 UI 和订单预览 route/hook。
10. 更新文档和相关文案。
11. 运行类型检查、测试、构建和浏览器验证。

