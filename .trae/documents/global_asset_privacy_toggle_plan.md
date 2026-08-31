# 全局资产隐藏按钮计划

## Summary

为工作台、实盘入口、模拟盘增加统一的资产隐私隐藏能力。用户在“总资产”卡片点击业界通用的眼睛按钮后，全局切换资产汇总敏感数值的显示/隐藏；状态写入浏览器 `localStorage`，刷新页面和跨页面跳转后保持一致。

本次范围按用户确认限定为“仅资产汇总”：隐藏总资产、现金、购买力、可用资金、当日盈亏、总盈亏等汇总指标；不隐藏持仓明细表中的标的、数量、市值、成本、现价、盈亏等列。

## Current State Analysis

- `src/stores/uiStore.ts` 目前只维护 `language`，没有资产隐私状态，也没有持久化。
- `src/components/common/MetricCard.tsx` 是工作台和模拟盘复用的指标卡组件，当前只接收 `label/value/helper/accent/valueClassName`，没有 action slot 或隐藏渲染能力。
- `src/components/workspace/AccountSummaryPanel.tsx` 渲染工作台“账户资产总览”，包括：
  - `总资产`
  - `现金`
  - `购买力`
  - `可用资金`
  - `当日盈亏`
  - `总盈亏`
- `src/components/workspace/PositionsPanel.tsx` 渲染持仓层级和持仓表。用户已确认本次不隐藏持仓明细，因此该文件不需要改动。
- `src/components/workspace/LiveTradingPanel.tsx` 是首页右侧“实盘交易入口”卡片，目前不展示真实资产金额，只展示入口能力说明，所以不需要隐藏金额；但全局状态需要覆盖进入后的实盘页。
- `src/pages/LiveTradingView.tsx` 实盘页顶部 `Metric` 渲染：
  - `真实账户`
  - `总资产`
  - `购买力`
  - `历史策略信号`
  - `待确认订单`
  其中仅 `总资产`、`购买力` 属于资产敏感数值；`真实账户`按本次“资产汇总”不隐藏。
- `src/pages/SimulationTradingView.tsx` 模拟盘顶部 `MetricCard` 渲染：
  - `模拟账户`
  - `总资产`
  - `现金`
  - `购买力`
  - `当日盈亏`
  - `总盈亏`
  - `策略`
  - `评估间隔`
  其中 `总资产/现金/购买力/当日盈亏/总盈亏` 需要隐藏。
- 项目已依赖 `lucide-react`，并已有 `Eye` 图标使用记录，可以直接使用 `Eye` / `EyeOff`。
- 项目验证命令为 `PATH="$PWD/.tools/node/bin:$PATH" npm run check`，`package.json` 中 `check` 为 `tsc --noEmit`。

## Proposed Changes

### 1. 扩展全局 UI Store

文件：`src/stores/uiStore.ts`

改动：
- 在 `UiState` 中新增：
  - `assetPrivacyHidden: boolean`
  - `setAssetPrivacyHidden(hidden: boolean): void`
  - `toggleAssetPrivacyHidden(): void`
- 初始化时从 `localStorage.getItem('assetPrivacyHidden')` 读取，值为 `'true'` 时隐藏。
- 切换时同步写入 `localStorage.setItem('assetPrivacyHidden', String(hidden))`。
- 为兼容 SSR/测试环境，访问 `localStorage` 前判断 `typeof window !== 'undefined'`。

为什么：
- 用户要求“总资产上点隐藏就全局隐藏”，跨工作台、实盘、模拟盘共享状态最适合放在已有 `useUiStore`。
- 用户已确认隐藏状态需要本地记忆。

### 2. 新增资产隐藏按钮与掩码展示工具

文件：`src/components/common/AssetPrivacyToggle.tsx`

新增组件：
- 使用 `Eye` / `EyeOff`。
- 读取 `useUiStore((state) => state.assetPrivacyHidden)`。
- 点击调用 `toggleAssetPrivacyHidden()`。
- 中文 aria/title：
  - 隐藏中：`显示资产`
  - 显示中：`隐藏资产`
- 样式采用圆形/胶囊按钮，和现有橙粉主题一致，按钮本身必须高对比可见。

文件：`src/utils/displayText.ts`

新增工具函数：
- `maskAssetValue(value?: unknown): string`
  - 返回固定占位：`••••••`
  - 不根据原始金额长度生成占位，避免泄露数量级。

为什么：
- 眼睛按钮作为独立组件，避免在多个页面重复写交互和图标逻辑。
- 掩码函数统一占位文案，避免各页面样式和语义不一致。

### 3. 扩展 MetricCard 支持顶部操作区

文件：`src/components/common/MetricCard.tsx`

改动：
- 新增可选 props：
  - `action?: ReactNode`
- 在卡片顶部将 label 和 action 放入 `flex items-start justify-between gap-3`。
- 不改变现有调用默认表现。

为什么：
- 工作台和模拟盘都使用 `MetricCard`，在“总资产”卡右上角放眼睛按钮，符合用户“总资产上点隐藏”的操作入口。

### 4. 工作台资产汇总隐藏

文件：`src/components/workspace/AccountSummaryPanel.tsx`

改动：
- 引入 `AssetPrivacyToggle` 和 `maskAssetValue`。
- 从 `useUiStore` 读取 `assetPrivacyHidden`。
- 定义本地函数 `assetValue(value)`：
  - 隐藏时返回 `maskAssetValue(value)`
  - 显示时返回 `displayValue(value, language)`
- 对以下 `MetricCard` 应用隐藏：
  - `总资产`
  - `现金`
  - `购买力`
  - `可用资金`
  - `当日盈亏`
  - `总盈亏`
- `总资产`卡传入 `action={<AssetPrivacyToggle />}`。
- `当日盈亏/总盈亏` 隐藏时不再渲染 `ProfitValue`，直接渲染掩码，避免红绿颜色暗示正负。
- `helper` 中的币种说明保留，因为不是资产金额。

不改动：
- `PositionsPanel` 不隐藏，因为用户选择了“仅资产汇总”。

### 5. 实盘页资产汇总隐藏

文件：`src/pages/LiveTradingView.tsx`

改动：
- 引入 `AssetPrivacyToggle` 和 `maskAssetValue`。
- 读取 `assetPrivacyHidden`。
- 扩展本文件内部 `Metric` 组件支持：
  - `action?: ReactNode`
- 顶部指标区：
  - `总资产` 使用隐藏状态，且传入 `AssetPrivacyToggle`。
  - `购买力` 使用隐藏状态。
  - `真实账户`、`历史策略信号`、`待确认订单`不隐藏。

为什么：
- 用户提到“实盘入口”，实际首页入口不展示资产金额；实盘页顶部才展示真实账户总资产和购买力，应作为实盘资产隐藏范围。

### 6. 模拟盘资产汇总隐藏

文件：`src/pages/SimulationTradingView.tsx`

改动：
- 引入 `AssetPrivacyToggle` 和 `maskAssetValue`。
- 读取 `assetPrivacyHidden`。
- 对以下 `MetricCard` 应用隐藏：
  - `总资产`
  - `现金`
  - `购买力`
  - `当日盈亏`
  - `总盈亏`
- `总资产`卡传入 `action={<AssetPrivacyToggle />}`。
- `当日盈亏/总盈亏` 隐藏时不渲染 `ProfitValue`，直接显示 `••••••`。
- `模拟账户`、`策略`、`评估间隔`不隐藏。

### 7. 视觉与交互细节

- 眼睛按钮只出现在各页面“总资产”卡片上，点击后全局状态联动。
- 隐藏状态下所有资产汇总卡使用同一个占位 `••••••`。
- 掩码文本使用 `tabular-nums` 和现有大号字体，不造成布局跳动。
- 不隐藏币种说明、策略名、账户类型、状态统计等非金额信息。
- 不触碰后端接口和数据库，只做前端显示层处理；真实数据仍保留在内存和网络响应中。

## Assumptions & Decisions

- 已确认：隐藏范围为“仅资产汇总”，不隐藏持仓明细。
- 已确认：隐藏状态需要本地记忆，使用浏览器 `localStorage`。
- 决策：隐藏按钮入口放在“总资产”卡片右上角；工作台、实盘页、模拟盘都各自提供入口，但共用同一全局状态。
- 决策：掩码统一为固定 `••••••`，不按金额长度变化，避免泄露数量级。
- 决策：盈亏隐藏时不保留红绿颜色，避免通过颜色泄露正负。
- 决策：本次不改后端，不加 API 字段，不做服务端脱敏。

## Verification Steps

1. 类型检查：
   - `PATH="$PWD/.tools/node/bin:$PATH" npm run check`
2. 页面运行验证：
   - 启动或复用服务：`PATH="$PWD/.tools/node/bin:$PATH" npm run dev`
   - 打开 `http://localhost:5173/`
   - 点击工作台“总资产”卡右上角眼睛按钮，确认工作台资产汇总变为 `••••••`。
   - 刷新页面，确认仍保持隐藏。
   - 进入 `http://localhost:5173/live-trading`，确认实盘页 `总资产`、`购买力`隐藏，其他统计正常显示。
   - 进入 `http://localhost:5173/simulation`，确认模拟盘 `总资产`、`现金`、`购买力`、`当日盈亏`、`总盈亏`隐藏。
   - 在任一页面再次点击眼睛按钮，确认三个页面恢复显示。
3. 回归检查：
   - 确认持仓明细表仍正常显示。
   - 确认交易方向红绿颜色不受影响。
   - 确认窄屏下眼睛按钮不导致横向滚动。
