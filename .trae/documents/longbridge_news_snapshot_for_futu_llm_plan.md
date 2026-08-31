# Longbridge 新闻快照接入跨平台 LLM 决策设计确认稿

## 目标

为 Futu 实盘、Futu 模拟盘和 Longbridge 实盘的大模型交易决策增加“宏观/地缘政治新闻风险上下文”，但避免在每个 ticker 的 LLM 并发决策中重复调用 Longbridge CLI。

核心原则：

* Longbridge 新闻搜索每轮评估只调用一次，生成本轮共享快照。

* 同一轮 Futu 实盘、Futu 模拟盘或 Longbridge 实盘内，所有 ticker 的 LLM prompt 使用同一份新闻快照。

* Futu 仍只负责账户、持仓、订单、实时行情、K 线、摆盘和交易执行。

* Longbridge 在 Futu 工作台中只作为新闻/宏观风险数据源，不混入 Futu 账户和订单逻辑。

* Longbridge 实盘也使用同一份新闻快照，并继续使用 Longbridge 自己的账户、持仓、行情、订单和风控数据源。

* 新闻信息只作为风险上下文，不允许大模型仅凭单条新闻直接下单。

## 背景约束

当前项目中 Futu OpenD 已接入：

* 账户资产和持仓

* 实盘/模拟盘订单查询与提交

* 实时报价、分时、K 线、摆盘回调

* 历史 K 线

* 交易时段和费用相关能力

当前项目中 Futu 未接入：

* 按关键词搜索新闻

* 宏观/地缘政治资讯流

* 新闻详情抓取

* 对特朗普、伊朗、伊朗革命卫队、以色列、黎巴嫩等关键词的自动追踪

因此新闻搜索统一通过 Longbridge CLI 完成。Longbridge CLI 调用必须受到并发保护，不能随 LLM ticker 并发一起放大。

## 总体架构

本设计新增一个独立的“新闻风险快照”流程：

```text
Futu 实盘 / Futu 模拟盘 / Longbridge 实盘 runOnce 开始
  -> 读取账户快照
  -> 读取市场时段
  -> 拉取 Longbridge 新闻快照（每轮一次）
  -> 并发评估各 ticker
       -> 每个 ticker 读取对应平台行情/K线/摆盘
       -> 每个 ticker prompt 附带同一份新闻快照
       -> LLM 输出单标的交易建议
  -> 后端硬风控 / 候选池组合裁决 / 人工确认
```

新闻快照与账户数据类似，是本轮固定上下文。它不是每个 ticker 的实时查询能力。

## 数据源与调用方式

使用本地 Longbridge CLI：

```bash
HOME=.tools/longbridge-home .tools/longbridge/longbridge news search "<query>" --count <N> --format json --lang zh-CN
```

必须使用 `.tools/longbridge-home` 作为 `HOME`，与项目 Longbridge 适配器授权目录保持一致。

首期建议关键词分组：

* `Iran United States Israel Lebanon market`

* `Trump Iran Revolutionary Guard Israel Lebanon`

* `Middle East oil market risk`

* `Israel Lebanon Iran US stocks`

首期不建议为每个股票单独搜索新闻。宏观地缘政治风险应作为“全局风险快照”，不是单票新闻流。

## 调用频率与缓存策略

建议新增 `macroNewsSnapshotService`，提供：

```ts
getMacroNewsSnapshot(input: {
  source: 'longbridge'
  reason: 'futu_live' | 'futu_simulation' | 'longbridge_live'
  forceRefresh?: boolean
}): Promise<MacroNewsSnapshot>
```

缓存策略：

* 默认 TTL：`120` 秒。

* 同一轮 `runOnce` 内必须复用同一个 snapshot 对象。

* 如果 Futu 实盘、Futu 模拟盘和 Longbridge 实盘在 TTL 内先后运行，可复用同一份快照。

* Longbridge CLI 调用必须串行化，避免并发 run 同时触发多次 CLI。

* 若已有刷新进行中，后续请求等待同一个 Promise，不再新开 CLI 进程。

建议配置项：

```env
MACRO_NEWS_SNAPSHOT_ENABLED=true
MACRO_NEWS_SNAPSHOT_TTL_SECONDS=120
MACRO_NEWS_SNAPSHOT_MAX_ARTICLES=8
MACRO_NEWS_SNAPSHOT_TIMEOUT_MS=8000
MACRO_NEWS_SNAPSHOT_LANG=zh-CN
```

## 失败降级

新闻快照失败不能阻断 Futu 实盘、Futu 模拟盘或 Longbridge 实盘主流程。

失败时返回：

```ts
{
  ok: false,
  source: 'longbridge',
  generatedAt: string,
  expiresAt: string,
  riskLevel: 'UNAVAILABLE',
  summary: 'Longbridge 新闻快照暂不可用，本轮不得基于宏观新闻做额外风险判断。',
  articles: [],
  warnings: ['具体错误信息']
}
```

LLM prompt 中必须明确：

* 新闻快照不可用时，不得编造新闻。

* 不得假设没有风险事件。

* 只能基于对应平台的行情、账户、趋势和已有数据做交易判断。

## 快照结构

建议共享类型：

```ts
export type MacroNewsRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME' | 'UNAVAILABLE'

export type MacroNewsArticle = {
  id: string
  title: string
  sourceName: string
  publishedAt: string
  excerpt: string
  url?: string
  matchedKeywords: string[]
}

export type MacroNewsSnapshot = {
  ok: boolean
  source: 'longbridge'
  generatedAt: string
  expiresAt: string
  querySetVersion: string
  riskLevel: MacroNewsRiskLevel
  summary: string
  marketRiskHints: {
    affectedAssets: string[]
    affectedSectors: string[]
    watchIndicators: string[]
    suggestedPolicy: 'NORMAL' | 'REDUCE_NEW_ORDERS' | 'BLOCK_LEVERAGED_ETF' | 'PAUSE_NEW_ENTRIES'
  }
  articles: MacroNewsArticle[]
  warnings: string[]
}
```

## 风险等级规则

首期可以先不用 LLM 对新闻做二次总结，使用规则生成保守快照，避免新增一次模型调用。

建议规则：

* `LOW`：相关新闻少，且标题/摘要没有升级、袭击、导弹、核设施、封锁、报复等关键词。

* `MEDIUM`：出现多条相关新闻，但多为会谈、警告、外交表态或局部行动。

* `HIGH`：出现军事打击、报复、革命卫队、以色列/黎巴嫩行动升级、油价冲击等明确升级词。

* `EXTREME`：出现美国直接军事行动、霍尔木兹海峡、核设施被攻击、大规模报复、市场熔断/避险暴涨等极端词。

* `UNAVAILABLE`：Longbridge CLI 失败、超时或返回无法解析。

后续可以增加“新闻快照 LLM 总结器”，但它也必须是每轮一次，不能按 ticker 并发。

## Prompt 注入位置

三类交易入口必须使用同一组基础规则，避免 Futu 模拟盘、Futu 实盘和 Longbridge 实盘对新闻快照的理解不一致。平台差异只允许体现在附加规则中。

基础规则：

```json
[
  "该新闻快照是本轮所有 ticker 共享上下文，不是针对单个 ticker 的新闻搜索。",
  "不得在每个 ticker 决策中重新搜索新闻。",
  "不得仅凭新闻标题开仓；必须结合 marketData、trendContext、orderBook、账户风险和平台交易约束。",
  "新闻快照只用于识别宏观/地缘政治风险，不是单票利好或利空结论。",
  "HIGH 或 EXTREME 时，优先降低杠杆 ETF、高 beta 标的和盘前盘后低流动性新开仓，允许合理平仓/降风险。",
  "UNAVAILABLE 时不得编造新闻，不得假设没有风险事件，也不得因为新闻不可用而放松风控。"
]
```

Futu 模拟盘：

* 修改 `requestTradingDecision` 的 `DecisionInput`，新增 `macroNewsSnapshot?: MacroNewsSnapshot`。

* 在 `buildDecisionPrompt` 的 user JSON 中新增：

```json
{
  "macroNewsContext": {
    "source": "Longbridge CLI shared snapshot",
    "snapshot": "...",
    "rules": [
      "该新闻快照是本轮所有 ticker 共享上下文，不是针对单个 ticker 的新闻搜索。",
      "不得在每个 ticker 决策中重新搜索新闻。",
      "不得仅凭新闻标题开仓；必须结合 marketData、trendContext、orderBook、账户风险和平台交易约束。",
      "新闻快照只用于识别宏观/地缘政治风险，不是单票利好或利空结论。",
      "HIGH 或 EXTREME 时，优先降低杠杆 ETF、高 beta 标的和盘前盘后低流动性新开仓，允许合理平仓/降风险。",
      "UNAVAILABLE 时不得编造新闻，不得假设没有风险事件，也不得因为新闻不可用而放松风控。",
      "Futu 模拟盘订单仍必须遵守模拟盘后端风控、费用模型和订单语义。"
    ]
  }
}
```

Futu 实盘：

* 修改 `requestLiveTradingDecision` 的 `DecisionInput`，新增 `macroNewsSnapshot?: MacroNewsSnapshot`。

* 注入位置与模拟盘一致，但实盘规则更严格：

```json
{
  "macroNewsContext": {
    "source": "Longbridge CLI shared snapshot",
    "liveTradingRule": "新闻只作为风险上下文；真实订单仍必须经过后端硬风控和人工确认。",
    "snapshot": "...",
    "rules": [
      "该新闻快照是本轮所有 ticker 共享上下文，不是针对单个 ticker 的新闻搜索。",
      "不得在每个 ticker 决策中重新搜索新闻。",
      "不得仅凭新闻标题开仓；必须结合 marketData、trendContext、orderBook、账户风险和平台交易约束。",
      "新闻快照只用于识别宏观/地缘政治风险，不是单票利好或利空结论。",
      "HIGH 或 EXTREME 时，优先降低杠杆 ETF、高 beta 标的和盘前盘后低流动性新开仓，允许合理平仓/降风险。",
      "UNAVAILABLE 时不得编造新闻，不得假设没有风险事件，也不得因为新闻不可用而放松风控。",
      "Futu 实盘真实订单仍必须经过后端硬风控、待确认队列和人工二次确认。",
      "新闻快照不得替代 Futu 实盘账户、持仓、行情、订单、费用和交易时段数据源。"
    ]
  }
}
```

Longbridge 实盘：

* 修改 `requestLongbridgeLiveDecision` 或 Longbridge 实盘等价 LLM 决策入口的 `DecisionInput`，新增 `macroNewsSnapshot?: MacroNewsSnapshot`。

* Longbridge 实盘的 Prompt 必须消费同一份共享新闻快照，但账户、持仓、行情、订单和真实提交门禁仍走 Longbridge 自己的数据适配器。

```json
{
  "macroNewsContext": {
    "source": "Longbridge CLI shared snapshot",
    "longbridgeLiveRule": "新闻只作为 Longbridge 实盘风险上下文；不得替代 Longbridge 行情、账户、持仓、订单或后端硬风控。",
    "snapshot": "...",
    "rules": [
      "该新闻快照是本轮所有 ticker 共享上下文，不是针对单个 ticker 的新闻搜索。",
      "不得在每个 ticker 决策中重新搜索新闻。",
      "不得仅凭新闻标题开仓；必须结合 marketData、trendContext、orderBook、账户风险和平台交易约束。",
      "新闻快照只用于识别宏观/地缘政治风险，不是单票利好或利空结论。",
      "HIGH 或 EXTREME 时，优先降低杠杆 ETF、高 beta 标的和盘前盘后低流动性新开仓，允许合理平仓/降风险。",
      "UNAVAILABLE 时不得编造新闻，不得假设没有风险事件，也不得因为新闻不可用而放松风控。",
      "Longbridge 实盘真实订单仍必须经过 Longbridge 后端风控、待确认队列和真实提交门禁。",
      "新闻快照不得替代 Longbridge 实盘账户、持仓、行情、订单、费用和交易时段数据源。"
    ]
  }
}
```

## 策略影响规则

LLM 层只负责解释和调整建议，后端硬风控仍是最终约束。

建议策略：

* `LOW`：不改变原有策略，仅在 reason 中可简要提及宏观新闻无明显冲击。

* `MEDIUM`：新开仓需要更强趋势确认；杠杆 ETF 降低信心或缩小数量。

* `HIGH`：禁止 LLM 对杠杆 ETF、高 beta 标的给出激进新开仓；允许平仓、减仓、回补空头。

* `EXTREME`：默认 HOLD 或风险降低操作；新开仓必须给出极强价格确认和风险理由，后端可直接拦截。

* `UNAVAILABLE`：不使用新闻做判断，不扩大风险，也不因为“没有新闻”而放松风控。

## 后端硬风控接入边界

首期建议只把新闻快照喂给 LLM，不直接改硬风控。

二期可新增硬风控门禁：

```ts
if (macroNewsSnapshot.riskLevel === 'EXTREME') {
  blockOpeningOrdersExceptRiskReduction()
}

if (macroNewsSnapshot.marketRiskHints.suggestedPolicy === 'BLOCK_LEVERAGED_ETF') {
  blockNewOpeningOrdersForLeveragedEtf()
}
```

风险降低操作包括：

* `SELL_TO_CLOSE` 平已有多头

* `BUY` 回补已有空头

* 用户人工确认后的主动处理

## 候选池组合裁决接入

Futu 实盘候选池组合裁决也应接收同一份新闻快照；Longbridge 实盘如果开启候选池/组合裁决，也必须接收同一份新闻快照。

原因：

* 组合裁决负责在多个候选中选择是否推进。

* 新闻风险更适合作为组合层上下文，而不是只影响单票。

* 在 `HIGH` 或 `EXTREME` 下，组合裁决应更保守地推进高 beta 或杠杆 ETF。

建议在 Futu 的 `requestLivePortfolioReviewDecision` 和 Longbridge 等价组合裁决入口中新增：

```ts
macroNewsSnapshot?: MacroNewsSnapshot
```

组合裁决 Prompt 增加规则：

* 新闻快照是全局风险，不是单票利好/利空。

* 不得只因新闻存在就压制所有候选。

* 如果压制候选，必须说明风险如何影响该候选的价格、流动性、波动或组合暴露。

## UI 展示建议

Futu 实盘、Futu 模拟盘和 Longbridge 实盘页面可新增一个只读风险卡片：

* 标题：`宏观新闻风险快照`

* 数据源：`Longbridge CLI`

* 更新时间和过期时间

* 风险等级

* 策略建议：`正常 / 降低新开仓 / 禁止杠杆 ETF 新开仓 / 暂停新开仓`

* 最近新闻标题列表

* 错误或降级提示

资产隐藏开关不影响新闻展示。

## 日志与审计

每次生成快照记录结构化日志：

```ts
logger.info({
  event: 'macro_news.snapshot.loaded',
  source: 'longbridge',
  querySetVersion,
  articleCount,
  riskLevel,
  durationMs,
  cacheHit,
})
```

每个 LLM 决策日志只记录快照 ID 或 `generatedAt`，不要重复打印完整新闻内容，避免日志膨胀。

## 不做事项

首期不做：

* 不按 ticker 调 Longbridge `news search`。

* 不在每个 LLM 并发任务里调用 CLI。

* 不让 LLM 自己决定是否搜索新闻。

* 不把 Longbridge 账户、订单、持仓混入 Futu 工作台。

* 不因为新闻快照失败而停止 Futu 实盘、Futu 模拟盘或 Longbridge 实盘。

* 不把单条未经确认新闻作为自动下单依据。

## 建议实施顺序

1. 新增共享类型 `MacroNewsSnapshot`。
2. 新增 Longbridge CLI 新闻快照服务，带 TTL、串行化和失败降级。
3. 在 Futu 模拟盘 `runOnceInternal` 开始处生成一次快照，并传入所有 `requestTradingDecision`。
4. 在 Futu 实盘 `runOnceInternal` 开始处生成一次快照，并传入所有 `requestLiveTradingDecision`。
5. 在 Longbridge 实盘 `runOnce` 开始处生成或复用一次快照，并传入所有 Longbridge 实盘 LLM 决策。
6. 在 Futu 实盘候选池组合裁决中传入同一份快照。
7. 在 Longbridge 实盘候选池/组合裁决中传入同一份快照。
8. 在 Prompt JSON 中增加 `macroNewsContext`。
9. 增加单元测试，验证一轮 run 内只调用一次新闻服务。
10. 增加 UI 风险快照卡片。

## 验收标准

* Futu 实盘一轮 `runOnce` 中，无论 ticker 并发数是多少，Longbridge 新闻 CLI 最多调用一次。

* Futu 模拟盘一轮 `runOnce` 中，无论 ticker 并发数是多少，Longbridge 新闻 CLI 最多调用一次。

* Futu 实盘、Futu 模拟盘和 Longbridge 实盘都能在 Prompt 中收到同一份结构化新闻快照。

* Longbridge 新闻获取失败时，Futu 和 Longbridge 的交易评估继续运行，并在 Prompt 中标记 `UNAVAILABLE`。

* LLM 不会在每个 ticker 决策里触发新闻搜索。

* 后端日志能看出快照是否来自缓存、风险等级和文章数量。

* 不修改 Futu 账户、订单、行情、持仓的既有数据源边界。

* 不修改 Longbridge 账户、订单、行情、持仓的既有数据源边界；新闻快照只作为 Longbridge 实盘额外风险上下文。

