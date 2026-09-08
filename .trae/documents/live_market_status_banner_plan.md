# Futu 与 Longbridge 实盘评估状态 Banner 实施计划

## Summary

在 Futu 与 Longbridge 实盘交易页顶部增加统一的“实盘评估状态” Banner。Banner 区分引擎停止、正常评估、部分市场可评估、全部休市等待、状态异常，并提供“详情说明”弹窗。弹窗同时展示当前策略配置、执行模式，以及股票池内每个标的的市场状态、是否参与本轮评估和跳过原因。

市场休市、午休、节假日和默认关闭的美股夜盘只作为实时状态返回，不写策略信号，也不写逐标的跳过记录。行情失败、模型失败、风险拦截和去重等非市场时段问题维持现有记录逻辑。

## Current State Analysis

- `api/live/liveTradingEngine.ts`
  - Futu Dashboard 已通过 `loadMarketSessions()` 返回 `universe[].marketSession`。
  - 市场门禁命中时不会写 `latestSignals`，但会调用 `liveOrderQueueService.recordSkipped()` 持久化逐标的休市记录。
- `api/longbridge/longbridgeLiveTradingEngine.ts`
  - 旧 Longbridge 引擎通过实时缓存中的 `marketState` 做运行前门禁。
  - 市场门禁命中时不会写信号，但会调用 `recordLongbridgeSkipped()` 持久化逐标的休市记录。
  - Dashboard 当前没有结构化的全股票池市场状态。
- `api/cloud/multiuser/longbridge/tenantStrategyService.ts`
  - 租户引擎已使用真实交易日历和交易所时区判断港股、美股时段。
  - 市场门禁命中时仍由 `appendTenantSkippedSignal()` 写入 `kind='signals'`，造成页面上的“风控拦截”伪信号。
- `api/cloud/multiuser/longbridge/tenantDataService.ts`
  - 租户 Dashboard 只有引擎、信号、待确认订单和候选池，没有结构化市场运行状态。
- `shared/types.ts`、`shared/longbridgeTypes.ts`
  - 现有 `MarketSessionStatus` 可表达原始市场状态，但缺少面向 Banner 的总体状态、逐标的评估结论和原因。
- `src/pages/LiveTradingView.tsx`、`src/pages/longbridge/LongbridgeLiveTradingView.tsx`
  - 两个页面均已有策略配置数据和 30 秒 Dashboard 刷新链路。
  - 顶部控制区后尚无统一运行状态 Banner。
- `TradeStrategyConfigPanel.tsx`
  - 已有策略版本、提示词版本和执行模式信息，可复用其数据，不在新接口重复维护策略目录。

## Proposed Changes

### 1. 定义统一的只读运行状态契约

修改 `shared/types.ts`：

- 新增 `LiveEvaluationStatus`：
  - `state`: `STOPPED | RUNNING | PARTIAL | WAITING_MARKET | ERROR`
  - `title`、`summary`
  - `activeCount`、`waitingCount`、`totalCount`
  - `updatedAt`
  - `items: LiveEvaluationTickerStatus[]`
- 新增 `LiveEvaluationTickerStatus`：
  - `ticker`、`market`
  - `marketState`、`marketLabel`
  - `evaluationState`: `ACTIVE | WAITING_MARKET | DISABLED | ERROR`
  - `reason`
- 在 `LiveTradingDashboardResponse` 和 `LongbridgeLiveTradingDashboardResponse` 中增加必填 `evaluationStatus`。

状态聚合规则：

- 引擎未启动：`STOPPED`。
- 引擎运行且全部标的被市场时段门禁跳过：`WAITING_MARKET`。
- 引擎运行且部分标的可评估、部分等待：`PARTIAL`。
- 引擎运行且全部可评估：`RUNNING`。
- 市场日历或状态源无法确认时按现有 fail-closed 规则标记对应标的 `ERROR`，总体为 `ERROR`；不触发模型。

### 2. 抽取市场状态到 Banner 状态的纯转换逻辑

新增 `api/trading/liveEvaluationStatusService.ts`：

- 接收引擎运行状态、股票池、每个标的的市场状态、`disableUsOvernightLlm` 和更新时间。
- 复用 `llmMarketSessionSkipReason()`，保证 Banner 与实际执行门禁使用同一判定。
- 统一生成中文市场标签、逐标的评估状态和总体状态。
- 不访问数据库、不写事件，便于 Futu、Longbridge 和租户链路复用及单元测试。

### 3. Futu Dashboard 接入状态且停止持久化休市跳过

修改 `api/live/liveTradingEngine.ts`：

- 在现有 `loadMarketSessions()` 后构造 `evaluationStatus` 并放入 Dashboard。
- `stop()` 使用最近市场状态生成停止态 Banner。
- 在市场时段预检分支中移除仅因休市、午休、节假日或夜盘关闭而触发的 `recordSkipped()`；日志保留。
- 行情过期、数据不足、去重、风控等非市场时段跳过仍按现有逻辑记录。

### 4. Longbridge 全局与多用户 Dashboard 接入统一状态

修改 `api/longbridge/longbridgeLiveTradingEngine.ts`：

- 从 `longbridgeRealtimeStore` 的股票池快照生成全量市场状态，而不只生成跳过列表。
- Dashboard 增加 `evaluationStatus`。
- 市场门禁分支不再调用 `recordLongbridgeSkipped()`；保留结构化日志。
- 非市场时段错误继续使用原有 skipped/错误机制。

修改 `api/cloud/multiuser/longbridge/tenantStrategyService.ts`：

- 导出或抽取可复用的租户股票池市场状态读取函数，仍使用 Longbridge `tradingDays()`、交易所时区及 fail-closed 规则。
- 删除 `appendTenantSkippedSignal()` 及两个市场门禁分支对它的调用。
- 市场门禁命中只返回 `{ skipped: true, marketState, error }`，供本轮汇总和日志使用，不执行任何事件插入。
- 行情读取失败等非休市故障保持现有信号/错误记录行为。

修改 `api/cloud/multiuser/longbridge/tenantDataService.ts`：

- Dashboard 加载当前股票池市场状态并构造 `evaluationStatus`。
- `signals` 查询增加服务端兼容过滤，排除历史上 `status='SKIPPED'` 且可明确识别为市场时段门禁的伪信号。
- 历史分页接口对 `kind='signals'` 应用相同过滤，确保分页总数与页面结果一致。

### 5. 精准清理历史休市伪信号

修改 `deploy/volcano/pg/multiuser_schema.sql`：

- 增加幂等清理语句，只删除同时满足以下条件的租户事件：
  - `kind='signals'`
  - `status='SKIPPED'`
  - `payload.lifecycleStatus='SKIPPED'`
  - `payload.marketState` 为已知非评估市场状态
  - 原因匹配现有港股休市、美股休市或夜盘关闭门禁文案
- 不删除行情不可用、模型失败、风险拦截、去重和其他真实运行记录。

保留读取侧过滤作为旧环境未执行清理、滚动发布期间和漏清数据的兼容保护。

### 6. 新增共享 Banner 与详情弹窗

新增 `src/components/trading/LiveEvaluationStatusBanner.tsx`：

- 使用同一组件渲染 Futu 和 Longbridge，仅通过 `accent: 'futu' | 'longbridge'` 切换橙色/蓝色主题。
- 外框 24px 圆角，内部状态块 16px 圆角。
- Banner 展示：总体状态、可评估/等待数量、简短原因、更新时间和“详情说明”按钮。
- 状态视觉：
  - 停止：中性灰。
  - 正常运行：明确但克制的成功态。
  - 部分运行：提示态。
  - 全部等待开市：信息态，不使用“风控拦截”措辞。
  - 异常：错误态。
- 使用 Lucide 图标，按钮和图标提供中文 `title`/无障碍标签。

新增 `src/components/trading/LiveEvaluationStatusDialog.tsx`：

- 页面内模态弹窗，支持关闭按钮、遮罩点击和 Escape 关闭；限制高度并允许内容区滚动。
- “当前策略”区读取页面已有 `TradeStrategyConfigResponse`，展示当前策略版本、提示词版本、执行模式以及全部可用策略版本，并标明当前启用项。
- “全部标的状态”区展示股票池内每个标的的市场、中文市场状态、当前是否评估和原因。
- 不提供策略修改入口；修改仍由现有 `TradeStrategyConfigPanel` 承担。
- 所有用户可见文案使用中文，不显示 `CLOSED` 等裸英文状态码。

### 7. 两个平台页面接入

修改 `src/pages/LiveTradingView.tsx`：

- 在顶部操作 Header 之后、错误提示之前插入共享 Banner。
- 向详情弹窗传入 `data.evaluationStatus` 和现有 `tradeStrategyConfig`。
- 历史信号列表不再把市场休市展示为 `SKIPPED` 信号；真实风控跳过仍保留原状态。

修改 `src/pages/longbridge/LongbridgeLiveTradingView.tsx`：

- 在与 Futu 相同位置接入共享 Banner 和详情弹窗。
- 传入 `longbridgeLive.data.evaluationStatus` 与 `liveConfig.tradeStrategyConfig`。
- owner/admin 与多用户租户共用相同组件和交互，数据由各自 Dashboard 路由提供。

`src/hooks/useLiveTrading.ts`、`src/hooks/useLongbridgeLiveTrading.ts`：

- 保持现有 30 秒刷新机制。
- 更新响应类型守卫，要求并校验 `evaluationStatus`；控制指令完成后的 Dashboard 也同步刷新 Banner。

### 8. 测试

新增 `tests/liveEvaluationStatusService.test.ts`：

- 覆盖停止、全开市、部分开市、全部休市、美股夜盘关闭、夜盘开启和状态源不可用。
- 验证总体计数、中文摘要和逐标的原因与执行门禁一致。

修改 `tests/multiuser/tenantStrategyService.test.ts`：

- 休市时断言不请求模型、不读取账户、不插入任何 `signals` 事件。
- 全池休市仍为 `skippedCount=N`、`failedCount=0`、`ok=true`。
- 行情失败等非市场故障继续按原约定记录。

补充/修改 Dashboard 与路由测试：

- Futu、Longbridge 全局、多用户 Longbridge 均返回完整 `evaluationStatus`。
- 多用户信号列表和分页总数过滤历史休市伪信号。
- 策略状态数据不包含其他用户账户信息。

新增组件测试或 Playwright 场景：

- Futu 和 Longbridge 页面均在顶部显示 Banner。
- 引擎停止、运行、部分市场开放、全部休市文案正确。
- 点击“详情说明”打开弹窗，可见全部策略版本及全股票池标的状态。
- 弹窗可通过关闭按钮、遮罩和 Escape 关闭，移动端无溢出或遮挡。
- 页面不再出现由市场休市生成的“风控拦截”信号卡片。

## Assumptions & Decisions

- “所有策略”确定为同时展示全部策略版本/当前执行模式，以及全股票池每个标的的当前评估状态。
- 详情使用页面内弹窗，不新增路由。
- 市场休市类跳过完全不落库，只通过 Dashboard 实时计算；普通风控、行情错误、模型错误和去重记录不受影响。
- 对既有租户休市伪信号执行精准清理，并保留接口过滤兜底。
- Banner 只反映评估运行状态，不改变启动、停止、单轮评估、自动下单或人工确认逻辑。
- Futu 和 Longbridge 信息架构、交互和文案一致，仅品牌主题色不同。
- 不新增数据库表；仅对现有错误事件做幂等清理。

## Verification

1. 运行相关单元测试，重点覆盖状态聚合、三条引擎门禁和历史过滤。
2. 运行 TypeScript 类型检查、ESLint 和生产构建。
3. 按项目发布门禁执行全量测试，并更新 `.data/test-results/summary.md`。
4. 本地启动 `4101` Web 与 `4102` Worker，分别用 Futu、Longbridge admin 和 Longbridge 租户账户验证。
5. 在港股休市、美股休市、可交易时段及夜盘开关两种配置下验证：
   - 不发送不应发送的模型请求。
   - 不新增休市信号、待确认订单或逐标的休市记录。
   - Banner 与详情弹窗状态一致。
6. 执行历史清理前后统计匹配记录数，确认只移除目标伪信号；清理后复查信号分页总数。
7. 使用 Playwright 检查桌面与移动端截图，确认两个平台顶部位置一致、24px/16px 圆角符合规范、文案全中文且无重叠。
8. 本次实现完成后先提供变更和测试结果供人工检查；未获得后续明确指令前不提交 Git、不部署。
