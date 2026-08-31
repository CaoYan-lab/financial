# 实时股票页视觉设计与跳转原型计划

## Summary

本阶段只做“视觉设计稿还原”和“跳转展示效果”，不直接接入真实 Futu 回调，也不启动后台订阅服务。

目标是先让用户看到完整页面形态：
- 从工作台持仓列表点击股票/标的，进入实时股票页。
- 从报告页 Top 5、Bottom 5、30 行数据表点击股票，进入实时股票页。
- 实时股票页展示未来将由 Futu 回调刷新的模块：实时分时、实时 K 线、实时报价、实时摆盘。
- 页面视觉必须保持当前“金融助手工作台”的浅色、正式、专业风格。

用户确认视觉稿后，下一阶段再实施后端 Futu 回调订阅与前端真实数据接入。

## Current State Analysis

### 当前前端路由

- `src/App.tsx`
  - 当前只有 `/` 工作台。
  - 当前只有 `/report` 可读报告。
  - 尚无股票详情页路由，例如 `/stocks/:ticker`。

### 当前点击入口

- `src/components/workspace/PositionsPanel.tsx`
  - 当前父层股票组是展开/收起按钮。
  - 当前子层持仓行没有详情跳转。
  - 持仓已按 `underlyingTicker` 父子层级聚合，适合把父层股票代码作为详情页入口。

- `src/components/report/TopOpportunitiesPanel.tsx`
  - 当前 Top 5 股票卡片展示 `ticker · companyName`，但没有链接。

- `src/components/UniverseTable.tsx`
  - 当前 30 行数据表的 `ticker` 是普通单元格，不可点击。

- `src/pages/ReportView.tsx`
  - 当前报告由多个结构化组件组成，适合逐步增加股票详情跳转。

### 当前后端

- `api/app.ts`
  - 当前注册路由包括 `/api/account`、`/api/report`、`/api/source`、`/api/trade`。
  - 尚无 `/api/realtime` 或 `/api/stocks/:ticker/realtime`。

- `api/futu_bridge/futu_snapshot.py`
  - 当前只做一次性行情、技术指标、期权链快照获取。
  - 尚无 Futu 实时回调订阅进程。

### 当前限制

- `package.json` 当前没有图表库。
- 为了先还原视觉，本阶段不新增复杂图表依赖。
- 分时/K 线先用纯 CSS/SVG 或静态 mock 数据画出视觉占位；真实图表与回调数据接入留到下一阶段。

## Design Goal

### 页面定位

新增“实时股票页”作为工作台里的单股作战面板：

- 左侧/顶部看核心价格和实时状态。
- 中间看分时与 K 线。
- 右侧看实时摆盘、报价、持仓关联。
- 底部看报告策略上下文与数据时间戳。

页面应明显表达：
- 数据来自 Futu 实时回调。
- 当前设计阶段可使用 mock/占位数据。
- 后续真实接入时每次回调刷新覆盖最新数据，不做历史堆积。

## Proposed Changes

### 1. 新增实时股票页路由

文件：`src/App.tsx`

计划新增：
- `Route path="/stocks/:ticker" element={<RealtimeStockView />} />`

路由示例：
- `/stocks/GOOG`
- `/stocks/NVDA`
- `/stocks/TSLA`

### 2. 新增实时股票页

新增文件：`src/pages/RealtimeStockView.tsx`

页面结构：

```text
┌────────────────────────────────────────────────────────────────────┐
│ AppNav：金融助手工作台 / 实时行情 / 返回工作台 / 返回报告            │
├────────────────────────────────────────────────────────────────────┤
│ 股票头部 Hero                                                       │
│ GOOG · Alphabet                                                     │
│ $187.01  -0.12%   Futu 回调已连接 / 模拟视觉稿                       │
│ [加入观察] [刷新快照] [返回来源页]                                   │
├───────────────────────┬──────────────────────────┬─────────────────┤
│ 实时报价卡片           │ 今日关键指标              │ 持仓摘要         │
│ 最新价 / 涨跌 / 成交量 │ 开高低收 / VWAP / 时间戳  │ 市值/今日盈亏    │
├───────────────────────┴──────────────────────────┴─────────────────┤
│ 主图区域                                                            │
│ Tabs: 分时 / K 线                                                    │
│ ┌────────────────────────────────────────────────────────────────┐ │
│ │ 分时折线视觉 或 K线蜡烛视觉                                      │ │
│ │ 当前价水平线、开盘价线、回调更新时间                              │ │
│ └────────────────────────────────────────────────────────────────┘ │
├─────────────────────────────┬──────────────────────────────────────┤
│ 实时摆盘 Order Book          │ 实时 K 线 / 分时回调状态              │
│ 卖五到卖一 红色              │ 分时：最新点数、最后回调时间          │
│ 买一到买五 绿色              │ K线：周期、最后一根 K 线时间          │
├─────────────────────────────┴──────────────────────────────────────┤
│ 报告上下文                                                           │
│ 若来自 Top30 报告：评级、Track、Put 指引、数据质量提示                │
└────────────────────────────────────────────────────────────────────┘
```

### 3. 新增视觉组件

新增目录：`src/components/realtime/`

计划组件：
- `RealtimeStockHeader.tsx`
  - 展示 ticker、公司名、最新价、涨跌、实时状态、返回入口。
- `RealtimeQuoteCards.tsx`
  - 展示最新价、涨跌额、涨跌幅、成交量、更新时间。
- `IntradayChartMock.tsx`
  - 用 SVG 绘制分时折线视觉稿。
  - 颜色规则：上涨红色、下跌绿色，符合当前项目盈亏颜色口径。
- `RealtimeKlineMock.tsx`
  - 用 SVG/HTML div 绘制 K 线视觉稿。
  - K 线红涨绿跌。
- `OrderBookPanel.tsx`
  - 展示卖盘红色、买盘绿色。
  - 每档展示价格、数量、占比条。
- `RealtimeStatusPanel.tsx`
  - 展示四类回调状态：
    - 实时分时回调
    - 实时 K 线回调
    - 实时报价回调
    - 实时摆盘回调
- `StockReportContextPanel.tsx`
  - 展示来自 Top30 报告的该股票评级/Track/期权策略摘要。
  - 若没有报告上下文，则展示“暂无报告上下文”。

### 4. 设计阶段 mock 数据

新增文件：`src/mocks/realtimeStockMock.ts`

用途：
- 只服务视觉稿。
- 根据 `ticker` 生成稳定 mock 数据。
- 不声称是真实行情。
- 页面上明确显示“视觉稿 / Mock 数据”状态。

Mock 数据字段：

```ts
type RealtimeStockMock = {
  ticker: string
  companyName: string
  price: string
  change: string
  changePercent: string
  open: string
  high: string
  low: string
  volume: string
  quoteUpdatedAt: string
  intradayUpdatedAt: string
  klineUpdatedAt: string
  orderBookUpdatedAt: string
  intradayPoints: Array<{ time: string; price: number }>
  klineBars: Array<{ time: string; open: number; high: number; low: number; close: number }>
  asks: Array<{ price: string; size: string; depth: number }>
  bids: Array<{ price: string; size: string; depth: number }>
}
```

### 5. 持仓列表跳转设计

文件：`src/components/workspace/PositionsPanel.tsx`

视觉设计：
- 父层股票组保留展开/收起。
- 父层新增一个独立入口按钮：`实时行情`。
- 子层正股和期权行的 `合约/代码` 区域可点击进入对应 `underlyingTicker` 的实时股票页。
- 期权行点击也进入正股标的页，而不是期权合约页。

交互设计：
- 点击展开/收起仍然只控制层级。
- 点击 `实时行情` 进入 `/stocks/{group.key}`。
- 子行点击进入 `/stocks/{position.underlyingTicker || position.ticker}`。

### 6. 报告页跳转设计

文件：
- `src/components/report/TopOpportunitiesPanel.tsx`
- `src/components/report/BottomLosersPanel.tsx`
- `src/components/report/RemainingStocksPanel.tsx`
- `src/components/UniverseTable.tsx`

视觉设计：
- 股票代码旁增加 `实时` 小标签或 `查看实时行情` 链接。
- Top 5 卡片标题 `ticker · companyName` 可点击。
- 30 行纯数据表中的 `ticker` 单元格可点击。
- Bottom 5/其余股票中的 ticker badge 可点击。

跳转：
- 全部进入 `/stocks/{ticker}`。

### 7. 后续真实回调架构设计，不在本阶段实施

本阶段只做视觉稿。用户确认后，下一阶段再实现：

后端计划新增：
- `api/realtime/realtimeStore.ts`
  - 内存 Map 覆盖式存储：
    - `quoteByTicker`
    - `tickerByTicker`
    - `klineByTicker`
    - `orderBookByTicker`
  - 每次 Futu 回调覆盖对应 ticker 最新数据。

- `api/realtime/realtimeSubscriptionService.ts`
  - 管理订阅 Top30 股票池。
  - 防止重复订阅。
  - 提供启动/停止/状态查询。

- `api/routes/realtimeRoutes.ts`
  - `GET /api/realtime/:ticker`
  - `GET /api/realtime/status`
  - `POST /api/realtime/subscribe-top30`

- `api/futu_bridge/futu_realtime_subscribe.py`
  - 负责 Futu OpenD 回调：
    - 实时分时回调
    - 实时 K 线回调
    - 实时报价回调
    - 实时摆盘回调
  - 订阅标的是 Top30 报告股票池。

前端真实接入计划：
- `src/stores/realtimeStore.ts`
- `src/hooks/useRealtimeStock.ts`
- 页面轮询或 SSE/WebSocket 读取后端缓存。

### 8. 视觉规范

整体风格：
- 延续浅色金融工作台。
- 背景：`slate-50 / cyan-50 / indigo-50` 渐变。
- 卡片：白色半透明、圆角、浅边框。
- 字体：沿用当前正式字体体系。
- 行情颜色：
  - 正涨/盈利：红色。
  - 下跌/亏损：绿色。
  - 中性/无数据：灰色。

状态颜色：
- 实时连接：绿色。
- 视觉稿/mock：琥珀色。
- 数据断开：红色。
- 待订阅：灰色。

## Assumptions & Decisions

- 本阶段不实现 Futu 回调，只还原视觉和跳转。
- 本阶段可使用 mock 数据，但页面必须明确标注“视觉稿 / Mock 数据”。
- 跳转目标统一为正股/底层标的实时页。
- 期权合约行不单独建期权详情页。
- 后续回调订阅标的来自 Top30 报告股票池。
- 回调数据采用覆盖式刷新，不做无限历史堆积。
- 实时页默认中文，继续支持全局中英文切换。

## Acceptance Criteria

视觉稿阶段完成后应满足：

- 工作台持仓父层能看到 `实时行情` 入口。
- 持仓子层正股/期权行能点击跳转到实时股票页。
- 报告 Top 5 卡片能点击股票进入实时股票页。
- 报告 30 行数据表 ticker 能点击进入实时股票页。
- `/stocks/:ticker` 页面可打开。
- 实时股票页包含：
  - 股票头部信息。
  - 实时报价卡片。
  - 分时视觉图。
  - K 线视觉图。
  - 实时摆盘视觉。
  - 四类回调状态。
  - 报告上下文。
- 页面清楚标注当前是视觉稿/mock 数据，不误导为真实行情。

## Verification Steps

视觉稿实现后执行：

1. `npm run check`
2. `npm test`
3. `npm run build`
4. 启动本地开发服务。
5. 浏览器验证：
   - 打开 `/`。
   - 点击持仓父层 `实时行情`。
   - 确认进入 `/stocks/{ticker}`。
   - 返回 `/report`。
   - 点击 Top 5 股票标题。
   - 点击 30 行表格里的 ticker。
   - 确认跳转页面和视觉布局符合设计。

## Out Of Scope For This Stage

- 不接 Futu 真实实时回调。
- 不启动常驻订阅进程。
- 不新增 WebSocket/SSE。
- 不新增真实图表库。
- 不处理实时数据持久化。
- 不实现历史回放。
- 不新增实盘交易入口。

