# 平台一级入口原型图计划

## Summary

根据现有文档 `platform_workbench_entry_page_plan.md`，先制作一个可打开的静态 HTML 原型图，用于评审一级平台入口页，而不是直接修改 React 路由或业务页面。

原型目标：

- 展示一级页面 `/` 的预期视觉效果。
- 左右两张平台卡片：
  - `Futu 量化交易工作台`
  - `Longbridge 量化交易工作台`
- 明确现有“金融助手工作台”归属于 Futu 工作台入口之后。
- 明确 Longbridge 当前是后续建设方向，不接入真实交易能力。
- 支持大屏双列、小屏单列，无横向滚动。

本阶段只交付原型图文件，不修改 `src/` 业务代码。

## Current State Analysis

- 已有设计计划：
  - `.trae/documents/platform_workbench_entry_page_plan.md`
  - 该文档已明确目标信息架构：
    - `/` 作为平台选择页。
    - `/futu` 承载现有 `Dashboard`。
    - `/longbridge` 作为 Longbridge 占位入口。
- 当前实际代码状态：
  - `src/App.tsx` 中 `/` 仍直接渲染 `Dashboard`。
  - `src/components/common/AppNav.tsx` 的品牌和工作台导航仍指向 `/`。
  - 当前还没有 `PlatformSelectView` 或 `LongbridgeWorkbenchPlaceholder`。
- 用户最新反馈：
  - 先根据文档做出原型图。
  - 因此本轮不直接实施路由迁移和页面代码改造。

## Proposed Changes

### 1. 新增静态 HTML 原型图

文件：`.trae/documents/platform_workbench_entry_page_prototype.html`

内容：

- 单文件 HTML，内联 CSS，无构建依赖。
- 页面结构：
  - 顶部品牌区：
    - `量化交易工作台`
    - 副标题：`选择交易平台，进入对应账户、行情、策略和风控工作区。`
  - 主视觉区：
    - 左卡：`Futu 量化交易工作台`
    - 右卡：`Longbridge 量化交易工作台`
  - 底部说明区：
    - `当前金融助手工作台将作为 Futu 工作台的 Web 应用入口。`
    - `Longbridge 能力后续独立接入，不混入 Futu 工作台。`

Futu 卡片设计：

- 状态标签：`已接入`
- 主文案：
  - `现有金融助手工作台`
  - `Futu OpenD 行情、账户资产、持仓、研究报告、实盘确认队列和模拟盘集中管理。`
- 能力点：
  - `账户资产`
  - `持仓与盈亏`
  - `Futu OpenD 行情`
  - `实盘人工确认`
  - `模拟盘`
  - `研究报告`
- 主按钮：`进入 Futu 工作台`
- 辅助说明：`对应后续实现路径：/futu`
- 视觉：沿用现有 Futu 橙色、琥珀色、暖色渐变。

Longbridge 卡片设计：

- 状态标签：`规划中`
- 主文案：
  - `长桥证券量化能力入口`
  - `为 Longbridge 行情、账户、持仓、订单、策略执行和风控队列预留独立工作区。`
- 能力点：
  - `行情接入`
  - `账户资产`
  - `持仓同步`
  - `订单与成交`
  - `策略执行`
  - `风控队列`
- 主按钮：`查看 Longbridge 规划`
- 辅助说明：`对应后续实现路径：/longbridge`
- 视觉：使用蓝紫、青色冷色系，与 Futu 明确区分。

交互表达：

- 按钮和卡片 hover 状态使用 CSS 表达。
- 原型按钮不执行真实跳转，避免误解为已接入业务逻辑。
- 可在按钮旁用小字标注目标路径。

响应式：

- `min-width >= 900px`：双列卡片。
- `< 900px`：单列堆叠。
- 页面最大宽度约 `1200px`。
- 不出现横向滚动。

### 2. 不修改业务代码

本次不修改：

- `src/App.tsx`
- `src/components/common/AppNav.tsx`
- `src/pages/Dashboard.tsx`
- 任何 API、交易、风控、数据库代码。

原因：

- 用户明确要求先看原型图。
- 原型确认前直接改路由风险较高，会影响当前 `/` 工作台入口。

### 3. 原型确认后的后续实施路径

若原型确认，再按 `platform_workbench_entry_page_plan.md` 执行代码实现：

- 新增 `src/pages/PlatformSelectView.tsx`
- 新增 `src/pages/LongbridgeWorkbenchPlaceholder.tsx`
- 修改 `src/App.tsx`
- 修改 `src/components/common/AppNav.tsx`
- 修改 `src/components/workspace/CommandCenterHeader.tsx`
- 搜索并调整“返回工作台”类链接到 `/futu`

## Assumptions & Decisions

- 决策：原型交付为静态 HTML 文件，方便直接在浏览器打开评审。
- 决策：原型文件放在 `.trae/documents/`，不进入生产源码。
- 决策：本轮只做一级入口页原型，不做 `/futu` 内页和 `/longbridge` 占位页完整原型。
- 决策：Futu 使用暖色系，Longbridge 使用冷色系，降低平台混淆。
- 决策：原型按钮只展示目标路径，不进行真实跳转。
- 假设：用户需要的是信息架构与视觉布局原型，而不是可运行 React 页面。

## Verification Steps

1. 确认原型文件存在：
   - `.trae/documents/platform_workbench_entry_page_prototype.html`
2. 直接用浏览器打开该 HTML 文件，确认：
   - 一级标题、说明文案完整。
   - 两张卡片左右排列。
   - Futu 卡片明确对应现有金融助手工作台。
   - Longbridge 卡片明确是规划中能力。
   - 按钮目标路径标注清楚。
3. 缩小浏览器宽度，确认：
   - 双列自动变单列。
   - 页面无横向滚动。
4. 确认没有修改 `src/`、`api/`、`trade_strategy/` 等业务文件。

