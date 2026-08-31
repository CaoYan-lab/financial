# 金融助手工作台 UI、导航、语言与持仓层级改造计划

## Summary

本次改造目标是把当前偏“暗色研究站点”的界面升级为更清晰、更易导航、更适合日常使用的金融助手工作台：

1. 站点名称改为 **金融助手工作台**。
2. 全站视觉从深黑背景改为更明亮的金融终端风格，提升文字层级和类目辨识度。
3. 增加全局导航栏，避免只能靠下滑寻找模块。
4. 可读报告中的 30 行数据表支持列隐藏，尤其支持一键隐藏 `unavailable` 较多的字段。
5. 默认全中文，不再中英文混杂；保留“转换为英文/English”切换能力。
6. 持仓列表改为父子层级：正股/股票名称作为父层级，相关期权和正股放入同一个子列表。

本计划只基于当前仓库实际代码制定，不引入数据库或额外状态管理库。

## Current State Analysis

### 1. 站点名称

相关文件：

- `index.html`

当前状态：

- `<title>` 仍是 `My Trae Project`。
- 浏览器页签没有体现“金融助手工作台”。

计划：

- 将 `<html lang="en">` 改为默认 `zh-CN`。
- 将 `<title>` 改为 `金融助手工作台`。

### 2. 视觉风格与色调

相关文件：

- `src/pages/Dashboard.tsx`
- `src/pages/ReportView.tsx`
- `src/components/workspace/*.tsx`
- `src/components/report/*.tsx`
- `src/components/UniverseTable.tsx`
- `src/components/common/MetricCard.tsx`
- `src/components/common/Badge.tsx`
- `src/components/DataSourcePanel.tsx`
- `src/components/StatusTimeline.tsx`

当前状态：

- 首页和报告页均使用深色渐变背景：
  - `bg-[radial-gradient(...),linear-gradient(...#020617...)]`
  - 大量 `bg-slate-950/75`、`text-slate-100`、`text-slate-400`。
- 类目标签大量使用英文小标题，例如 `Account`、`Risk`、`Report`、`Watchlist`、`Live Trading Gate`。
- 文字层级主要靠灰度区分，用户反馈“不同类目辨识度不足”是合理的。

计划：

- 页面背景改为浅色工作台风格：
  - 主背景：`bg-slate-100` / `bg-gradient-to-br from-slate-50 via-cyan-50 to-indigo-50`。
  - 卡片：`bg-white/90`、`border-slate-200`、轻阴影。
  - 主文字：`text-slate-950`。
  - 次级文字：`text-slate-600`。
- 不同类目使用稳定的颜色体系：
  - 账户/资产：emerald。
  - 持仓：sky / cyan。
  - 风险：amber / red。
  - 研究机会：indigo / violet。
  - 数据质量：slate / cyan。
  - 实盘入口：red。
- `Badge` 和 `MetricCard` 保持现有 API，但扩展/调整样式以适配浅色背景。

### 3. 导航栏缺失

相关文件：

- `src/pages/Dashboard.tsx`
- `src/pages/ReportView.tsx`
- 可新增 `src/components/AppShellNav.tsx` 或 `src/components/common/AppNav.tsx`

当前状态：

- 首页没有全局导航栏。
- 报告页只有局部锚点导航，而且在页面顶部，不是全局固定导航。
- 用户需要下滑查找账户、持仓、风险、机会、报告、实盘入口等模块。

计划：

- 新增全局固定导航组件 `src/components/common/AppNav.tsx`。
- 在首页和报告页顶部统一使用。
- 导航默认中文，包含：
  - 工作台：`/`
  - 账户资产：`#account`
  - 持仓：`#positions`
  - 风险：`#risk`
  - 研究机会：`#research`
  - 报告中心：`#report-center`
  - 实盘入口：`#trading`
  - 可读报告：`/report`
- 导航交互：
  - 桌面端为 sticky 顶部导航。
  - 小屏支持横向滚动 chip 导航，不做复杂汉堡菜单。
  - 锚点通过给现有 section 增加 `id` 实现。
- 报告页导航：
  - 顶部全局导航保留。
  - 报告内部导航改为中文 sticky 二级导航：
    - 纯数据表
    - Top 5 机会
    - Bottom 5 风险
    - 其余股票
    - 数据质量
    - 源文件

### 4. 可读报告列隐藏

相关文件：

- `src/components/UniverseTable.tsx`

当前状态：

- `UniverseTable` 固定展示 15 列。
- `unavailable` 只用 badge 标识，但无法隐藏。
- 表宽较大，用户需要横向滚动，且不可用字段影响阅读效率。

计划：

- 在 `UniverseTable` 内引入本地 state 管理列显隐。
- 建立列配置数组，替代当前 `headers` 和硬编码 `<Cell>`：
  - `rank`
  - `ticker`
  - `companyName`
  - `country`
  - `currentPrice`
  - `marketCap`
  - `peRatio`
  - `rsi14`
  - `ma50`
  - `ma200`
  - `ivRank`
  - `iv30`
  - `nextEarningsDate`
  - `capitalPerContract`
  - `sevenDayNews`
- 每列配置包含：
  - 字段 key。
  - 中文标题。
  - 英文标题。
  - 分组：身份 / 市场 / 技术 / 期权 / 事件。
  - 是否默认显示。
  - 是否关键列。
- 新增表格工具栏：
  - `隐藏 unavailable 列`：隐藏该列中 `unavailable` 占比高于阈值的非关键列。
  - `显示全部列`。
  - 每列 checkbox。
  - 显示当前 `已显示 X / 总 Y 列`。
- 关键列永远默认保留：
  - 排名、代码、公司、国家、价格、市值。
- `unavailable` 仍保留为 badge，但被隐藏列不再干扰主阅读。

### 5. 全中文默认与英文转换

相关文件：

- `src/components/report/ReportToolbar.tsx`
- `src/pages/ReportView.tsx`
- `src/pages/Dashboard.tsx`
- `src/components/workspace/*.tsx`
- `src/components/report/*.tsx`
- `src/components/UniverseTable.tsx`
- `src/components/DataSourcePanel.tsx`
- `src/components/StatusTimeline.tsx`

当前状态：

- `ReportView` 已有 `language: 'zh' | 'en'`。
- 但中文模式仍出现大量英文：
  - `Readable Web Report`
  - `Raw Data First`
  - `Top 5 Opportunities`
  - `Bottom 5 Risks`
  - `Source Markdown`
  - `Account`
  - `Positions`
  - `Financial Assistant Command Center`
  - `Live Trading Gate`
  - `unavailable`
- 工作台没有语言状态，只能混合显示。

计划：

- 新增轻量语言状态，不新增外部依赖：
  - 方案 A：在 `src/stores/uiStore.ts` 新增 `language: 'zh' | 'en'`。
  - `Dashboard`、`ReportView`、`AppNav`、工作台组件均读取此状态。
- 默认语言为 `zh`。
- 导航栏提供按钮：
  - 中文模式显示 `切换英文`。
  - 英文模式显示 `切换中文`。
- 中文模式原则：
  - UI 标签、按钮、说明、分组标题全部中文。
  - 股票代码、API 专有名词如 `Futu OpenD`、`Top 30 CSP` 可以保留英文缩写。
  - `unavailable` 在 UI 中显示为 `不可用`；后端数据原值不改，前端显示转换。
  - `Buy / Add / Hold / Trim` 可显示为 `买入 / 加仓 / 持有 / 减仓`，必要时保留英文小标签作为 tooltip 或不显示。
- 英文模式原则：
  - UI 标签整体切换为英文。
  - 不在同一标签内中英混排。
- 注意：
  - 后端 Markdown 仍可保留中英双语源文件。
  - Web 主阅读体验按照当前语言展示。

### 6. 持仓列表父子层级

相关文件：

- `shared/types.ts`
- `api/futu_bridge/futu_account.py`
- `src/components/workspace/PositionsPanel.tsx`

当前状态：

- `Position` 类型只有：
  - `ticker`
  - `name`
  - `quantity`
  - `marketValue`
  - `averageCost`
  - `currentPrice`
  - `unrealizedPnL`
  - `pnlRatio`
  - `positionRatio`
  - `currency`
- `PositionsPanel` 是扁平表格。
- `futu_account.py` 只保留 `ticker = code.split(".", 1)[1]`，未保留原始 `code`、证券类型、期权标的、到期日、行权价、方向等信息。

计划：

#### 后端与类型补充

- 更新 `shared/types.ts` 的 `Position`：
  - 新增 `code: string`
  - 新增 `assetType: 'STOCK' | 'OPTION' | 'ETF' | 'OTHER'`
  - 新增 `underlyingTicker: string`
  - 新增 `optionType?: string`
  - 新增 `strike?: string`
  - 新增 `expirationDate?: string`
  - 新增 `contractSummary?: string`
- 更新 `api/futu_bridge/futu_account.py`：
  - 保留 Futu 原始 `code`。
  - 尝试从 row 中读取证券类型字段，例如 `stock_type` / `sec_type` / `position_side` 等可用字段。
  - 若 Futu 返回的是期权代码，使用安全解析逻辑推导：
    - `underlyingTicker`
    - `expirationDate`
    - `optionType`
    - `strike`
  - 如果无法可靠解析，`assetType` 标为 `OTHER`，`underlyingTicker` 使用 ticker。
  - 所有不可得字段返回 `unavailable`。

#### 前端分组展示

- 将 `PositionsPanel` 改为层级卡片：
  - 父层级：`underlyingTicker` / 股票名称。
  - 父层 summary：
    - 正股数量。
    - 正股市值。
    - 相关期权数量。
    - 合计 P/L。
    - 父级展开/收起按钮。
  - 子层列表：
    - 正股行。
    - 期权合约行。
    - ETF/OTHER 行。
- 默认行为：
  - 有持仓时按 `underlyingTicker` 分组。
  - 默认展开前 5 个市值最高的父组。
  - 空持仓继续显示中文空状态。
- 子行颜色：
  - 正股：sky/cyan。
  - Call：emerald。
  - Put：amber。
  - 风险/亏损：red。

### 7. 页面结构调整

目标文件：

- `src/pages/Dashboard.tsx`
- `src/pages/ReportView.tsx`

计划：

- 首页添加 section id：
  - `account`
  - `positions`
  - `risk`
  - `data-source`
  - `research`
  - `report-center`
  - `watchlist`
  - `trading`
- 报告页添加/补充 section id：
  - `raw`
  - `top5`
  - `bottom5`
  - `remaining`
  - `quality`
  - `markdown-source`
- 页面顶部使用 `AppNav`。
- 保持当前双栏结构，但浅色背景下提升分区间距、边框和标题可读性。

## Proposed Changes By File

### `index.html`

- `html lang` 改为 `zh-CN`。
- `title` 改为 `金融助手工作台`。

### `src/stores/uiStore.ts`（新增）

- 新增全局 UI 状态：
  - `language: 'zh' | 'en'`
  - `toggleLanguage`
  - `setLanguage`

### `src/utils/displayText.ts`（新增）

- 新增显示层转换工具：
  - `displayUnavailable(value, language)`：中文模式将 `unavailable` 显示为 `不可用`。
  - `displayVerdict(value, language)`：转换 `Buy / Add / Hold / Trim`。
  - `displayTrack(value, language)`：转换 Track 展示。
  - `formatUiLabel(key, language)`：必要时统一标签。

### `src/components/common/AppNav.tsx`（新增）

- 全局 sticky 导航。
- 中文默认。
- 支持工作台和报告页链接。
- 支持语言切换。

### `src/components/common/Badge.tsx`

- 调整浅色背景下各 tone 的颜色。
- 保持现有 `tone` API，避免大范围调用改动。

### `src/components/common/MetricCard.tsx`

- 调整为浅色卡片风格。
- 支持更明显的 accent 左边框或顶部条。

### `src/pages/Dashboard.tsx`

- 使用浅色背景。
- 引入 `AppNav`。
- 为各模块增加锚点 id。
- 将错误提示改为浅色页面下可读样式。

### `src/pages/ReportView.tsx`

- 使用浅色背景。
- 引入 `AppNav`。
- 报告内部导航改为中文默认 sticky 二级导航。
- 传入全局语言状态，而不是局部 `useState`。

### `src/components/UniverseTable.tsx`

- 重构为列配置驱动。
- 增加列隐藏工具栏。
- 增加 `隐藏 unavailable 列`、`显示全部列`、列 checkbox。
- 中文模式不显示 `unavailable` 原文，而显示 `不可用`。

### `src/components/workspace/PositionsPanel.tsx`

- 从扁平表格改为父子层级列表。
- 以 `underlyingTicker` 或股票名称聚合。
- 支持展开/收起。
- 子行区分正股、期权、其他资产。

### `shared/types.ts`

- 扩展 `Position` 类型，增加分组和期权字段。

### `api/futu_bridge/futu_account.py`

- 增加 `code`、`assetType`、`underlyingTicker`、期权字段输出。
- 增加安全解析函数：
  - `detect_asset_type(row, ticker, code)`
  - `parse_option_contract(code, ticker, row)`

### `src/components/workspace/*.tsx`

- 清理中英混杂：
  - `Account` -> `账户`
  - `Positions` -> `持仓`
  - `Risk` -> `风险`
  - `Report` -> `报告`
  - `Watchlist` -> `观察列表`
  - `Live Trading Gate` -> `实盘交易门禁`
- 所有英文模式通过 `language === 'en'` 单独渲染，不和中文混在同一句里。

### `src/components/report/*.tsx`

- 清理中英混杂：
  - 中文模式标题、按钮、说明、指标名全部中文。
  - 英文模式整体英文。
  - `Markdown` 作为文件格式名可保留，但描述文字中文化为 `Markdown 源文件`。

### `src/components/DataSourcePanel.tsx`

- 中文化标题和状态。
- 保留 `Futu OpenD`、`Python SDK` 等专有名词。

### `src/components/StatusTimeline.tsx`

- 中文化 pipeline 阶段：
  - 股票池
  - 市场数据
  - 完整性校验
  - 分析
  - 源文件

## Assumptions & Decisions

- 默认语言为中文。
- “支持文字转换成英文”实现为全局语言切换，不引入自动翻译服务；所有 UI 文案使用内置双语字典。
- 股票代码、`Futu OpenD`、`CSP`、`Top 30`、`Markdown` 作为专有名词可以在中文界面保留。
- 后端原始数据中的 `unavailable` 不改，前端展示层中文模式显示为 `不可用`。
- 列隐藏仅影响 Web 展示，不影响后端报告数据和 Markdown 源文件。
- 持仓父子层级优先依赖 Futu 返回字段；无法可靠识别的资产归入 `OTHER`，并按自身 ticker 分组，避免错误归类。
- 不实现复杂用户偏好持久化；列显隐和展开状态第一版使用组件本地 state，刷新页面后恢复默认。

## Verification Steps

### 自动化验证

运行：

```bash
PATH=/Users/ShockCao/AICoding/Financial/.tools/node/bin:$PATH npm run check
PATH=/Users/ShockCao/AICoding/Financial/.tools/node/bin:$PATH npm test
PATH=/Users/ShockCao/AICoding/Financial/.tools/node/bin:$PATH npm run build
```

验收：

- TypeScript 无错误。
- 现有测试通过。
- 生产构建成功。

### API 验证

验证：

- `GET /api/account/dashboard`
- `POST /api/report/generate`

验收：

- `positions` 中每条记录包含新增字段：
  - `code`
  - `assetType`
  - `underlyingTicker`
- 报告仍返回 30 行 rawData。
- `GOOG · Alphabet` 仍保持正确。

### 浏览器验证

首页：

- 浏览器 tab 标题为 `金融助手工作台`。
- 页面整体不再是深黑风格。
- 顶部有 sticky 导航栏，可跳转到账户、持仓、风险、研究、报告、实盘入口。
- 默认中文，无明显中英混杂。
- 语言切换后进入英文界面。
- 持仓列表为父子层级，父层是股票/标的，子层包含正股和期权。

报告页：

- 顶部有全局导航和报告内部导航。
- 默认中文，无明显中英混杂。
- 30 行数据表支持列隐藏。
- 点击 `隐藏不可用列` 后，不可用字段密集的列被隐藏。
- 点击 `显示全部列` 后恢复。
- 英文切换后报告页整体英文。

### 回归验证

- 生成报告仍可成功。
- 实盘交易入口仍只生成预览，不提交真实订单。
- Markdown 源文件仍可复制/下载。
- `unavailable` 后端值不被篡改，只在 UI 中文模式显示为 `不可用`。

## Execution Order

1. 更新站点标题和 HTML 语言。
2. 新增 `uiStore` 和显示转换工具。
3. 新增全局 `AppNav`。
4. 调整全局页面背景、卡片、Badge、MetricCard 为浅色风格。
5. 重构首页布局锚点和中文文案。
6. 重构报告页导航、语言状态和中文文案。
7. 重构 `UniverseTable` 为列配置驱动，并实现列隐藏。
8. 扩展 `Position` 类型和 `futu_account.py` 输出字段。
9. 将 `PositionsPanel` 改为父子层级列表。
10. 清理工作台与报告组件内的中英混杂文案。
11. 运行类型检查、测试、构建。
12. 启动本地服务，进行 API 与浏览器验收。
