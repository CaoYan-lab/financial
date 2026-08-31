# 页面重规划：Web 可读报告与绝对股票金融助手工作台

## Summary

本计划用于落实用户对页面体验的重新规划：

1. 报告页不再以 Markdown 源文件作为主阅读体验，而是将 30 行纯数据表、Top 5 操作机会、Bottom 5 风险、其余股票分组、数据质量说明做成 Web 原生可读形态。
2. Alphabet/Google 股权类别统一使用 Google-C / `GOOG`，不使用 Google-A / `GOOGL` 作为分析 ticker。
3. 首页从简单 research/report 入口升级为“绝对股票金融助手工作台”，同时展示账户、持仓、风险、研究机会、Watchlist 与实盘交易预览门禁。
4. Futu OpenD 账户、持仓、行情、期权能力统一进入工作台，但第一阶段实盘交易只做订单预览与强确认门禁，不自动下单。

本计划以当前仓库实际状态为基础。若某项已经实现，执行阶段只做差异补齐、文案清理和验证，不重复重构。

## Current State Analysis

### 已确认的当前实现

- `src/pages/ReportView.tsx`
  - 已从 Markdown `<pre>` 主视图改为结构化报告页。
  - 已包含 `ReportToolbar`、锚点导航、`UniverseTable`、`TopOpportunitiesPanel`、`BottomLosersPanel`、`RemainingStocksPanel`、`DataQualityPanel`、`MarkdownSourceDrawer`。
  - 已支持 `zh` / `en` 语言切换。

- `src/components/report/MarkdownSourceDrawer.tsx`
  - Markdown 已降级为折叠源文件区。
  - 支持复制、下载、展开源文件。
  - 文案明确说明主阅读视图已结构化。

- `src/pages/Dashboard.tsx`
  - 已是双栏工作台布局。
  - 左栏包含账户摘要、持仓、风险、数据源状态。
  - 右栏包含机会、报告、Watchlist、实盘交易入口。

- `api/routes/accountRoutes.ts`
  - 已提供 `GET /api/account/dashboard`、`GET /api/account/summary`、`GET /api/account/positions`。
  - 失败时返回 `unavailable` 和 missing capability 风险提示。

- `api/routes/tradeRoutes.ts`
  - 已提供 `POST /api/trade/preview`。
  - 只返回订单预览，不提交真实订单。

- `src/components/workspace/LiveTradingPanel.tsx`
  - 已作为“实盘交易入口”显示。
  - 当前只调用预览接口，页面明确写明不会提交真实订单。

- `api/services/universeService.ts`
  - `GOOG` 与 `GOOGL` 已归并到 Alphabet。
  - preferred ticker 已设为 `GOOG`。
  - selected reason 已说明 `Selected GOOG (Google-C) as the requested analysis ticker.`。

- `tests/universeService.test.ts`
  - 已断言结果包含 `GOOG`。
  - 已断言结果不包含 `GOOGL`。

### 仍需收尾的观察项

- `src/pages/ReportView.tsx`
  - 空状态文案仍写“请先返回工作台生成一次 Markdown 报告”，应改为“生成一次可读投资报告”，避免用户误以为主体验仍是 Markdown。

- `src/components/ReportControls.tsx`
  - 当前未被引用，但文案仍是“生成 Markdown 报告”。
  - 执行阶段应确认是否删除该旧组件，或改为“生成可读报告”以避免未来误用。

- `src/components/MarkdownReport.tsx`
  - 当前未被引用。
  - 执行阶段应删除旧组件，或保留但标注 deprecated；优先删除以减少误导。

- 文案残留
  - 需要全局检查“Markdown 报告”是否作为主入口或主体验出现。
  - Markdown 只允许出现在“源文件 / 下载 / 复制 / 留档”上下文中。

## Proposed Changes

### 1. 报告页体验定稿

目标文件：

- `src/pages/ReportView.tsx`
- `src/components/UniverseTable.tsx`
- `src/components/report/ReportToolbar.tsx`
- `src/components/report/TopOpportunitiesPanel.tsx`
- `src/components/report/BottomLosersPanel.tsx`
- `src/components/report/RemainingStocksPanel.tsx`
- `src/components/report/DataQualityPanel.tsx`
- `src/components/report/MarkdownSourceDrawer.tsx`

执行要求：

- 保持报告页以结构化组件为主视图。
- 保持 `30 行纯数据表` 独立、可横向阅读，不混入评级或策略判断。
- Top 5 必须以卡片或结构化区块展示，不依赖 Markdown 表格阅读。
- 每个 Top 5 必须显式展示：
  - ticker / company / country
  - verdict
  - Track A / Track B / Both
  - current price / IV rank / support level / capital per contract
  - strike / expiry / premium / annualized return / DTE / earnings flag / special flags
  - rationale
- Bottom 5 必须以风险卡片展示：
  - verdict
  - why loser
  - risk factor
  - put-selling view
- 其余股票必须按 Attractive / Neutral / Trim risk 分组。
- Markdown 只能作为折叠源文件，默认不展开。
- 报告空状态文案改为“请先返回工作台生成一次可读投资报告。”

### 2. Google-C / GOOG 规则固化

目标文件：

- `api/services/universeService.ts`
- `api/providers/stockAnalysisUniverseProvider.ts`
- `api/services/analysisService.ts`
- `tests/universeService.test.ts`

执行要求：

- Alphabet 多股权类别统一分析 `GOOG`。
- `GOOGL` 只允许作为输入归并测试或源数据去重中出现，不允许作为最终 30 行分析 ticker 出现。
- fallback universe 中使用 `GOOG`。
- moat / quality list 中使用 `GOOG`。
- 测试必须覆盖：
  - 输入同时包含 `GOOG` 和 `GOOGL` 时，输出仅保留 `GOOG`。
  - 输出仍保持 30 家公司。

### 3. 首页工作台定稿

目标文件：

- `src/pages/Dashboard.tsx`
- `src/components/workspace/CommandCenterHeader.tsx`
- `src/components/workspace/AccountSummaryPanel.tsx`
- `src/components/workspace/PositionsPanel.tsx`
- `src/components/workspace/RiskExposurePanel.tsx`
- `src/components/workspace/OpportunityCommandPanel.tsx`
- `src/components/workspace/ResearchReportPanel.tsx`
- `src/components/workspace/WatchlistPanel.tsx`
- `src/components/workspace/LiveTradingPanel.tsx`
- `src/components/workspace/OrderPreviewDrawer.tsx`

执行要求：

- 首页标题明确为金融助手工作台，而不是 research/report landing page。
- 保持双栏并重：
  - 左栏：账户资产、现金、购买力、持仓、组合风险、数据源状态。
  - 右栏：Top 5 / Bottom 5 机会摘要、报告中心、Watchlist、实盘交易入口。
- 报告中心按钮文案使用“查看 Web 可读报告”或等价表述。
- 若尚未生成报告，右栏应展示空状态和行动按钮，不应显示 Markdown 源文件入口。
- 数据缺失统一显示 `unavailable`，不编造账户、持仓、IV、premium、RSI 等字段。

### 4. Futu OpenD 账户/持仓接入

目标文件：

- `api/futu_bridge/futu_account.py`
- `api/routes/accountRoutes.ts`
- `src/hooks/useAccountDashboard.ts`
- `src/stores/workspaceStore.ts`
- `shared/types.ts`

执行要求：

- `GET /api/account/dashboard` 作为首页账户数据主入口。
- 账户 bridge 仅做只读查询：
  - account summary
  - positions
  - portfolio risk summary
  - trading environment status
- 如果 Futu OpenD 未登录、交易权限不足或账户接口失败：
  - `ok` 为 `false` 或包含 missing capability。
  - 关键字段返回 `unavailable`。
  - UI 显示明确提示，不阻塞研究报告生成。
- 不在应用中绕过 Futu 的交易安全机制，不自动 unlock trade。

### 5. 实盘交易入口安全门禁

目标文件：

- `api/futu_bridge/futu_trade_preview.py`
- `api/routes/tradeRoutes.ts`
- `src/hooks/useTradePreview.ts`
- `src/components/workspace/LiveTradingPanel.tsx`
- `src/components/workspace/OrderPreviewDrawer.tsx`

执行要求：

- 第一阶段只实现 `POST /api/trade/preview`。
- 预览接口必须校验：
  - ticker 必填。
  - side 必须为 `BUY` 或 `SELL`。
  - quantity 必须大于 0。
  - LIMIT order 必须有正数 limit price。
- 返回内容必须包含：
  - estimated notional
  - risk warnings
  - canSubmitLiveOrder
- 默认 `canSubmitLiveOrder` 必须为 `false`。
- 即使用户输入确认短语，本阶段 UI 也不提供真实提交按钮。
- Top 5 研究结果不得自动生成或自动提交真实订单。

### 6. 旧组件与文案清理

目标文件：

- `src/components/MarkdownReport.tsx`
- `src/components/ReportControls.tsx`
- `src/pages/ReportView.tsx`
- 其他包含“Markdown 报告”主体验措辞的前端文件

执行要求：

- 如果 `MarkdownReport.tsx` 未被引用，删除该文件。
- 如果 `ReportControls.tsx` 未被引用，删除该文件；若保留，则文案从“Markdown 报告”改为“可读投资报告”。
- 全局搜索并修正“生成 Markdown 报告”等误导性主入口文案。
- 保留 Markdown 相关措辞仅限：
  - Markdown 源文件
  - 复制 Markdown
  - 下载 Markdown
  - 留档

## Assumptions & Decisions

- 报告主阅读体验为 Web 结构化页面；Markdown 只作为源文件和归档。
- 语言策略为 Web 页面中 `中文 / English` 切换；Markdown 源文件仍可保持中英双语。
- 首页策略为双栏并重，不把账户信息藏在二级页面。
- Futu OpenD 账户和持仓是只读数据源；交易入口第一阶段只做预览。
- `GOOG` 是 Alphabet 最终分析 ticker；`GOOGL` 只允许在输入归并或测试场景中出现。
- 不新增数据库，不新增复杂权限系统；状态仍通过前端 store 与后端实时查询维护。
- 缺失字段必须显示 `unavailable`，不做伪造、拼接或跨日期补数。

## Verification Steps

### 自动化验证

执行：

```bash
PATH=/Users/ShockCao/AICoding/Financial/.tools/node/bin:$PATH npm run check
PATH=/Users/ShockCao/AICoding/Financial/.tools/node/bin:$PATH npm test
PATH=/Users/ShockCao/AICoding/Financial/.tools/node/bin:$PATH npm run build
```

验收：

- TypeScript 无错误。
- Vitest 全部通过。
- production build 成功。

### API Smoke Test

验证接口：

- `GET /api/source/status`
- `GET /api/account/dashboard`
- `POST /api/report/generate`
- `POST /api/trade/preview`

验收：

- 报告返回 30 行 rawData。
- rawData 中包含 `GOOG`，不包含 `GOOGL`。
- account dashboard 可返回真实账户/持仓，或明确返回 unavailable/missing capability。
- trade preview 返回 estimated notional。
- trade preview 默认 `canSubmitLiveOrder === false`。

### Browser 验证

首页验收：

- 顶部显示金融助手工作台定位。
- 左栏显示账户、持仓、风险、数据源。
- 右栏显示机会摘要、报告中心、Watchlist、实盘交易入口。
- 实盘交易入口明确提示只生成订单预览，不提交真实订单。

报告页验收：

- 语言切换可用。
- 30 行纯数据表可读。
- Top 5 是 Web 卡片/结构化策略，不是 Markdown 表格。
- Bottom 5 是风险卡片。
- 其余股票按组展示。
- Markdown 源文件默认折叠，仍可复制和下载。

### 文案验收

- 页面主入口不再出现“生成 Markdown 报告”。
- 空状态不再提示“生成 Markdown 报告”。
- Markdown 只作为源文件、下载、复制、归档出现。
- Alphabet/Google 的最终展示 ticker 为 `GOOG`。

## Execution Order

1. 清理报告页空状态和旧组件文案，删除未引用的 `MarkdownReport.tsx` / `ReportControls.tsx`。
2. 复核并补齐 `GOOG` 规则在 universe、fallback、analysis、测试中的一致性。
3. 复核报告页结构化展示是否覆盖 Top 5、Bottom 5、Remaining、Data Quality、Markdown Source。
4. 复核首页工作台是否完整覆盖账户、持仓、风险、研究、Watchlist、交易预览。
5. 复核 Futu account/trade preview 后端失败降级与安全门禁。
6. 运行类型检查、测试、构建。
7. 启动本地服务并进行 API smoke test 与浏览器验证。
8. 输出最终实现摘要和验证结果。
