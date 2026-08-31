# Futu A 股行情订阅与 LLM 实盘接入计划

> 修订说明：本版根据反馈调整信息架构。A 股入口不再放在 Futu 工作台内部，而是在一级平台选择页与 `Futu 量化交易工作台`、`Longbridge 量化交易工作台` 并列，形成独立的 `A 股量化工作台`。进入 A 股工作台后，功能入口和 UI 密度参考现有 Futu / Longbridge 两个量化工作台，但数据、股票池、交易规则和风控边界独立。

## Revised Summary

新增一级入口 `A 股量化工作台`，路径建议为 `/a-share`。根路径 `/` 的平台选择页从两张卡片升级为三张卡片：

- `Futu 量化交易工作台`
- `Longbridge 量化交易工作台`
- `A 股量化工作台`

A 股工作台内部提供独立的查询与订阅入口：用户输入 `SH.600519` / `SZ.000001` / 6 位股票代码，后端通过 Futu OpenD 查询真实证券信息；用户点击 `+ 订阅进股票池` 后，该标的加入 A 股工作台自己的 LLM 股票池，并触发行情订阅、数据缓存、LLM 评估、候选池和人工确认流程。

第一版只允许 A 股多头交易：允许 `BUY` 和已有多头的 `SELL_TO_CLOSE`，禁止 `SELL_SHORT`；A 股不支持盘前、盘后、夜盘，午休和收盘后跳过 LLM 请求。

静态原型已生成：

- `/Users/ShockCao/AICoding/Financial/.trae/documents/a_share_workbench_prototype.html`
- `/Users/ShockCao/AICoding/Financial/.trae/documents/a_share_workbench_prototype_v2.html`

## Design Logic From Existing Pages

本次实现必须先遵守现有页面结构，不重新发明一套 A 股 UI。A 股只是新增一个一级入口和一套独立工作台，视觉、布局密度、模块组织应从当前页面继承。

### 0. 隔离原则：禁止改动原有模块

这是实现阶段的硬约束：

- 禁止修改现有 Futu 工作台的业务逻辑、数据结构、股票池、行情订阅、实盘引擎和页面样式。
- 禁止修改现有 Longbridge 工作台的业务逻辑、数据结构、行情适配、实盘引擎和页面样式。
- 禁止为了 A 股入口去重写 `Futu` 或 `Longbridge` 现有卡片的颜色、布局、文案结构和交互。
- 一级入口页只允许新增 A 股卡片，以及为容纳第三张卡片做最小布局调整；已有 Futu / Longbridge 卡片必须保持当前视觉风格。
- A 股相关前端代码必须放在新目录，例如：
  - `src/pages/ashare/`
  - `src/components/ashare/`
  - `src/hooks/ashare/`
- A 股相关后端代码必须放在新目录，例如：
  - `api/ashare/`
  - `api/routes/aShareRoutes.ts`
- Futu Python bridge 如需补充 A 股能力，只能新增独立脚本或做最小兼容函数扩展；不得破坏现有 US/HK 路径。
- A 股股票池、缓存、候选池、历史信号和配置必须独立持久化，不得写入现有 Futu / Longbridge 的运行数据。

### 1. 一级入口：复用现有平台卡片

来源页面：

- `src/pages/PlatformSelectView.tsx`
- 参考原型：`.trae/documents/platform_workbench_entry_page_prototype.html`

实现规范：

- 根路径 `/` 仍是平台选择页。
- 当前已有卡片：
  - `Futu 量化交易工作台`
  - `Longbridge 量化交易工作台`
- 新增第三张同款卡片：
  - `Futu A股量化工作台`
- 这张卡片必须使用现有 `PlatformCard` 的同一结构：
  - 图标区
  - 状态 Badge
  - 标题
  - description
  - detail
  - capabilities 六宫格
  - CTA
  - route label
- 一级入口继续沿用当前页面的一行两卡片节奏：
  - 大屏固定两列，不改成三列。
  - 第一行放 `Futu 量化交易工作台` 和 `Longbridge 量化交易工作台`。
  - 第二行放新增的 `Futu A股量化工作台` 卡片；该卡片仍使用同款卡片结构和宽度。
  - 中小屏按现有响应式规则收敛为单列或两列，避免横向滚动。
- 不允许把 A 股入口放进 Futu 卡片内部，也不允许只在 Futu 实盘页加查询卡。
- 不允许为了新增 A 股卡片改变已有 Longbridge 蓝青/靛色卡片风格；老卡片保持现状，新卡片单独新增。

A 股入口卡片文案：

- title：`Futu A股量化工作台`
- status：`新增入口`
- description：`使用 Futu OpenD 查询和订阅沪深 A 股，但作为独立市场入口，不放进现有 Futu 美股/港股工作台。`
- detail：`手动查询真实 SH/SZ 订阅代码，点击 + 后进入 A 股股票池；只多头、CNY 口径、午休/收盘自动跳过 LLM。`
- capabilities：
  - `SH/SZ 查询`
  - `独立股票池`
  - `逐笔成交`
  - `1m K线`
  - `只多头风控`
  - `候选池`
- route：`/a-share`

### 2. 二级页面：复用现有工作台模块组织

来源页面：

- Futu 二级工作台：`src/pages/Dashboard.tsx`
- Longbridge 二级工作台：`src/pages/LongbridgeWorkbenchPlaceholder.tsx`

实现规范：

- 新增路径 `/a-share`。
- 页面不是一个单独查询表单，而是和现有工作台一样的总览工作台。
- 顶部必须有平台工作台导航，结构参考：
  - 返回平台选择
  - 进入 Futu 工作台
  - 进入 Longbridge 工作台
  - 语言切换
- 品牌区必须显示：
  - `Futu A股量化交易工作台`
  - 副标题：`沪深A股 · Futu OpenD · 查询 · 订阅 · 风控`
- 主 Header 参考 `CommandCenterHeader`：
  - rounded card
  - eyebrow
  - 大标题
  - 说明文案
  - 状态 badges
  - 右侧操作按钮
- 二级工作台内容采用现有两列模块布局：
  - 左列：账户/查询订阅/风险
  - 右列：研究机会/报告中心/股票池
- 卡片风格必须沿用当前暖色：
  - 暖米背景
  - 白色卡片
  - 炭灰文字
  - 金橙主按钮
  - 玫瑰风险提示
- 不允许恢复蓝紫/青色作为 A 股主色。

二级页面模块：

- `A股账户与资金口径`
  - CNY 总资产
  - 现金
  - 购买力
  - 可用资金
- `真实 A股代码查询`
  - 输入 SH/SZ 或 6 位数字
  - 查询 Futu 真实代码
  - 结果行
  - `+ 订阅进股票池`
- `A股风控规则`
  - 禁止 SELL_SHORT
  - 只允许连续竞价时段评估
  - 午休/收盘/周末跳过
  - T+1 / 涨跌停 / CNY 口径
- `A股机会指挥台`
  - 股票池标的行情状态
  - tickerPoints 状态
  - 入口到实盘页
- `A股策略与信号历史`
  - 历史信号
  - 候选池
  - 待确认
  - 跳过原因
- `A股独立股票池`
  - 展示用户通过查询订阅加入的 SH/SZ 标的

### 3. 三级页面：复用当前 Futu 实盘页结构

来源页面：

- `src/pages/LiveTradingView.tsx`
- `src/pages/longbridge/LongbridgeLiveTradingView.tsx`

新增路径建议：

- `/a-share/live-trading`

实现规范：

- 页面结构必须对齐当前 Futu REAL 实盘页：
  - 顶部 Hero：`真实操作盘 A股量化交易`
  - Badge：环境、门禁、人工确认/自动下单、A 股禁止卖空
  - 操作按钮：启动、停止、单轮评估、刷新
  - 自动下单开关卡片
  - 五个指标卡
  - LLM CONFIG
  - GUARDRAILS
  - 策略与提示词版本
  - 候选池与组合裁决
  - 历史策略信号
  - 待确认订单队列
  - 实盘订单状态
- 现有 Futu 实盘页允许 `SELL_SHORT` 入队；A 股页必须改为：
  - `SELL_SHORT` 不允许入队
  - 后端硬风控拦截
  - Python 下单桥二次拦截
  - UI guardrail 显示 `A 股禁止卖空`
- 待确认订单过滤方向只显示：
  - `ALL`
  - `BUY`
  - `SELL_TO_CLOSE`
- 不显示 `SELL_SHORT` 作为可选方向，历史里如有模型误返回只能显示为拦截记录。

### 3.1 历史信号与待确认订单列表必须复用老页面逻辑

这是 A 股三级实盘页实现的硬约束，不能做成简化版卡片列表：

- `A股历史信号` 必须对齐当前 Futu 美港股实盘页与 Longbridge 实盘页的历史策略信号模块：
  - 顶部显示总数。
  - 保留筛选区：方向、标的、生命周期状态。
  - 数据行布局与老逻辑一致：左侧为 `ticker + side + lifecycle badge`，右侧为时间；正文展示 `reason`、`riskAssessment`、`dataWindow`、`tradeHorizon`、`trendAlignment`、`whyNotNoise`。
  - 非 HOLD 信号如果没有进入待确认队列，必须展示 lifecycle reason / skipped reason，不能只隐藏。
  - 分页行为与老逻辑一致：上一页、下一页、当前页、总页数。
- `A股待确认订单` 必须对齐当前 Futu 美港股实盘页与 Longbridge 实盘页的待确认订单队列：
  - 顶部显示总数。
  - 保留筛选区：状态、标的、方向。
  - A 股方向筛选只允许 `ALL`、`BUY`、`SELL_TO_CLOSE`，不显示 `SELL_SHORT` 选项。
  - 数据行排列与老逻辑一致：订单号、状态 badge、标的、方向、数量、限价、创建时间、来源、风险提示、LLM 理由、确认/查看操作区。
  - 行内明细必须展示 `intent.reason`、`intent.sizingReason`、`riskWarnings`、`decisionMode`、`candidateId`、`feeContext.warning`，不能只展示 ticker/side/price。
  - 保留批量过期/批量清理入口的 UI 位置；A 股第一版如暂不接真实清理 API，也必须以禁用按钮和说明呈现，不允许删掉该区域。
- `A股候选池` 表格必须对齐 Longbridge/Futu 候选池历史表：
  - 列结构至少包含：标的/方向、分组、信号次数、价格漂移、建议名义金额、状态、最近出现时间、组合裁决/置信度。
  - 不再使用简单卡片堆叠作为最终形态。
- A 股相关列表可以使用暖色调，但交互结构、筛选维度、行内明细字段必须与老页面一致；只允许因 A 股风控删除 `SELL_SHORT` 方向，不允许删减列表能力。

### 3.2 老逻辑直推与组合策略裁决必须复用 Futu / Longbridge executionMode 语义

当前 Futu 美港股与 Longbridge 的真实实现已经形成统一语义，A 股必须完全继承，不能自创“永远写候选池”的简化流程：

来源代码：

- Futu 美港股：
  - `api/live/liveTradingEngine.ts`
  - `api/live/liveCandidatePoolService.ts`
  - `api/live/liveOrderQueueService.ts`
  - `src/pages/LiveTradingView.tsx`
  - `src/components/trading/TradeStrategyConfigPanel.tsx`
- Longbridge：
  - `api/longbridge/longbridgeLiveTradingEngine.ts`
  - `api/longbridge/longbridgeCandidatePoolService.ts`
  - `src/pages/longbridge/LongbridgeLiveTradingView.tsx`
- 策略配置：
  - `api/trade_strategy/tradeStrategyConfigService.ts`
  - `trade_strategy/portfolio_review_packs/live_portfolio_candidate_review_v1.yaml`

必须保持的模式定义：

- `legacy_direct`：老逻辑直推。
  - 链路必须是：`标的扫描 -> LLM 单标的决策 -> 后端硬风控 -> 待确认订单 -> 人工确认 / 自动下单门禁`。
  - 非 HOLD 且通过硬风控的信号必须直接生成待确认订单。
  - 不写入候选池。
  - 不调用组合裁决 Prompt。
  - 待确认订单的 `decisionMode` 必须是 `legacy_direct`。
  - UI 文案必须显示 `大模型直推` 或 `老逻辑直推`，不得显示为候选池裁决。
- `candidate_pool`：组合策略裁决。
  - 链路必须是：`标的扫描 -> LLM 单标的决策 -> 候选池 -> DeepSeek 组合裁决 -> 后端硬风控 -> 待确认订单 -> 人工确认 / 自动下单门禁`。
  - 非 HOLD 信号先写入候选池，历史信号仍完整记录。
  - 候选池经组合裁决 `PROMOTED` 后，才允许生成待确认订单。
  - 待确认订单必须带：
    - `decisionMode: 'candidate_pool'`
    - `candidateId`
    - `portfolioDecisionId`（如组合裁决返回）
    - `portfolioRank`（如组合裁决返回）
    - `portfolioDecisionReason`
  - 风险提示中必须包含候选池来源和组合裁决理由。
  - 被 `WATCH` / `SUPPRESSED` / `EXPIRED` / `DISABLED_BY_MODE_SWITCH` 的候选不得进入待确认订单。

A 股必须新增并复用同款配置能力：

- A 股实盘页必须出现与 Futu / Longbridge 一致的 `策略与提示词版本` 区块。
- 必须支持切换：
  - 策略版本
  - 提示词版本
  - `legacy_direct` / `candidate_pool`
  - 组合策略时间预设
- A 股的 executionMode 可以独立持久化，但字段含义必须与 Futu / Longbridge 一致。
- 切换到 `legacy_direct` 时，A 股候选池中未完成候选必须标记为 `DISABLED_BY_MODE_SWITCH` 或至少不再推进。
- 切换到 `candidate_pool` 时，后续非 HOLD 信号必须先进入候选池，不得直接进入待确认订单。

A 股订单与历史库必须按模式写入：

- `signals`：
  - 两种模式都必须写入所有 LLM 单标的信号。
  - HOLD 只进入历史信号，不进入候选池和待确认订单。
- `candidate_pool`：
  - 只允许 `candidate_pool` 模式写入。
  - `legacy_direct` 模式不得写入候选池。
- `pending_orders`：
  - `legacy_direct` 模式：通过硬风控后直接写入。
  - `candidate_pool` 模式：只有组合裁决推进后写入。
- `skipped`：
  - 行情不足、休市、A 股禁止卖空、风控拦截、组合裁决未推进，都必须写入明确 skipped/lifecycle reason，历史信号页必须能显示原因。

A 股 UI 必须按当前模式展示：

- Header Badge：
  - `candidate_pool` 显示 `组合策略已开启`
  - `legacy_direct` 显示 `大模型直推` 或 `老逻辑直推`
- 候选池面板：
  - `candidate_pool`：显示当前链路、组合裁决 Prompt、时间预设、候选历史。
  - `legacy_direct`：显示“组合策略已关闭 · 老逻辑直推”，候选池只读展示历史，不得暗示新信号会进入候选池。
- 待确认订单来源：
  - `legacy_direct` 显示 `大模型直推`
  - `candidate_pool` 显示 `候选池裁决`
- A 股禁止 `SELL_SHORT` 是额外风控，不得改变 executionMode 语义。

Mock / 演示数据要求：

- 用于页面预览的 mock 数据必须显式标注 `mock`，不得伪装成真实 LLM 或真实交易数据。
- mock 待确认订单数量必须可解释；例如当前页面出现 `A股待确认订单队列（2）`，应来自两条 `mock-ashare-pending-*` 记录，而不是系统真实生成。
- 进入真实联调前必须提供清理入口或清理脚本，删除：
  - `.data/a-share-universe.json` 中的 mock 标的
  - `.data/a-share-live-history.sqlite3` 中的 `mock-ashare-*` 信号、候选、待确认订单和 skipped 记录
- 若保留 mock 数据用于视觉验收，UI 应显示 `Mock A股页面预览` 或同等提示，避免误判为真实队列。

### 3.3 Futu A 股新增 Trading Agent 第三种 executionMode

A 股模块允许作为 Trading Agent 实验入口，但必须作为独立于 `legacy_direct` 和 `candidate_pool` 的第三种逻辑存在，不能把现有两种模式混写或偷偷改语义。

新增模式定义：

- `legacy_direct`：单票 LLM 直推。
  - 链路：`标的扫描 -> 单票 LLM 决策 -> 后端硬风控 -> 待确认订单`。
  - 目标是最快速地形成单票交易建议。
- `candidate_pool`：单票 LLM + 候选池组合裁决。
  - 链路：`标的扫描 -> 单票 LLM 决策 -> 候选池 -> 组合裁决 -> 后端硬风控 -> 待确认订单`。
  - 目标是解决多票、多轮、同组候选之间“买哪个、先买哪个”的排序问题。
- `trading_agent`：多角色 Agent 研究链。
  - 链路：`标的扫描 -> 多角色 Agent 分析 -> Portfolio Manager 最终裁决 -> 后端硬风控 -> 待确认订单`。
  - 目标是解决“这个交易决策是否站得住、反方观点是什么、风险是否充分审查”的问题。

`trading_agent` 的边界：

- 必须是 A 股独立实验模式，第一阶段只在 Futu A 股模块落地。
- 不得修改 Futu 美港股和 Longbridge 的现有 executionMode 行为。
- 不得替代 `legacy_direct` 或 `candidate_pool`；只能作为第三种可切换模式出现。
- 可以复用 A 股股票池、行情订阅、行情 store、持久化、风控、待确认订单和页面列表。
- 不得复用 `candidate_pool` 的“先进入候选池再组合裁决”假设；Trading Agent 应有自己的中间报告和最终裁决。
- 不得绕过 A 股 session gate、数据 readiness gate、禁止 `SELL_SHORT`、硬风控、人工确认。

第一版 Trading Agent 角色建议：

- `market_analyst`
  - 输入：120 根 1m K 线、tickerPoints、盘口、最新 quote、A 股 session 状态。
  - 输出：短线结构、趋势强度、成交活跃度、盘口压力、是否存在噪声。
- `risk_analyst`
  - 输入：A 股交易规则、涨跌幅约束、流动性、波动、订单方向、当前 session。
  - 输出：是否允许交易、主要风险、需要硬拦截的理由。
- `bull_researcher`
  - 输入：market report、risk report。
  - 输出：为什么现在可以买入或平仓卖出。
- `bear_researcher`
  - 输入：market report、risk report。
  - 输出：为什么不该交易或应该继续 HOLD。
- `portfolio_manager`
  - 输入：全部 agent 报告。
  - 输出：最终 `HOLD / BUY / SELL_TO_CLOSE` 裁决、数量、价格、置信度、风险说明。

第一版引入 GitHub 开源仓库并在其上实现 adapter：

- 上游仓库使用 `TauricResearch/TradingAgents`，默认放在 `third_party/TradingAgents`，也可通过 `TRADINGAGENTS_REPO_PATH` 指向外部 clone。
- 不复制上游源码到业务模块；上游更新通过 `git pull` 或替换 `TRADINGAGENTS_REPO_PATH` 完成。
- A 股实盘引擎不直接耦合 LangGraph 内部 API，而是通过 `api/futu_bridge/ashare_trading_agents_bridge.py` 调用上游 `TradingAgentsGraph`。
- `api/ashare/aShareTradingAgentService.ts` 只负责 adapter：
  - A 股 ticker 映射：`600519.SH -> 600519.SS`，`000001.SZ -> 000001.SZ`。
  - 上游裁决映射为本项目动作：`HOLD / BUY / SELL_TO_CLOSE`。
  - 接回 A 股硬风控、待确认订单和人工确认。
- TradingAgents 0.3.0 要求 Python >= 3.10；运行时应通过 `TRADINGAGENTS_PYTHON_BIN` 指向独立 venv，避免污染系统 Python。

`trading_agent` 数据输入要求：

- 第一版复用现有 A 股行情：
  - 120 根 1m K 线。
  - tickerPoints。
  - 盘口。
  - quote。
  - A 股 session gate。
  - A 股股票池。
- 后续再补：
  - A 股真实持仓。
  - 可用资金。
  - 行业/指数上下文。
  - 涨跌停/价格笼子/交易单位等更细规则。

Trading Agent 数据源适配要求：

- 不允许长期依赖 TradingAgents 上游默认 `yfinance` / Yahoo 数据作为 A 股实盘决策主数据源。
- GitHub 上游仓库继续作为可更新的 Agent 编排与 LLM client 依赖，但 A 股实盘数据必须由本项目 adapter 注入。
- 行情、盘口、K 线、逐笔成交必须优先来自 Futu A 股实时订阅：
  - quote。
  - 120 根 1m K 线。
  - tickerPoints。
  - order book。
  - A 股 session gate。
  - A 股股票池 universe。
- 个股新闻优先使用 Futu 新闻能力；若 Futu bridge 暂未实现新闻接口，必须在 agent report 中标记 `stockNewsContext: UNAVAILABLE`，不得回退到编造新闻。
- 宏观/国际新闻必须复用 `/Users/ShockCao/AICoding/Financial/.trae/documents/macro_news_llm_prompt_context_spec.md` 中定义的 `macroNewsContext` 结构与优先级规则。
- 宏观上下文至少覆盖：
  - 美联储 / FOMC / 利率路径。
  - 中美 CPI、PPI、PMI/CMI。
  - 美国非农就业、失业率、薪资增速。
  - 美债收益率、美元指数、人民币汇率。
  - 中美政策、地缘政治、贸易限制、行业监管。
  - 影响 A 股风险偏好的全球指数、港股、商品、能源新闻。
- 新闻和宏观上下文只能提高风险约束，不能覆盖行情事实、账户/持仓事实、后端硬风控或人工确认链路。
- 一轮 Trading Agent 扫描中，宏观新闻快照应按轮次共享，不能每个 ticker 重复搜索。
- Adapter 输出给上游 Agent 的上下文必须显式包含：
  - `marketDataContext`
  - `stockNewsContext`
  - `macroNewsContext`
  - `aShareRulesContext`
  - `universeContext`
  - `dataQualityContext`
- 当任一数据源不可用时必须写入 `dataQualityContext.warnings`，不得静默降级。

`trading_agent` 必须新增仓位与成本决策层：

- A 股 `trading_agent` 不能只做方向判断，必须把订单规模、交易成本和账户约束作为一等决策输入。
- A 股一手为 100 股，第一版至少按 100 股整数倍生成买入数量；不得在后端用固定默认值长期替代 Trading Agent 的规模判断。
- Trading Agent 在最终裁决前必须看到并考虑：
  - 当前价格 / 建议限价。
  - 最小交易单位：`lotSize = 100`。
  - 建议数量。
  - 预计名义金额：`limitPrice * orderQuantity`。
  - 预计费用。
  - 当前账户可用资金 / 购买力。
  - 当前标的持仓数量、持仓市值和成本价。
  - 单票最大名义金额、最大仓位比例、单次交易风险预算等本地配置。
- `BUY` 决策必须包含规模推理：
  - 至少计算 `limitPrice * orderQuantity + estimatedFee`。
  - 数量必须满足 A 股一手 100 股约束。
  - 如果最小 100 股对应名义金额已经超过可用资金、单票预算或风控阈值，最终动作必须降级为 `HOLD` 或返回可解释的 blocked reason。
  - LLM 可以给出建议规模，但不能绕过后端资金和交易单位硬校验。
- `SELL_TO_CLOSE` 决策也必须包含规模推理：
  - 至少计算 `limitPrice * orderQuantity` 对应的预计回收金额。
  - 数量不得超过当前可识别多头持仓。
  - 卖出数量必须符合 A 股交易单位和可卖数量规则；如涉及零股/碎股卖出限制，必须由后端规则显式处理。
  - 若账户无多头持仓或数量不合法，必须降级为 `HOLD` 或写入风控拦截原因。
- 推荐新增 `sizingContext`，由 Node adapter 在调用 Trading Agent 前注入：
  - `lotSize`
  - `lastPrice`
  - `limitPrice`
  - `availableFunds`
  - `buyingPower`
  - `targetLongQuantity`
  - `targetMarketValue`
  - `targetAverageCost`
  - `maxSingleOrderNotional`
  - `maxPositionRatio`
  - `estimatedFeeRate`
  - `minBuyNotional = lotSize * limitPrice`
- Trading Agent / Portfolio Manager 最终 JSON 必须扩展规模字段：
  - `action`
  - `limitPrice`
  - `orderQuantity`
  - `targetNotional`
  - `estimatedFee`
  - `cashImpact`
  - `positionImpact`
  - `sizingReason`
  - `minLotSatisfied`
  - `fundsSufficient`
- 职责边界：
  - Trading Agent 负责“建议规模”和解释为什么这个规模合理。
  - Node 后端负责确定性归一化和硬校验，包括 100 股整数倍、资金是否足够、数量是否超过持仓、单票预算和仓位比例。
  - Python bridge 不得把 `BUY / SELL_TO_CLOSE` 的非 HOLD 数量统一兜底为固定默认值；若 LLM 未返回合法数量，应返回 schema/risk failure，由 Node 写入 skipped/lifecycle reason。
  - 待确认订单的 `intent.sizingReason` 必须使用 Trading Agent 的规模理由和后端归一化结果，不得只写“LLM 决策生成”。

`trading_agent` 输出与安全链路：

- 最终裁决为 `HOLD`：
  - 只写入 A 股历史信号。
  - 不进入候选池。
  - 不进入待确认订单。
- 最终裁决为 `BUY` 或 `SELL_TO_CLOSE`：
  - 必须经过 A 股硬风控。
  - 风控通过后进入 A 股待确认订单。
  - 风控失败写入 skipped/lifecycle reason。
- 最终裁决若包含 `SELL_SHORT`：
  - 必须视为 schema/risk failure。
  - 不得进入候选池或待确认订单。
  - 历史信号必须标记为被 A 股规则拦截。
- 不允许自动绕过人工确认。
- 不允许绕过真实交易环境开关。

持久化要求：

- A 股历史信号必须支持：
  - `decisionMode: 'trading_agent'`
  - `agentRunId`
  - `agentReports`
  - `finalAgentDecision`
  - `agentFailureReason`
- A 股待确认订单必须支持：
  - `decisionMode: 'trading_agent'`
  - `agentRunId`
  - `portfolioDecisionReason`
  - `riskWarnings` 中写入 Trading Agent 裁决来源。
- A 股独立数据库 `.data/a-share-live-history.sqlite3` 必须保存 agent 中间报告，不能写入 Futu / Longbridge 历史库。
- agent 中间报告建议新增 kind：
  - `agent_runs`
  - 或在现有 `signals` payload 中嵌入 `agentReports`，第一版可先嵌入，后续再拆表。
- 后续正式实现必须新增 `agent_runs` 持久化结构，不能只依赖 `signals.agentReports` 临时嵌入。
- `agent_runs` 至少保存：
  - `agentRunId`
  - `ticker`
  - `decisionMode`
  - `executionMode`
  - `startedAt`
  - `completedAt`
  - `status: SUCCESS | PARTIAL | FAILED`
  - `llmPresetId`
  - `llmProvider`
  - `quickThinkLlm`
  - `deepThinkLlm`
  - `marketDataContext`
  - `stockNewsContext`
  - `macroNewsContext`
  - `dataQualityContext`
  - `roleReports`
  - `finalDecision`
  - `rawUpstreamOutput`
  - `adapterWarnings`
- `roleReports` 必须按角色拆分，至少包含：
  - `market_analyst`
  - `risk_analyst`
  - `bull_researcher`
  - `bear_researcher`
  - `portfolio_manager`
- 每个 role report 至少包含：
  - `role`
  - `status`
  - `summary`
  - `evidence`
  - `risks`
  - `recommendation`
  - `rawText`
  - `startedAt`
  - `completedAt`

UI 要求：

- Trading Agent 必须放在 A 股三级实盘页 `src/pages/ashare/AshareLiveTradingView.tsx` 内，作为实盘页 `策略与提示词版本` 区域的第三种 executionMode。
- 不允许把 Trading Agent 做成新的 A 股工作台一级入口、独立工作台卡片或脱离实盘页的单独页面；工作台只负责进入 A 股实盘页。
- A 股实盘页模块顺序必须保持为：Hero / 操作按钮 -> 指标卡 -> `LLM CONFIG + GUARDRAILS` -> `策略与提示词版本` -> 当前模式的执行明细模块 -> 历史信号与待确认订单。
- `策略与提示词版本` 区域必须支持第三种模式 `trading_agent`。
- Header Badge 显示：
  - `legacy_direct`：`大模型直推`
  - `candidate_pool`：`组合策略已开启`
  - `trading_agent`：`Trading Agent 实验`
- 历史信号来源显示：
  - `Trading Agent 裁决`
- 待确认订单来源显示：
  - `Trading Agent 裁决`
- 历史信号明细必须能展开查看：
  - market analyst report。
  - risk analyst report。
  - bull case。
  - bear case。
  - portfolio manager final decision。
- A 股实盘页必须新增 Trading Agent 专用策略说明面板；该面板语义必须对齐组合策略面板，回答“这个模式是干什么的、如何运行、边界是什么”，不能注入最近一次具体运行结果。
- Trading Agent 策略说明面板在尚未产生真实 agent run 时，也必须完整展示模式说明，避免误以为功能不存在；但不得使用“暂无运行记录”作为面板主体，因为运行记录不是该面板的职责。
- Trading Agent 策略说明面板至少包含：
  - 模式定位：多角色 Agent 研究链，不是候选池组合排序，也不是自动下单权限升级。
  - 角色分工：Market Analyst、Risk Analyst、Bull Researcher、Bear Researcher、Portfolio Manager。
  - 执行链路：`行情/上下文注入 -> 多角色分析 -> Portfolio Manager 最终裁决 -> Node 硬风控 -> 人工确认`。
  - 数据输入：Futu A 股行情、Futu 可用研究/资金/异动上下文、豆包新闻/宏观 fallback、账户持仓。
  - 硬约束：禁止 SELL_SHORT；无多头持仓不得 `SELL_TO_CLOSE`；交易时段 Gate、行情就绪 Gate、人工确认不可绕过。
  - 输出范围：`HOLD`、`BUY`、`SELL_TO_CLOSE`，且非 HOLD 仍必须经过后端硬风控。
  - 与 `candidate_pool` 的区别：Trading Agent 不写入候选池，不参与组合排序；它用于单标的深度评估。
- Trading Agent 运行结果必须进入独立的运行证据区域，不能混入策略说明面板。运行证据区域可以是历史信号展开态、Agent Run 详情抽屉、运行记录详情页，或明确命名为“最近一次运行”的只读结果卡。
- 如果在策略说明面板附近展示最近运行入口，只允许显示极简摘要和跳转/展开入口，例如：`最近运行：2026-xx-xx SH.688256 HOLD`；不得直接铺开 `roleReports`、Futu context、adapter warnings 或 raw final decision。
- Trading Agent 运行证据区域至少包含：
  - 当前 agentRunId / ticker / 状态。
  - 五个角色卡片：Market Analyst、Risk Analyst、Bull Researcher、Bear Researcher、Portfolio Manager。
  - 每个角色的结论、证据、风险、原始输出入口。
  - `marketDataContext` 数据质量。
  - `stockNewsContext` 数据质量。
  - `macroNewsContext` 风险等级与摘要。
  - 最终 `HOLD / BUY / SELL_TO_CLOSE` 裁决。
  - 被硬风控拦截或进入待确认订单的链路状态。
- 不允许把 Trading Agent 中间报告塞进候选池表格；候选池只服务 `candidate_pool` 模式。

Schema 要求：

- Trading Agent 最终输出必须是结构化 JSON。
- 第一版 required JSON 至少包含：
  - `ok: boolean`
  - `agentRunId: string`
  - `decisionMode: 'trading_agent'`
  - `action: HOLD | BUY | SELL_TO_CLOSE`
  - `approved: boolean`
  - `orderQuantity: number`
  - `limitPrice: number`
  - `confidence: string`
  - `marketReport: string`
  - `riskReport: string`
  - `bullCase: string`
  - `bearCase: string`
  - `finalReason: string`
  - `riskAssessment: string`
  - `whyNotNoise: string`
  - `tradeHorizon: string`
- A 股 schema 必须从类型层面禁止 `SELL_SHORT`，不能只靠 prompt 文案。

实现文件建议：

- 新增：
  - `api/ashare/aShareTradingAgentService.ts`
  - `api/ashare/aShareTradingAgentDataContextService.ts`
  - `api/ashare/aShareTradingAgentRunService.ts`
  - `api/ashare/aShareTradingAgentTypes.ts`
  - `api/futu_bridge/ashare_trading_agents_bridge.py`
  - `third_party/TradingAgents`
- 修改：
  - `api/ashare/aShareLiveTradingEngine.ts`
    - 在 `runOnce()` 中新增 `executionMode === 'trading_agent'` 分支。
  - `api/ashare/aShareRuntimeConfigService.ts`
    - 支持第三种 executionMode。
  - `api/trade_strategy/tradeStrategyConfigService.ts`
    - 允许 A 股 namespace 使用 `trading_agent`，但不要影响 Futu/Longbridge live 默认枚举。
  - `api/ashare/aShareOrderQueueService.ts`
    - 支持 `decisionMode: 'trading_agent'`。
  - `api/ashare/aSharePersistence.ts`
    - 支持保存 agent reports。
  - `src/pages/ashare/AshareLiveTradingView.tsx`
    - 展示第三种模式和 Trading Agent 策略说明面板。
    - 将 agent 中间报告、Futu context、warnings 和 final decision 放入历史信号展开态或 Agent Run 运行证据区，不注入策略说明面板。
  - `src/hooks/ashare/useAshareWorkbench.ts`
    - 保存/读取第三种模式配置。

后续落地顺序：

1. 新增 `agent_runs` 持久化结构，保存每次 Trading Agent 运行和每个角色评价。
2. A 股实盘页新增 Trading Agent 策略说明面板；面板只解释模式、角色、链路、数据输入和硬约束，不展示最近一次具体运行结果。
3. 新增 Trading Agent 运行证据展示入口；历史信号展开态或 Agent Run 详情负责展示 role reports、Futu context、warnings、final decision 和链路状态。
4. 新增 Futu / 宏观数据上下文聚合器：
   - Futu A 股行情。
   - Futu 个股新闻。
   - 股票池 universe 上下文。
   - `macroNewsContext` 国际宏观新闻快照。
   - 数据质量与缺失字段 warnings。
5. 修改 bridge / adapter，让 Trading Agent 使用本项目注入的数据上下文，绕开或替换上游默认 yfinance / Yahoo 数据路径。
6. 接入完整 A 股实盘 `runOnce` 链路：
   - `executionMode === 'trading_agent'`
   - 构造数据上下文。
   - 调用多角色 Agent。
   - 落库 `agent_runs`。
   - 写历史信号。
   - 非 HOLD 走硬风控。
   - 风控通过后进入待确认订单。
   - UI 展示完整链路。

验收标准：

- A 股页面可以在三种模式之间切换：
  - `legacy_direct`
  - `candidate_pool`
  - `trading_agent`
- 切到 `trading_agent` 后：
  - 非 HOLD 不进入候选池。
  - 最终 BUY / SELL_TO_CLOSE 通过硬风控后进入待确认订单。
  - 历史信号显示完整 agent 分析链。
  - 待确认订单来源显示 `Trading Agent 裁决`。
  - Trading Agent 策略说明面板只展示模式说明、角色职责、执行链路、数据输入和硬约束；不得展示最近一次运行的 `roleReports`、Futu context、adapter warnings 或 raw final decision。
  - 最近一次/历史某次运行结果只能出现在历史信号展开态、Agent Run 详情或明确命名的运行证据区域。
- 切回 `candidate_pool` 后：
  - 非 HOLD 仍按候选池逻辑进入组合裁决。
- 切回 `legacy_direct` 后：
  - 非 HOLD 仍按老逻辑直推。
- Futu 美港股和 Longbridge 页面、配置、候选池行为不受影响。

实验定位：

- `trading_agent` 是决策质量实验，不是下单权限升级。
- 第一版只用于 A 股模块验证多角色 Agent 是否能减少噪声和提升解释质量。
- 任何实盘提交仍必须经过当前 A 股硬风控和人工确认。

### 3.4 LLM 设置、策略版本、组合决策的排版必须对齐 Futu 实盘页

A 股三级实盘页的设置区不能自由重排。必须严格参考 `src/pages/LiveTradingView.tsx` 的现有顺序和视觉层级。

来源代码：

- `src/pages/LiveTradingView.tsx`
  - `LLM CONFIG / 大模型配置`
  - `GUARDRAILS / 实盘门禁`
  - `<TradeStrategyConfigPanel title="实盘策略与提示词版本" ... />`
  - `LiveCandidatePoolPanel`
- `src/components/trading/TradeStrategyConfigPanel.tsx`
  - 策略版本、提示词版本、保存按钮、组合策略模式侧栏的内部排版必须复用。

必须保持的垂直顺序：

1. Hero / 操作按钮 / 错误提示。
2. 自动下单开关卡片。
3. 指标卡区域。
4. `LLM CONFIG + GUARDRAILS` 同一行两列。
5. `策略与提示词版本` 独立整行。
6. `候选池与 DeepSeek 组合裁决` 独立整行。
7. 历史信号、待确认订单、实盘订单等列表区域。

`LLM CONFIG` 排版要求：

- 必须与 Futu 美港股实盘页一样放在 `LLM CONFIG + GUARDRAILS` 这一行的左侧。
- 该行外层 grid 必须保持类似 `xl:grid-cols-[1fr_0.9fr]` 的两列结构。
- LLM 卡片内部必须保持 Futu 老页面的横向表单节奏：
  - 第一列：模型选择。
  - 第二列：并发选择。
  - 第三列：开关/说明区域。
  - 第四列：保存按钮。
- 不能把 LLM 配置做成独立窄卡片，也不能和策略版本卡片并排塞进同一行。
- A 股没有美股夜盘，但仍必须保留同等位置的 A 股 Gate / 跳过说明区域，例如：
  - `仅连续竞价提交 LLM`
  - `午休/收盘/周末跳过`
  - 如暂不提供用户可切换开关，也应以禁用态或说明态占位，保持表单密度和列节奏一致。
- 保存按钮必须与 Futu 页一样位于表单行末尾，不允许放到卡片标题区或另起一行。

`GUARDRAILS` 排版要求：

- 必须与 `LLM CONFIG` 同行右侧显示。
- 内容结构参考 Futu 页的 `实盘门禁`：
  - 以 3 条左右的圆角提示行呈现。
  - A 股内容替换为：
    - `SELL_SHORT 不允许入队`
    - `只允许连续竞价时段评估与 RTH 订单`
    - `订单方向过滤只展示 ALL / BUY / SELL_TO_CLOSE`
- 不允许把 Guardrails 放到 LLM 配置下方或与待确认订单卡片混排。

`策略与提示词版本` 排版要求：

- 必须作为 `LLM CONFIG + GUARDRAILS` 后面的独立整行模块。
- 必须直接使用或视觉等价复用 `TradeStrategyConfigPanel`。
- `showPortfolioExecutionMode` 必须开启，让组合策略模式侧栏出现在该模块右侧。
- 模块内部结构必须保持：
  - 左侧大区：策略版本选择、提示词版本选择、保存策略版本按钮、策略摘要、提示词摘要、YAML details。
  - 右侧侧栏：组合策略模式说明、开启/关闭组合策略按钮、当前模式说明。
- 不允许把 `策略与提示词版本` 与 LLM 模型/并发配置并排。
- 不允许把组合策略开关拆出去放在 LLM 配置区。

`候选池与组合裁决` 排版要求：

- 必须作为 `策略与提示词版本` 后面的独立整行模块，位置与 Futu `LiveCandidatePoolPanel` 一致。
- 该模块负责展示：
  - 当前组合策略开启/关闭状态。
  - prompt label。
  - 当前 preset 名称。
  - 三个 timing preset 卡片。
  - active/inactive 筛选。
  - 候选池表格。
- 组合策略时间预设不允许做成策略版本卡片旁边的小卡片；必须放在候选池与组合裁决模块内部，以三张 preset 卡片横向展示。
- 关闭组合策略时，该模块仍保留位置，但内容为只读/折叠态，文案与 Futu 页一致表达“组合策略已关闭 · 老逻辑直推”。

A 股页面当前需要修正的反例：

- 不允许使用 `LLM 配置窄卡 + 策略版本大卡` 的并排布局。
- 不允许在策略版本卡片下面额外放一个独立 `组合策略时间预设` 小卡片。
- 不允许让待确认订单卡片出现在 `LLM CONFIG + GUARDRAILS` 这一行的右侧；右侧必须是 Guardrails。
- 不允许把候选池历史表提前到策略配置之前。
- 不允许让 A 股设置区的视觉层级与 Futu 美港股实盘页不同，导致用户找不到同类功能。

因此 A 股三级页修正目标是：

- 保留 A 股暖色调与 A 股专属文案。
- 但设置区的模块顺序、栅格结构、保存按钮位置、组合策略开关位置、preset 卡片位置，必须与 Futu 美港股实盘页保持一致。
- 只有交易规则内容可以因 A 股差异替换；排版结构不能变。

### 4. 原型使用说明

当前最新原型为：

- `/Users/ShockCao/AICoding/Financial/.trae/documents/a_share_workbench_prototype_v2.html`

该原型包含三段：

1. 一级平台选择页：
   - 基于现有 `PlatformSelectView` 同款卡片。
   - 继续保持一行两个卡片。
   - 第一行是 Futu / Longbridge，第二行新增第三张 `Futu A股量化工作台` 卡片。
2. A 股二级工作台：
   - 基于现有 Futu/Longbridge 工作台的两列模块组织。
3. A 股三级实盘页：
   - 基于现有 Futu REAL 页的 Hero、自动下单、指标卡、LLM 配置、候选池、待确认队列。

后续实现时，以 v2 原型为准；旧的 `a_share_workbench_prototype.html` 仅保留历史记录，不作为实现依据。

## Revised Current State Analysis

1. 一级入口当前只有 Futu 与 Longbridge 两张卡片：
   - 文件：`src/pages/PlatformSelectView.tsx`
   - 当前文案明确把现有工作台归入 Futu，把 Longbridge 作为独立平台。
   - 需要新增第三张 `A 股量化工作台` 卡片，且视觉应继续遵守暖色调和极简色板，不再使用新的蓝紫主色。

2. Futu 工作台当前路径为 `/futu`：
   - 文件：`src/pages/Dashboard.tsx`
   - 提供账户、持仓、风险、研究、报告、实盘、模拟盘等入口。
   - A 股工作台应参考这个信息密度和入口结构，但不能混入 Futu 现有股票池和实盘页。

3. Longbridge 工作台当前路径为 `/longbridge`：
   - 文件：`src/pages/LongbridgeWorkbenchPlaceholder.tsx`
   - 采用独立平台结构，展示账户、持仓、风险、数据源、研究、报告、自选、实盘量化等模块。
   - A 股工作台可以参考这种“独立平台工作台”的组织方式，但视觉要回到全站暖色调体系。

4. 全局导航当前 `AppNav` 强绑定 Futu：
   - 文件：`src/components/common/AppNav.tsx`
   - Futu 页面用 `AppNav`，Longbridge 用 `LongbridgeWorkbenchNav`。
   - A 股需要独立导航，例如 `AshareWorkbenchNav`，避免进入后仍显示 Futu 品牌。

5. 底层 Futu code 有部分基础能力：
   - `api/futu_bridge/futu_common.py` 的 `futu_code()` 已允许 `SH.` / `SZ.` 原样透传。
   - 当前裸 6 位数字不会正确识别为 A 股，仍需通过 Futu 查询接口校验真实代码。

6. 当前 Futu 实时订阅技术上可传入 `SH.` / `SZ.`：
   - 文件：`api/futu_bridge/futu_realtime_subscribe.py`
   - 订阅类型包含 `QUOTE` / `TICKER` / `K_1M` / `ORDER_BOOK`。
   - 但当前时区只区分 HK 和 US，A 股会误用纽约时间。

7. 当前股票池和交易规则是 Futu/Longbridge 共用静态池：
   - 文件：`api/simulation/simulationUniverse.ts`
   - 当前只包含 US/HK。
   - A 股工作台需要独立股票池服务，不能直接污染现有 Futu/Longbridge LLM 股票池。

8. 当前 Futu 下单桥尚未完整支持 A 股：
   - 文件：`api/futu_bridge/futu_live_order.py`
   - `trade_market_for_code()` 只识别 HK，否则落到 US；`SH.` / `SZ.` 会走错交易市场。

## Revised Proposed Changes

### 1. 一级平台选择页新增 A 股入口

文件：`src/pages/PlatformSelectView.tsx`

改动：
- 平台卡片布局继续沿用当前 `lg:grid-cols-2` 的一行两个卡片逻辑：
  - 大屏：两列，不使用三列。
  - 第一行：Futu / Longbridge。
  - 第二行：A 股卡片自然落到下一行，保持同款宽度和卡片结构。
  - 小屏：单列。
- 新增 `aShare` 文案块：
  - 标题：`A 股量化工作台`
  - 状态：`规划接入`
  - 描述：`面向沪深 A 股的独立 LLM 股票池、行情订阅、策略评估和多头风控工作区。`
  - 能力点：`Futu OpenD A股查询`、`SH/SZ 行情订阅`、`独立股票池`、`只多头风控`、`午休/收盘 Gate`、`候选池`
  - CTA：`进入 A 股工作台`
  - 路由：`/a-share`
- 视觉：
  - 继续使用暖米背景、白卡片、炭灰文字、金橙主色、玫瑰风险色。
  - 不新增蓝紫/青色作为 A 股主色，避免破坏全站暖色调一致性。

### 2. 新增 A 股工作台路由与页面

文件：
- `src/App.tsx`
- 新文件：`src/pages/AshareWorkbenchView.tsx`

路由：
- `/a-share` -> `AshareWorkbenchView`
- 后续二级页可预留：
  - `/a-share/live-trading`
  - `/a-share/reports`
  - `/a-share/stocks/:ticker`

首版页面结构参考 Futu 和 Longbridge 工作台：
- 顶部导航：返回平台选择、进入 Futu、进入 Longbridge、语言切换。
- Hero 区：`A 股量化工作台`、状态 Badge、刷新/启动按钮占位。
- 左列：
  - `A 股查询与订阅`
  - `A 股股票池`
  - `行情状态`
  - `市场时段`
- 右列：
  - `策略评估`
  - `候选池`
  - `待确认订单`
  - `风险与规则`

原因：
- 用户明确要求一级入口独立，并且进入 A 股工作台后继续参考现有两个量化工作台的功能入口和 UI 设计。

### 3. 新增 A 股工作台导航

新文件：`src/components/ashare/AshareWorkbenchNav.tsx`

导航项：
- `工作台` -> `/a-share`
- `查询订阅` -> `/a-share#lookup`
- `股票池` -> `/a-share#universe`
- `行情` -> `/a-share#market-data`
- `策略评估` -> `/a-share#strategy`
- `候选池` -> `/a-share#candidate-pool`
- `风控规则` -> `/a-share#risk`

原因：
- 避免复用 Futu `AppNav` 后品牌和锚点都指向 Futu。

### 4. 新增 A 股查询与订阅组件

新文件：`src/components/ashare/AshareInstrumentLookupPanel.tsx`

UI：
- 输入框：`输入 A 股代码，如 SH.600519 / SZ.000001 / 600519`
- 主按钮：`查询 Futu 真实代码`
- 查询结果列表字段：
  - 股票名称
  - Futu code
  - 交易所
  - 币种
  - 资产类型
  - 行情状态
  - `+ 订阅进 A 股股票池`
- 多候选时展示所有候选，让用户点击选择，不自动推断。

交互：
- 查询调用 `POST /api/a-share/instruments/lookup`
- 点击 `+` 调用 `POST /api/a-share/universe`
- 成功后刷新 A 股工作台 dashboard。

### 5. 新增 A 股后端路由，不挂在 Futu live-trading 下

新文件：`api/routes/aShareRoutes.ts`

文件：`api/app.ts`

新增：
- `app.use('/api/a-share', aShareRoutes)`

接口：
- `GET /api/a-share/dashboard`
  - 返回 A 股工作台状态、股票池、订阅状态、最近信号、候选池、规则摘要。
- `POST /api/a-share/instruments/lookup`
  - 调用 Futu OpenD 查询真实 A 股代码。
- `POST /api/a-share/universe`
  - 将查询结果加入 A 股独立股票池。
- `DELETE /api/a-share/universe/:ticker`
  - 从 A 股股票池移除。
- `POST /api/a-share/start`
  - 启动 A 股行情订阅和 LLM 评估。
- `POST /api/a-share/stop`
  - 停止 A 股评估。
- `POST /api/a-share/run-once`
  - 单轮评估。

原因：
- A 股工作台是一级独立入口，API 也应独立，避免和 Futu live-trading 语义混在一起。

### 6. 新增 A 股独立股票池服务

新文件：`api/ashare/aShareUniverseService.ts`

职责：
- 维护 A 股动态股票池。
- 持久化到 `.data/a-share-universe.json`。
- 主键使用完整 `ticker`：
  - `SH.600519`
  - `SZ.000001`
- 每个 item 包含：
  - `ticker`
  - `label`
  - `assetType`
  - `market: 'CN'`
  - `exchange: 'SH' | 'SZ'`
  - `futuCode`
  - `tradingCurrency: 'CNY'`

原因：
- 避免污染现有 `LLM_SIMULATION_UNIVERSE`。
- 避免沪深同号冲突。

### 7. 新增 A 股行情订阅服务适配层

新文件：`api/ashare/aShareRealtimeService.ts`

职责：
- 复用 Futu Python 订阅能力，但使用 A 股独立股票池。
- 当用户新增股票池后，如 A 股引擎运行中，重启或更新订阅列表。
- 读取 `realtimeStore` 或新增 A 股专用 store 的快照。

实施选择：
- 第一版可复用现有 `realtimeSubscriptionService`，但必须确保订阅 tickers 不与 Futu US/HK 工作台互相覆盖。
- 更稳妥方案：新增独立 `AshareRealtimeSubscriptionService`，内部仍调用 `futu_realtime_subscribe.py`，但维护自己的子进程和 ticker 列表。

推荐：
- 使用独立 `AshareRealtimeSubscriptionService`。

原因：
- 用户要求 A 股入口和现有两个量化工作台独立。
- 独立订阅服务可以避免 A 股启动/停止影响现有 Futu 实盘引擎。

### 8. 修正 Futu Python 桥对 A 股的基础支持

文件：
- `api/futu_bridge/futu_common.py`
- `api/futu_bridge/futu_realtime_subscribe.py`
- 新文件：`api/futu_bridge/futu_instrument_lookup.py`

改动：
- `futu_instrument_lookup.py` 调用 Futu OpenD 查询真实 A 股证券信息。
- `now_for_futu_code()` 增加 `SH.` / `SZ.` -> `Asia/Shanghai`。
- A 股历史 K 线窗口按中国交易日处理，早盘不足 120 根时允许回补前一交易日数据用于 LLM 窗口。
- `futu_code()` 对动态 A 股路径必须使用已确认的 `futuCode`，不要把裸 6 位代码猜成 US。

### 9. 新增 A 股市场时段 Gate

新文件：`api/ashare/aShareMarketSessionGate.ts`

规则：
- 交易日连续竞价：
  - 09:30-11:30
  - 13:00-15:00
- 午休、收盘、周末：跳过 LLM。
- 集合竞价第一版不评估。

输出：
- `shouldSkipAshareLlm({ ticker, marketState, now })`
- `aShareLlmSkippedReason(...)`

原因：
- A 股无盘前/盘后/夜盘。
- 不应继续放到 `usOvernightLlmGate.ts` 中扩大语义混乱。

### 10. 新增 A 股 LLM 实盘引擎

新文件：`api/ashare/aShareLiveTradingEngine.ts`

参考：
- `api/live/liveTradingEngine.ts`
- `api/longbridge/longbridgeLiveTradingEngine.ts`

第一版能力：
- Dashboard
- start/stop/runOnce
- 读取 A 股股票池
- 确保行情订阅
- 加载 120 根 1m K线 + tickerPoints + 盘口
- 调用 A 股专用 prompt 构建
- 生成信号
- 进入候选池或待确认队列
- 只多头风控

明确不做：
- A 股卖空。
- A 股盘前/盘后。
- 融资融券专项策略。
- 与 Futu 美股/港股股票池共用候选池。

### 11. 新增 A 股 LLM Prompt 服务

新文件：`api/ashare/aShareLiveDecisionService.ts`

要求：
- prompt 文案明确为 `A 股多头量化交易研究员`。
- `action` 只允许：
  - `HOLD`
  - `BUY`
  - `SELL_TO_CLOSE`
- 禁止 `SELL_SHORT`。
- 使用 `CNY` 口径。
- 明确 A 股 T+1、涨跌停、午休和流动性风险。
- `marketData` 仍包含：
  - `recentKlineBars`
  - `recentTickerPoints`
  - `asks`
  - `bids`

### 12. A 股下单桥适配

文件：
- `api/futu_bridge/futu_live_order.py`

改动：
- `trade_market_for_code()` 支持 `SH.` / `SZ.`，实施前用本地 SDK introspection 确认 Futu 常量。
- A 股订单：
  - 只允许 `RTH`
  - 禁止 `SELL_SHORT`
  - `fill_outside_rth=False`
  - 订单类型第一版使用 `MARKETABLE_LIMIT`
- Node 层在调用前先做硬风控，Python 桥再二次防线。

### 13. 前端原型稿

> 这是一版用于评审的信息架构原型，正式实现时按现有 React/Tailwind 组件落地。

#### 一级平台选择页

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ 量化交易工作台                                    平台选择      切换英文      │
├──────────────────────────────────────────────────────────────────────────────┤
│ 平台选择                                                                     │
│ 选择交易市场，进入对应量化工作区                                             │
│ 账户、行情、策略、风控和候选池按平台隔离。                                   │
│                                                                              │
│ ┌────────────────────┐ ┌────────────────────┐ ┌────────────────────┐        │
│ │ Futu 量化交易工作台 │ │ Longbridge 工作台   │ │ A 股量化工作台      │        │
│ │ 已接入              │ │ 已接入              │ │ 规划接入            │        │
│ │ 账户资产/持仓       │ │ 长桥账户/订单       │ │ SH/SZ 查询订阅       │        │
│ │ Futu OpenD 行情     │ │ 独立行情适配        │ │ 独立 A 股股票池      │        │
│ │ 实盘/模拟盘         │ │ 实盘量化            │ │ 只多头风控           │        │
│ │ [进入 Futu]         │ │ [进入 Longbridge]    │ │ [进入 A 股工作台]    │        │
│ └────────────────────┘ └────────────────────┘ └────────────────────┘        │
└──────────────────────────────────────────────────────────────────────────────┘
```

#### A 股工作台首屏

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ 返回平台选择        进入 Futu        进入 Longbridge             切换英文     │
├──────────────────────────────────────────────────────────────────────────────┤
│ A 股量化工作台                                                               │
│ 沪深 A 股 · Futu OpenD · 独立股票池 · 只多头策略                              │
│ [刷新] [启动 A 股评估] [停止] [单轮评估]                                      │
│                                                                              │
│ ┌──────────────────────────────┐ ┌──────────────────────────────┐            │
│ │ A 股查询与订阅                │ │ 策略评估状态                  │            │
│ │ 输入: SH.600519              │ │ 引擎: stopped/running         │            │
│ │ [查询 Futu 真实代码]          │ │ 并发: 1 / N                   │            │
│ │ 结果: 贵州茅台 SH.600519      │ │ 窗口: 120 x 1m + tickerPoints │            │
│ │ [ + 订阅进 A 股股票池 ]       │ │ Gate: 午休/收盘自动跳过       │            │
│ └──────────────────────────────┘ └──────────────────────────────┘            │
│                                                                              │
│ ┌──────────────────────────────┐ ┌──────────────────────────────┐            │
│ │ A 股股票池                    │ │ 风控规则                      │            │
│ │ SH.600519 贵州茅台             │ │ 禁止卖空                      │            │
│ │ SZ.000001 平安银行             │ │ 仅 RTH                        │            │
│ │ 行情/盘口/逐笔状态             │ │ CNY 口径                      │            │
│ │ [移除] [查看行情]              │ │ T+1 / 涨跌停提示              │            │
│ └──────────────────────────────┘ └──────────────────────────────┘            │
│                                                                              │
│ ┌──────────────────────────────┐ ┌──────────────────────────────┐            │
│ │ 候选池                        │ │ 待确认订单                    │            │
│ │ BUY / SELL_TO_CLOSE / HOLD    │ │ 人工确认后提交 Futu REAL      │            │
│ │ 组合裁决理由                  │ │ 自动下单也受 A 股硬风控       │            │
│ └──────────────────────────────┘ └──────────────────────────────┘            │
└──────────────────────────────────────────────────────────────────────────────┘
```

#### A 股查询结果交互

```text
输入 600519
  ↓
后端调用 Futu 查询
  ↓
若只返回一个候选：
  贵州茅台 | SH.600519 | 上海证券交易所 | CNY | STOCK | [+ 订阅进股票池]
  ↓
点击 +
  ↓
写入 .data/a-share-universe.json
  ↓
若 A 股引擎运行中，刷新 A 股订阅列表
  ↓
dashboard 显示 SH.600519 已订阅，等待 quote/ticker/kline/orderBook 就绪

若返回多个候选：
  展示候选列表，不自动加入，用户选择其中一个。
```

## Revised Verification Steps

1. 文档/原型评审：
   - 确认一级入口三卡片信息架构。
   - 确认 A 股工作台首屏模块顺序。
   - 确认 A 股不混入 Futu `/futu` 和 Longbridge `/longbridge`。

2. 实现后静态检查：
   - `npm run check`

3. 前端路由验证：
   - `/` 显示 Futu / Longbridge / A 股三入口。
   - `/a-share` 显示 A 股独立工作台。
   - `/futu` 与 `/longbridge` 不受影响。

4. 后端 API 验证：
   - `POST /api/a-share/instruments/lookup`
   - `POST /api/a-share/universe`
   - `GET /api/a-share/dashboard`

5. 行情验证：
   - 查询并订阅 `SH.600519` 或 `SZ.000001`。
   - quote、tickerPoints、1m K线、orderBook 就绪后，A 股 LLM 请求能收到这些字段。

6. 风控验证：
   - A 股 `SELL_SHORT` 被拦截。
   - 午休/收盘跳过 LLM。
   - RTH 下 `BUY` 和已有多头 `SELL_TO_CLOSE` 可进入候选池或待确认队列。

---

以下为上一版方案的历史记录，已被上方 `Revised` 方案替代；实施时以上方修订版为准。

## Summary

目标是在 Futu 工作台内新增 A 股查询与订阅入口：用户手动输入 `SH` / `SZ` 股票编码，后端调用 Futu OpenD 校验并返回真实订阅代码；用户点击 `+` 后，该标的加入当前 Futu LLM 股票池，并参与行情订阅、数据缓存、LLM 评估、候选池和人工确认流程。

第一版交易边界固定为 A 股只做多头交易：允许 `BUY` 和已有多头的 `SELL_TO_CLOSE`，禁止 `SELL_SHORT`。范围限定在 Futu 平台，不改 Longbridge 实盘逻辑。

## Current State Analysis

1. Futu 底层代码格式已有部分 A 股基础能力：
   - `api/futu_bridge/futu_common.py` 的 `futu_code()` 已允许 `US.` / `HK.` / `SH.` / `SZ.` 前缀原样透传。
   - 但未前缀的 6 位数字不会自动识别为 A 股，目前只有 5 位数字会被识别为港股 `HK.xxxxx`，其他默认进入 `US.`。

2. Futu 实时订阅当前订阅内容包含：
   - `SubType.QUOTE`
   - `SubType.TICKER`
   - `SubType.K_1M`
   - `SubType.ORDER_BOOK`
   这些订阅在技术上可以传入 `SH.` / `SZ.` 代码，但当前 `now_for_futu_code()` 只区分港股与美股，A 股会错误使用 `America/New_York`。

3. 当前 LLM 股票池是静态数组：
   - 文件：`api/simulation/simulationUniverse.ts`
   - 目前只包含美股和港股，`SimulationUniverseItem.market` 类型只支持 `'US' | 'HK'`。
   - `llmSimulationTickers()`、`isInLlmSimulationUniverse()`、`llmUniverseItem()` 都直接基于这个静态数组。

4. 当前市场状态 fallback 偏 US/HK：
   - `api/simulation/marketSessionService.ts` 的 `fallbackFutuCode()` 只识别 5 位港股，其他默认 `US.`。
   - `api/simulation/usOvernightLlmGate.ts` 只处理美股夜盘跳过和特定港股收盘跳过；没有 A 股午休/休市 gate。

5. 当前 Futu 下单桥尚未正确支持 A 股：
   - `api/futu_bridge/futu_live_order.py` 和 `api/futu_bridge/futu_sim_order.py` 的 `trade_market_for_code()` 只识别 `HK.`，其他全部落到 `TrdMarket.US`。
   - 这会导致 `SH.` / `SZ.` 下单走错交易市场。
   - 订单校验允许 `SH.` / `SZ.` 前缀，但没有 A 股只多头、RTH-only、币种和市场时段规则。

6. 当前 LLM prompt 交易币种规则写死为 US/HK：
   - `api/live/liveTradingDecisionService.ts` 的 `tradingCurrencyContext.rule` 只说明 US 使用 USD、HK 使用 HKD。
   - A 股应使用 CNY 口径，并明确 A 股不允许卖空。

7. 前端 Futu 实盘页面已有统一数据管理入口：
   - `src/hooks/useLiveTrading.ts` 负责 Futu dashboard、history、settings、订单确认等请求。
   - `src/pages/LiveTradingView.tsx` 是 Futu REAL 页面，适合增加 A 股查询/订阅卡片。

## Proposed Changes

### 1. 扩展共享类型，显式支持 A 股市场

文件：`shared/types.ts`

变更：
- 将 `SimulationUniverseItem.market` 从 `'US' | 'HK'` 扩展为 `'US' | 'HK' | 'CN'`。
- 如需要更细粒度展示，可新增 `exchange?: 'SH' | 'SZ'`。
- 新增 A 股查询结果类型，例如：
  - `FutuInstrumentLookupRequest`
  - `FutuInstrumentLookupResult`
  - `FutuUniverseSubscriptionRequest`
  - `FutuUniverseSubscriptionResponse`

原因：
- 避免用裸字符串在前后端之间传递 A 股市场信息。
- 给后续行情、时段、币种、交易动作约束提供统一判断依据。

### 2. 新增动态 Futu LLM 股票池服务

新文件：`api/simulation/futuDynamicUniverseService.ts`

职责：
- 组合静态股票池 `LLM_SIMULATION_UNIVERSE` 和用户动态添加的 Futu 标的。
- 提供：
  - `getFutuLlmUniverse()`
  - `futuLlmTickers()`
  - `addFutuUniverseItem(item)`
  - `removeFutuUniverseItem(ticker)`（第一版 UI 可不暴露，但服务保留能力）
  - `findFutuUniverseItem(ticker)`

持久化：
- 第一版使用本地 JSON 文件，例如 `.data/futu-dynamic-universe.json`。
- 写入内容只保存用户添加的动态标的，不改静态股票池。
- 读取失败时返回空动态列表，不阻塞已有 US/HK 逻辑。

原因：
- 用户要求点击 `+` 后“订阅进股票池”，这不适合继续写死在 `simulationUniverse.ts`。
- 动态股票池能避免每次添加 A 股都改代码。

### 3. 调整现有股票池访问函数为合并视图

文件：`api/simulation/simulationUniverse.ts`

变更：
- 保留 `LLM_SIMULATION_UNIVERSE` 作为基础静态池。
- 将 `llmSimulationTickers()`、`isInLlmSimulationUniverse()`、`llmUniverseItem()` 改为读取静态池 + 动态池合并结果。
- 若为避免循环依赖，可将静态常量迁移为 `BASE_LLM_SIMULATION_UNIVERSE`，动态服务导出合并后的同步方法。

原因：
- Futu live engine、simulation engine、runtime config、candidate pool 当前都依赖这些函数。
- 改合并视图后，现有调用方自动获得 A 股动态标的，无需大范围改调用链。

### 4. 新增 Futu A 股查询桥

新文件：`api/futu_bridge/futu_instrument_lookup.py`

输入：
- `query`: 用户输入，如 `600519`、`SH.600519`、`SZ.000001`。

处理：
- 规范化输入：
  - `SH.xxxxxx` / `SZ.xxxxxx` 直接使用。
  - 裸 6 位数字不自动猜交易所；优先调用 Futu 接口查询候选，若两边都有匹配则返回多个候选让前端选择。
- 调用 Futu OpenD 查询真实证券信息。优先使用 Futu SDK 的股票基础信息能力；若 SDK 接口返回字段差异，桥层统一归一化为：
  - `ticker`
  - `futuCode`
  - `name`
  - `market: 'CN'`
  - `exchange: 'SH' | 'SZ'`
  - `tradingCurrency: 'CNY'`
  - `assetType: 'STOCK' | 'ETF'`

失败模式：
- Futu OpenD 不可用：返回明确错误。
- 未查到：返回空候选和用户可读原因。
- 多候选：返回候选列表，不自动加入股票池。

原因：
- 用户明确要求“查询需要查到真实订阅代码，可能需要调用 futu 接口”。
- 不应靠正则猜测 A 股真实代码。

### 5. 新增 Futu 股票池 API

文件：`api/routes/liveTradingRoutes.ts`

新增接口：
- `POST /api/live-trading/futu-instruments/lookup`
  - body: `{ "query": "SH.600519" }`
  - 返回 Futu 查询候选。
- `POST /api/live-trading/universe`
  - body: 查询结果中的标准化 item。
  - 写入动态股票池。
  - 如果 Futu 实盘引擎正在运行，调用 `realtimeSubscriptionService.start(llmSimulationTickers())` 让新增标的进入订阅。
  - 返回更新后的 dashboard 或 universe。
- 可选：`DELETE /api/live-trading/universe/:ticker`
  - 第一版可以后置；计划中保留接口设计，UI 可先不做删除。

原因：
- 前端不直接拼 Futu code，统一由后端校验和持久化。

### 6. 修正 Futu code 与市场识别

文件：`api/futu_bridge/futu_common.py`

变更：
- `futu_code()` 保持 `SH.` / `SZ.` 原样透传。
- 裸 6 位数字不要默认映射到 `US.`；对于下单/订阅前来自动态股票池的标的，应使用保存的 `futuCode`。
- `ticker_from_futu_code()` 可保持现状，但上层需要避免 `SH.600519` 和 `SZ.600519` 被都简化成 `600519` 后冲突；动态服务中 ticker 建议统一保存为 `SH.600519` / `SZ.000001`。

文件：`api/simulation/marketSessionService.ts`

变更：
- `fallbackFutuCode()` 支持 `SH.` / `SZ.` 原样返回。
- 对动态股票池项优先使用 `item.futuCode`。

原因：
- A 股有 6 位数字且沪深可能冲突，不能用裸代码作为唯一标识。

### 7. 修正 Futu 实时订阅的 A 股时区与历史 K 线窗口

文件：`api/futu_bridge/futu_realtime_subscribe.py`

变更：
- `now_for_futu_code()` 增加：
  - `SH.` / `SZ.` -> `Asia/Shanghai`
- `history_start_for_market_state()` 对 A 股使用中国交易日逻辑，默认取当天，早盘 K 线不足时可向前回补 3 天以满足 120 根窗口。
- 保留当前订阅类型 `QUOTE` / `TICKER` / `K_1M` / `ORDER_BOOK`，不要改变 US/HK 行为。

原因：
- 当前 A 股会按纽约时间处理 K 线日期，导致开盘时窗口过滤和日期截取错误。

### 8. 新增 A 股市场时段 gate

文件：`api/simulation/usOvernightLlmGate.ts`

变更：
- 更名可选：保留文件名以减少改动，但内部新增 CN gate。
- 新增 `shouldSkipChinaClosedLlm()`：
  - A 股交易时段：`09:30-11:30`、`13:00-15:00` Asia/Shanghai。
  - 集合竞价是否评估第一版不启用，默认等到连续竞价。
  - 午休、未开盘、收盘、周末跳过 LLM。
- `llmMarketSessionSkipReason()` 增加 A 股判断，返回中文原因，例如“ A 股非连续竞价时段，本轮不评估 SH.600519”。

原因：
- A 股没有美股夜盘/盘前盘后，不能复用 US/HK gate。
- 避免休市时消耗 LLM 并生成不可交易信号。

### 9. 修正 Futu 下单桥的 A 股交易市场与交易规则

文件：
- `api/futu_bridge/futu_live_order.py`
- `api/futu_bridge/futu_sim_order.py`

变更：
- `trade_market_for_code()` 增加：
  - `SH.` / `SZ.` -> 对应 Futu `TrdMarket.CN` 或 SDK 实际常量；实现前需用本地 SDK introspection 验证常量名。
- 校验规则增加：
  - A 股只允许 `RTH`。
  - A 股禁止 `SELL_SHORT`。
  - A 股 `SELL_TO_CLOSE` 只能卖出已有多头，这一层若拿不到持仓，至少拒绝 `SELL_SHORT`，持仓校验由 Node 风控层完成。
  - A 股不允许 ETH / OVERNIGHT。
- `fill_outside_rth` 对 A 股固定 `False`。

原因：
- 当前 `SH.` / `SZ.` 会错误走 `TrdMarket.US`。
- A 股第一版必须明确只多头，不能把现有卖空能力带过去。

### 10. Node 风控与订单意图增加 A 股约束

文件：`api/live/liveTradingEngine.ts`

变更：
- 新增市场判断工具：
  - `isChinaInstrument(ticker, marketSession?)`
  - `marketForTicker()` 或复用 `llmUniverseItem(ticker)?.market`
- `buildOrderIntent()` 中：
  - 如果 A 股且 `decision.action === 'SELL_SHORT'`，直接拦截并记录 `BLOCKED_BY_RISK`。
  - 如果 A 股且非 `RTH`，不生成可提交订单。
  - A 股 `orderSession` 固定 `RTH`。
- `selectOrderTypeForDecision()` 对 A 股默认使用 `MARKETABLE_LIMIT`，不使用扩展时段逻辑。
- `marketableLimitPrice()` 可先复用现有买卖盘/lastPrice 逻辑；不引入涨跌停价格保护，除非 Futu quote 后续能稳定返回涨跌停字段。

原因：
- 即使 LLM 错误返回 `SELL_SHORT`，后端也必须硬拦截。

### 11. 更新 LLM prompt 的市场与币种规则

文件：`api/live/liveTradingDecisionService.ts`

变更：
- `system` 文案从“美股正股/ETF”改为覆盖 Futu 多市场，但明确每个市场按 `targetInstrument.market` 处理。
- `tradingCurrencyContext.rule` 增加：
  - CN 标的使用 CNY。
  - CN 标的只允许多头交易，不得 SELL_SHORT。
  - CN 标的无盘前/盘后/夜盘。
- `actionSemantics.SELL_SHORT` 增加“CN 标的禁止卖空”。

原因：
- LLM 不能继续把 A 股按 US/HK 解释。

### 12. 前端新增 A 股查询/订阅组件

文件：
- `src/hooks/useLiveTrading.ts`
- `src/pages/LiveTradingView.tsx`
- 可选新组件：`src/components/trading/FutuInstrumentLookupPanel.tsx`

UI 设计：
- 在 Futu REAL 页面顶部控制区或配置区新增一张暖色调卡片。
- 输入框 placeholder：`输入 A 股代码，如 SH.600519 / SZ.000001`
- 按钮：
  - `查询`
  - 查询结果每行显示：名称、真实 Futu code、交易所、币种、资产类型、`+ 订阅进股票池`
- 点击 `+` 后：
  - 调用 `POST /api/live-trading/universe`
  - 更新 dashboard/universe。
  - 如果引擎运行中，显示“已加入股票池并触发行情订阅更新”。

约束：
- UI 保持当前暖色调，不引入新的蓝/紫/绿主色。
- 不影响 Longbridge 页面。

### 13. 测试计划

新增或更新测试：

1. `tests/futuAshareUniverse.test.ts`
   - `SH.600519` / `SZ.000001` 可加入动态股票池。
   - 合并股票池包含静态 US/HK + 动态 CN。
   - 重复添加同一 `futuCode` 不产生重复项。
   - `llmSimulationTickers()` 返回动态项。

2. `tests/futuOpenDProvider.test.ts` 或新增桥层测试
   - `futu_code('SH.600519') === 'SH.600519'`
   - `futu_code('SZ.000001') === 'SZ.000001'`
   - 裸 6 位数字不会被错误映射为 `US.600519` 用于动态订阅路径。

3. `tests/liveTrading.test.ts`
   - A 股 `SELL_SHORT` 被后端风控拒绝。
   - A 股休市/午休 gate 跳过 LLM。
   - A 股 RTH 时允许 `BUY` 和已有多头 `SELL_TO_CLOSE` 进入候选池/待确认。

4. `tests/llmAutonomousTrading.test.ts`
   - LLM prompt 中 CN 标的包含 CNY 与禁止卖空规则。
   - `recentTickerPoints`、`recentKlineBars` 对 CN 标的仍送入 prompt。

5. 可选手工验证：
   - Futu OpenD 开启后，调用 lookup 接口查询一个沪市与一个深市标的。
   - 点击 `+` 后，`/api/realtime/status` 能看到新增订阅。
   - 在非 A 股交易时段，run-once 对该标的给出跳过原因。

## Assumptions & Decisions

1. A 股第一版只接入 Futu 平台，不接入 Longbridge。
2. A 股第一版不预置静态股票池，由用户通过查询入口手动添加。
3. 动态添加的 A 股 ticker 使用完整代码作为主键，例如 `SH.600519`、`SZ.000001`，避免沪深 6 位数字冲突。
4. A 股交易币种为 `CNY`。
5. A 股第一版只允许多头交易：`BUY` 与已有多头 `SELL_TO_CLOSE`；禁止 `SELL_SHORT`。
6. A 股第一版只在连续竞价时段评估与交易；午休、收盘、周末跳过 LLM。
7. 自动下单开关即使开启，A 股仍受同一后端硬风控约束；任何 `SELL_SHORT` 或非 RTH 订单都不会提交。
8. 若 Futu SDK 的 A 股交易市场常量不是 `TrdMarket.CN`，实施时必须先用只读 introspection 确认本地 SDK 常量名，再落代码。

## Verification Steps

1. 静态检查：
   - `npm run check`

2. 单元测试：
   - `npx vitest run tests/futuAshareUniverse.test.ts`
   - `npx vitest run tests/liveTrading.test.ts tests/llmAutonomousTrading.test.ts tests/llmRuntimeConfig.test.ts`

3. Futu OpenD 联调：
   - 查询 `SH.600519`，确认返回真实 `futuCode`、名称、交易所和 CNY。
   - 查询 `SZ.000001`，确认返回真实 `futuCode`、名称、交易所和 CNY。
   - 点击订阅后确认 dashboard universe 包含该标的。
   - 启动 Futu 实盘评估后确认订阅服务包含新增 A 股。

4. 行情验证：
   - `/api/realtime/SH.600519` 或标准化后的路由能返回 quote、tickerPoints、klineBars、orderBook。
   - LLM 请求日志中能看到 A 股 `recentTickerPoints` 和 `recentKlineBars`。

5. 风控验证：
   - 构造 LLM 返回 `SELL_SHORT`，确认后端拦截。
   - 在 A 股午休/收盘时运行单轮评估，确认跳过且 UI 显示原因。
   - 在 RTH 且行情充足时，`BUY` 能进入候选池或待确认队列。
