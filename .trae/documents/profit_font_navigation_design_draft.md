# 盈亏颜色、正式字体与导航定位设计稿

## Summary

本设计稿用于确认三项 UI 细节调整，确认后再进入执行：

1. 股票与期权持仓盈亏颜色采用中国市场习惯：负数为绿色，正数为红色，零值/不可用为中性灰色。
2. 全站字体调整为更正式、更适合金融工作台的系统字体组合，降低当前 `Georgia` 衬线字体和局部等宽字体带来的“设计感过强/不够正式”的问题。
3. 修复导航栏点击后不能直接定位到对应区域的问题，支持首页和报告页锚点稳定滚动，并预留 sticky 导航遮挡补偿。

本稿只描述设计和执行方案，不直接修改业务代码。

## Current State Analysis

### 1. 盈亏颜色

相关文件：

- `src/components/workspace/PositionsPanel.tsx`
- `src/components/workspace/AccountSummaryPanel.tsx`
- `src/components/common/MetricCard.tsx`

当前状态：

- `PositionsPanel` 中持仓子行的 `unrealizedPnL` 和 `positionRatio` 使用普通文本：
  - `displayValue(position.unrealizedPnL, language)`
  - `displayValue(position.positionRatio, language)`
- `AccountSummaryPanel` 中当日盈亏、总盈亏使用 `MetricCard`，但只是 `amber` accent，没有根据正负动态变色。
- 当前没有统一的 P/L 数值解析工具。

设计原则：

- 采用用户指定规则：负数 = 绿色，正数 = 红色。
- 颜色语义只用于盈亏，不影响资产类型颜色：
  - 正股/期权类型 badge 继续使用现有 cyan/emerald/amber。
  - 盈亏字段单独染色。
- `unavailable` / `不可用` / 空值 / `0` 显示为中性灰，不误导。

### 2. 字体

相关文件：

- `src/index.css`
- `src/components/common/MetricCard.tsx`
- `src/components/common/AppNav.tsx`
- `src/components/UniverseTable.tsx`
- `src/components/workspace/PositionsPanel.tsx`

当前状态：

- `src/index.css` 全局字体为：
  - `ui-serif, Georgia, "Times New Roman", serif`
- `MetricCard` 数值强制使用 `font-mono`。
- `UniverseTable` 和 `PositionsPanel` 中 ticker / contract 字段也使用 `font-mono`。
- 当前整体观感更像报告排版，不像正式的现代金融工作台。

设计原则：

- 全站主体字体改为系统无衬线字体，风格更正式、清晰、偏机构工作台：
  - `Inter`
  - `ui-sans-serif`
  - `-apple-system`
  - `BlinkMacSystemFont`
  - `"SF Pro Text"`
  - `"Segoe UI"`
  - `"PingFang SC"`
  - `"Hiragino Sans GB"`
  - `"Microsoft YaHei"`
  - `sans-serif`
- 数字和代码不再全局使用强等宽字体，避免“开发工具感”过强。
- 只在确实需要对齐的短字段保留数字等宽特性：
  - 使用 `font-variant-numeric: tabular-nums`。
  - 对金额、百分比、排名使用 tabular number，而不是整段 `font-mono`。
- 股票代码可保留略强字重，但不必强制等宽。

### 3. 导航定位

相关文件：

- `src/components/common/AppNav.tsx`
- `src/pages/Dashboard.tsx`
- `src/pages/ReportView.tsx`
- `src/App.tsx`
- `src/index.css`

当前状态：

- 导航栏使用 `Link to="/#account"`、`Link to="/#positions"` 等路径。
- React Router 下点击同页 hash 链接不一定触发浏览器默认锚点滚动。
- `href.startsWith('#')` 的逻辑只覆盖报告页内部链接，不覆盖首页 `/#account` 这类链接。
- 页面有 sticky 顶部导航，即使滚动成功也可能被顶部导航遮挡。

设计原则：

- 导航点击必须明确触发滚动，不依赖浏览器默认 hash 行为。
- 支持两类导航：
  - 首页内锚点：账户资产、持仓、风险、研究机会、报告中心、实盘入口。
  - 报告页内锚点：纯数据表、Top 5、Bottom 5、其余股票、数据质量、源文件。
- 跨页面点击时：
  - 从报告页点击首页锚点，应先跳转到 `/`，再滚动到目标区域。
  - 从首页点击可读报告，应进入 `/report`。
- sticky nav 遮挡通过 CSS 或滚动偏移处理。

## Design Draft

### 1. 盈亏颜色规范

#### 颜色 Token

- 正收益 / 盈利：`text-red-700`，背景 `bg-red-50`，边框 `border-red-200`
- 负收益 / 亏损：`text-emerald-700`，背景 `bg-emerald-50`，边框 `border-emerald-200`
- 零值 / 不可用：`text-slate-600`，背景 `bg-slate-50`，边框 `border-slate-200`

#### 持仓层级中的呈现

位置：

- `PositionsPanel` 子表格的 `盈亏` 列。
- `PositionsPanel` 子表格的 `占比` 列，如果值表达盈亏比例，也应用同一规则。

展示形态：

- 用轻量 pill 展示，而不是普通文本：

```text
负数示例：-184.00        绿色 pill
正数示例：+312.80        红色 pill
零值示例：0.00           灰色文本/pill
不可用示例：不可用       灰色文本/pill
```

#### 账户总览中的呈现

位置：

- `AccountSummaryPanel` 的 `当日盈亏`
- `AccountSummaryPanel` 的 `总盈亏`

展示形态：

- `MetricCard` 继续保留卡片结构。
- 盈亏类卡片根据正负动态切换 accent：
  - 负数：emerald
  - 正数：red
  - 零值/不可用：slate
- 数值自身也使用对应颜色，保证卡片内一眼可识别。

### 2. 字体规范

#### 全局字体

`src/index.css` 中 `:root` 字体建议改为：

```css
font-family:
  Inter,
  ui-sans-serif,
  -apple-system,
  BlinkMacSystemFont,
  "SF Pro Text",
  "Segoe UI",
  "PingFang SC",
  "Hiragino Sans GB",
  "Microsoft YaHei",
  sans-serif;
```

#### 数字显示

新增全局数字规则：

```css
.tabular-nums {
  font-variant-numeric: tabular-nums;
}
```

实际使用：

- 金额、百分比、排名、持仓数量：使用 `tabular-nums`。
- ticker / contract：使用 `font-semibold tracking-tight`，不再默认 `font-mono`。
- Markdown 源文件 `<pre>` 保留等宽字体，因为它是源码视图。

#### 页面气质

设计目标：

- 更接近券商/投研终端的正式界面。
- 中文阅读清晰，不像英文报告排版。
- 数字稳定对齐，但不呈现过强代码编辑器风格。

### 3. 导航交互设计

#### 导航行为

点击导航后应满足：

- 当前在首页，点击 `持仓`：滚动到 `#positions`。
- 当前在首页，点击 `账户资产`：滚动到 `#account`。
- 当前在报告页，点击 `纯数据表`：滚动到 `#raw`。
- 当前在报告页，点击 `源文件`：滚动到 `#markdown-source`。
- 当前在报告页，点击 `持仓`：跳转首页并滚动到 `#positions`。

#### 技术方案

新增一个轻量 hash 滚动组件：

- 文件：`src/components/common/HashScrollHandler.tsx`
- 挂载位置：`src/App.tsx` 的 `Router` 内、`Routes` 外。
- 监听：
  - `location.pathname`
  - `location.hash`
- 当 `location.hash` 存在时：
  - 延迟一个 animation frame，等待页面 DOM 渲染。
  - 查找 `document.getElementById(hashWithoutSharp)`。
  - 使用 `scrollIntoView({ behavior: 'smooth', block: 'start' })`。

同时在 CSS 中增加：

```css
[id] {
  scroll-margin-top: 96px;
}
```

这样可以避免 sticky 顶部导航遮挡 section 标题。

#### AppNav 链接处理

`AppNav` 保留当前信息架构，但链接行为调整：

- 首页锚点继续使用 `/ #id` 的路由表达，但由 `HashScrollHandler` 接管滚动。
- 报告页内部锚点继续使用 `#id`，也由 `HashScrollHandler` 接管滚动。
- `NavLink` active 判断后续可以基于 hash 增强，但第一版重点是点击能定位。

## Proposed Changes

### `src/utils/displayText.ts`

新增工具函数：

- `parseSignedNumber(value: unknown): number | undefined`
  - 支持 `$-184.00`
  - 支持 `-$184.00`
  - 支持 `+12.3%`
  - 支持 `12.3%`
  - 对 `unavailable` / `不可用` 返回 `undefined`
- `profitTone(value: unknown): 'profit' | 'loss' | 'neutral'`
  - 大于 0：`profit`
  - 小于 0：`loss`
  - 等于 0 或不可解析：`neutral`

注意命名：

- 这里的 `profit` 代表正数，对应红色。
- `loss` 代表负数，对应绿色。
- 颜色规则遵循用户指定，不使用美股常见绿色上涨规则。

### `src/components/common/ProfitValue.tsx`（新增）

新增通用组件：

- 输入：
  - `value`
  - `language`
  - `variant?: 'text' | 'pill'`
- 输出：
  - 根据正负展示红/绿/灰。
  - 中文模式继续把 `unavailable` 显示为 `不可用`。

用途：

- 持仓子表格 `盈亏`。
- 持仓子表格 `占比`。
- 账户总览盈亏卡片中的 value。

### `src/components/workspace/PositionsPanel.tsx`

调整：

- `unrealizedPnL` 使用 `ProfitValue variant="pill"`。
- `positionRatio` 使用 `ProfitValue variant="text"` 或 `pill`，建议第一版也用 `pill`，保证盈亏百分比明确。
- 股票代码/合约名去掉 `font-mono`，改为 `font-semibold tracking-tight tabular-nums`。
- 父级 market value 保持中性，不按盈亏色处理，避免把市值误读为收益。

### `src/components/workspace/AccountSummaryPanel.tsx`

调整：

- `当日盈亏` 和 `总盈亏` 使用动态 accent：
  - 正数：red
  - 负数：emerald
  - 中性：slate
- value 使用 `ProfitValue variant="text"`。
- 总资产、现金、购买力等不使用盈亏颜色。

### `src/components/common/MetricCard.tsx`

调整：

- 增加可选 `valueClassName?: string`，用于外部传入盈亏颜色。
- 将数值默认字体从 `font-mono` 改为 `tabular-nums`。
- 保持现有 `accent` API，避免破坏其他调用。

### `src/index.css`

调整：

- 全局字体切换为正式系统无衬线栈。
- body 背景从旧深色 `#020617` 改为浅色底色，例如 `#f8fafc`。
- 增加：
  - `[id] { scroll-margin-top: 96px; }`
  - `html { scroll-behavior: smooth; }`
  - 数字对齐规则。

### `src/components/common/HashScrollHandler.tsx`（新增）

新增路由 hash 滚动处理：

- 使用 `useLocation`。
- `useEffect` 监听 `pathname/hash`。
- 找到目标 id 后平滑滚动。
- 如果元素尚未渲染，短延迟重试一次，适配报告生成后进入页面的场景。

### `src/App.tsx`

调整：

- 在 `<Router>` 内加入 `<HashScrollHandler />`。
- 不改变现有路由：
  - `/`
  - `/report`

### `src/components/common/AppNav.tsx`

调整：

- 保留当前导航项。
- 对同页 `#id` 和跨页 `/#id` 链接统一交给 router + `HashScrollHandler`。
- 可选增强：
  - `isActive` 支持当前 hash 高亮。
  - 点击品牌回首页顶部。

### `src/components/UniverseTable.tsx`

轻微字体调整：

- sticky 列中的 ticker 去掉 `font-mono` 或改为更克制的 `tabular-nums font-semibold`。
- 表格数字列使用 `tabular-nums`。

## Assumptions & Decisions

- 盈亏颜色严格按用户要求：负数绿色，正数红色。
- 该颜色规则只用于盈亏/收益率，不用于市值、价格、成本等普通数值。
- “正式字体”优先采用系统无衬线字体栈，不引入外部 WebFont，避免网络依赖和字体加载闪烁。
- Markdown 源码区域保留等宽字体，这是源码阅读场景，不纳入主工作台字体调整。
- 导航修复采用前端 hash scroll handler，不引入新路由库，也不改变现有 URL 结构。
- 本轮先完成设计确认；确认后才执行代码改动。

## Verification Steps

### 自动化验证

执行阶段运行：

```bash
PATH=/Users/ShockCao/AICoding/Financial/.tools/node/bin:$PATH npm run check
PATH=/Users/ShockCao/AICoding/Financial/.tools/node/bin:$PATH npm test
PATH=/Users/ShockCao/AICoding/Financial/.tools/node/bin:$PATH npm run build
```

验收：

- TypeScript 无错误。
- 现有测试通过。
- 生产构建成功。

### 浏览器验收

首页：

- 点击导航 `账户资产`，页面定位到账户模块。
- 点击导航 `持仓`，页面定位到持仓模块。
- 点击导航 `风险`，页面定位到风险模块。
- sticky 导航不遮挡模块标题。
- 持仓子列表中：
  - 负数盈亏显示绿色。
  - 正数盈亏显示红色。
  - 不可用/零值显示灰色。
- 账户总览中：
  - 当日盈亏、总盈亏按正负使用红/绿。
- 全站字体更正式统一，主体不再呈现 `Georgia` 英文报告风格。

报告页：

- 点击 `纯数据表`、`Top 5 机会`、`Bottom 5 风险`、`源文件` 可直接定位。
- 页面字体与首页一致。
- Markdown 源文件仍保持等宽代码字体。

### 回归验收

- 语言切换仍可用。
- 站点标题仍是 `金融助手工作台`。
- 报告生成、账户刷新、持仓层级展示不受影响。
- 实盘交易入口仍只允许预览，不开放真实提交。

## Execution Order After Approval

1. 新增显示工具函数和 `ProfitValue` 组件。
2. 调整 `MetricCard` 数字字体和可扩展样式。
3. 更新 `PositionsPanel` 的盈亏/占比颜色展示。
4. 更新 `AccountSummaryPanel` 的当日盈亏/总盈亏颜色展示。
5. 更新 `src/index.css` 全局字体、浅色 body、scroll margin。
6. 新增 `HashScrollHandler` 并挂载到 `App.tsx`。
7. 轻微调整 `AppNav` active/hash 行为。
8. 调整表格和持仓中的 `font-mono` 使用，保留必要的数字对齐。
9. 运行类型检查、测试、构建。
10. 启动本地页面做首页和报告页导航/视觉验收。
