# 平台一级入口页设计计划

## Summary

新增一个一级平台选择页，作为应用根路径 `/`。页面采用左右排列的两张平台卡片：

- 第一张：`Futu 量化交易工作台`
- 第二张：`Longbridge 量化交易工作台`

现有“金融助手工作台”本质上是 Futu 平台的 Web 应用，因此整体迁移到 `/futu`。Longbridge 入口先落到 `/longbridge` 占位页，展示“建设中”、规划能力和后续接入方向，不在本次实现真实长桥交易能力。

目标是为后续扩展长桥证券平台的行情、账户、持仓、交易和策略执行能力预留清晰的信息架构，而不是把 Longbridge 功能混入现有 Futu 工作台。

## Current State Analysis

- `src/App.tsx`
  - 当前 `/` 直接渲染 `Dashboard`。
  - 现有 Futu 相关页面路径包括：
    - `/live-trading`
    - `/simulation`
    - `/stocks/:ticker`
    - `/reports`
    - `/opportunities`
  - 没有平台选择层，也没有 Longbridge 路由。

- `src/pages/Dashboard.tsx`
  - 当前“金融助手工作台”页面。
  - 内部读取 `useAccountDashboard()`、`useReportGeneration()`，并展示账户资产、持仓、研究机会、报告中心、实盘入口、模拟盘等。
  - 数据源和文案实际都是 Futu 体系。

- `src/components/common/AppNav.tsx`
  - 品牌区当前点击跳转 `/`。
  - 导航项中 `工作台` 指向 `/`，锚点项也基于 `/#account`、`/#positions`。
  - `isActive()` 也按 `/` 判断工作台激活。
  - 迁移后需要让 Futu 工作台内部导航基于 `/futu`，否则会把用户带回一级平台选择页。

- `src/components/workspace/CommandCenterHeader.tsx`
  - 当前标题为“金融助手工作台”，说明文案是账户、持仓、风险、Top 30 CSP 研究和实盘入口集中在一个工作台。
  - 为符合新信息架构，应在 Futu 工作台中明确标识为 `Futu 量化交易工作台`。

- `src/components/workspace/LiveTradingPanel.tsx` 和 `src/components/workspace/SimulationTradingPanel.tsx`
  - 当前分别作为 Futu 实盘和 Futu 模拟盘入口，仍保留在 Futu 工作台下。

- 项目已有 UI 风格：
  - Futu 相关页面使用橙粉渐变和深浅搭配。
  - 用户偏好高密度金融工作台布局，不希望窄屏横向滚动。
  - 已有 `lucide-react` 图标库，可用于平台卡片图标。

## Proposed Changes

### 1. 新增一级平台选择页

文件：`src/pages/PlatformSelectView.tsx`

新增页面职责：
- 作为根路径 `/` 的唯一内容。
- 使用左右排列卡片布局：
  - 大屏：两列并排。
  - 中小屏：自动堆叠为单列，避免横向滚动。
- 页面标题建议：
  - 主标题：`量化交易工作台`
  - 副标题：`选择交易平台，进入对应账户、行情、策略和风控工作区。`
- 卡片 1：`Futu 量化交易工作台`
  - 状态：`已接入`
  - 能力点：账户资产、持仓层级、Futu OpenD 行情、实盘人工确认队列、模拟盘、研究报告。
  - 主按钮：`进入 Futu 工作台`
  - 路由：`/futu`
  - 视觉：沿用当前 Futu 橙粉渐变主题。
- 卡片 2：`Longbridge 量化交易工作台`
  - 状态：`规划中`
  - 能力点：Longbridge 行情、账户资产、持仓、订单、策略执行、风控队列。
  - 主按钮：`查看 Longbridge 规划`
  - 路由：`/longbridge`
  - 视觉：使用区别于 Futu 的蓝紫/青色高光，避免平台混淆。
- 页面顶部保留简洁品牌，不使用现有 Futu 工作台导航，避免一级页出现 Futu 内部锚点。

### 2. 新增长桥占位页

文件：`src/pages/LongbridgeWorkbenchPlaceholder.tsx`

新增页面职责：
- 路径 `/longbridge`。
- 明确展示：
  - `Longbridge 量化交易工作台`
  - `建设中`
  - 当前不会连接真实账户、不会提交订单。
- 展示未来能力模块卡片：
  - `行情接入`
  - `账户与持仓`
  - `订单与成交`
  - `策略与风控`
  - `人工确认队列`
- 提供返回入口：
  - `返回平台选择`
  - `进入 Futu 工作台`
- 不新增 API、不接入真实 Longbridge SDK、不创建后端服务。

### 3. 调整路由结构

文件：`src/App.tsx`

改动：
- 新增导入：
  - `PlatformSelectView`
  - `LongbridgeWorkbenchPlaceholder`
- 路由调整：
  - `/` -> `PlatformSelectView`
  - `/futu` -> `Dashboard`
  - `/longbridge` -> `LongbridgeWorkbenchPlaceholder`
- 保持现有 Futu 子页面路径不变：
  - `/live-trading`
  - `/simulation`
  - `/stocks/:ticker`
  - `/reports`
  - `/opportunities`
- 原因：
  - 本次目标是添加平台一级入口，不重构所有 Futu 子页面路径，避免一次性迁移过大。
  - `Dashboard` 迁到 `/futu` 后，Futu 工作台主入口语义清晰。

### 4. 调整 Futu 工作台导航

文件：`src/components/common/AppNav.tsx`

改动：
- `dashboardItems` 中：
  - `工作台` 从 `/` 改为 `/futu`
  - `账户资产` 从 `/#account` 改为 `/futu#account`
  - `持仓` 从 `/#positions` 改为 `/futu#positions`
  - `风险` 从 `/#risk` 改为 `/futu#risk`
  - `研究机会` 从 `/#research` 改为 `/futu#research`
  - 其他独立页面路径保持不变。
- 品牌区：
  - 点击目标改为 `/futu`。
  - 标题改为 `Futu 量化交易工作台`。
  - 副标题改为 `Futu · 账户 · 持仓 · 研究 · 风控`。
- `isActive()`：
  - 工作台激活条件从 `pathname === '/'` 调整为 `pathname === '/futu'`。
  - `href.includes('#')` 的逻辑可保留，确保 `/futu#account` 正确激活。
- 影响范围：
  - `AppNav` 在 Futu 工作台、实盘页、模拟盘页等页面复用。品牌点击将回到 Futu 工作台，而不是平台选择页。
  - 平台选择页不使用 `AppNav`，因此仍保持一级入口纯净。

### 5. 调整 Futu 工作台标题文案

文件：`src/components/workspace/CommandCenterHeader.tsx`

改动：
- 将页面标题中的“金融助手工作台”改为 `Futu 量化交易工作台`。
- 将说明文案中的“账户、持仓、风险、Top 30 CSP 研究和实盘入口集中在一个工作台”调整为更明确的 Futu 语义：
  - `Futu 账户、持仓、风险、Top 30 CSP 研究、实盘入口和模拟盘集中在一个工作台；研究结果不会自动触发交易。`
- 保留现有按钮和数据刷新逻辑。

### 6. 兼容入口与跳转

文件：`src/components/realtime/RealtimeStockHeader.tsx`

改动：
- 当前“返回工作台”链接如指向 `/`，改为 `/futu`。
- 目的：从股票详情页返回 Futu 工作台，而不是返回平台选择页。

通过搜索确认其他显式 `to="/"` 或 `href="/"`：
- 若语义是“返回 Futu 工作台”，改为 `/futu`。
- 若语义是“返回平台选择”，保留或改为 `/`。

### 7. 不做的内容

本次不实现以下内容：
- Longbridge 后端 API。
- Longbridge SDK / OpenAPI 鉴权。
- Longbridge 账户、持仓、订单真实查询。
- Longbridge 实盘或模拟盘交易。
- 将现有 Futu 子页面全部迁到 `/futu/live-trading`、`/futu/simulation` 等嵌套路由。
- 修改现有 Futu 交易逻辑、风控逻辑、数据库结构。

## Assumptions & Decisions

- 已确认：根路径 `/` 作为一级平台选择页。
- 已确认：现有 Futu 金融助手工作台迁移到 `/futu`。
- 已确认：Longbridge 卡片点击进入 `/longbridge` 占位页，而不是禁用。
- 决策：现有 Futu 子页面路径暂不迁移，减少破坏性变更。
- 决策：平台选择页不复用 `AppNav`，避免出现 Futu 内部导航。
- 决策：Longbridge 使用独立视觉色系，避免与 Futu 橙粉主题混淆。
- 决策：本次只做前端信息架构和入口设计，不做长桥真实能力接入。

## Verification Steps

1. 类型检查：
   - `PATH="$PWD/.tools/node/bin:$PATH" npm run check`
2. 路由验证：
   - 启动服务：`PATH="$PWD/.tools/node/bin:$PATH" npm run dev`
   - 打开 `http://localhost:5173/`，确认显示两个平台卡片。
   - 点击 `Futu 量化交易工作台`，确认进入 `http://localhost:5173/futu`，且现有工作台正常加载。
   - 点击 `Longbridge 量化交易工作台`，确认进入 `http://localhost:5173/longbridge`，显示建设中占位页。
3. 导航验证：
   - 在 `/futu` 点击导航中的账户、持仓、风险、研究机会，确认锚点仍可跳转。
   - 在 Futu 子页面点击品牌区，确认回到 `/futu`。
   - 在股票详情页点击“返回工作台”，确认回到 `/futu`。
4. 回归验证：
   - `/live-trading`、`/simulation`、`/reports`、`/opportunities` 仍可访问。
   - 现有资产隐藏按钮、持仓盈亏隐藏、实盘候选池和待确认订单页面不受影响。
   - 窄屏下平台卡片单列展示，无横向滚动。
