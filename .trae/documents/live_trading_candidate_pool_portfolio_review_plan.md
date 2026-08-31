# 实盘候选池与组合裁决设计计划

## 目标

把当前“DeepSeek 单标的信号直接进入待确认订单”的流程，调整为“单标的信号进入候选池，DeepSeek 再做跨时间组合裁决，后端硬风控通过后才进入人工确认队列”。

本计划先描述设计，并已基于原型确认进入实现阶段。实现必须保持老逻辑可一键回退。

## 背景判断

6.18 实盘历史显示，DeepSeek 的 BUY 信号本身不是主要问题。主要问题是它在多轮轮询中持续、异步地推荐不同高相关机会，例如 `NVDL`、`AMDL`、`AMZZ`、`TSMU`、`MULL` 等 2x 做多产品交叉出现。

这不是“同一轮多个 BUY 怎么排序”的问题，而是“跨多轮、间隔出现的 BUY 怎么比较”的问题。

当前缺口：

- 单标的信号只回答“这个标的现在是否可以买”，没有回答“它是否比前几轮候选更值得买”。
- 多个 2x 杠杆 ETF 会形成重复高 beta 科技暴露，但没有统一的组合约束。
- 待确认队列承载了太多未排序的订单意图，用户需要人工在时间序列里重建优先级。
- 每分钟全量轮询会放大短周期噪声，并让候选订单过密。

## 总体方案

新增一个“滚动机会候选池”。DeepSeek 单标的扫描只负责发现机会，组合裁决 DeepSeek 负责从候选池里决定是否推进订单。

新增一个前端可切换的“组合策略开关”：

- 打开组合策略：走新链路，即 `标的扫描 -> 候选池 -> DeepSeek 组合裁决 -> 后端硬风控 -> 人工确认队列`。
- 关闭组合策略：走原来的老链路，即 `标的扫描 -> 后端硬风控 -> 人工确认队列`，不写入候选池，也不调用组合裁决 DeepSeek。

这个开关必须是实盘页面上的显式按钮，不能隐藏在配置文件里。用户需要能一眼看出当前实盘运行的是“组合策略模式”还是“老逻辑直推模式”。

流程：

1. 标的扫描产生单标的信号。
2. 非 HOLD 信号先进入候选池，不直接进入待确认订单。
3. 候选池保留跨多轮机会，维护有效期、重复确认次数、价格偏离、同组关系和风险标签。
4. 组合裁决 DeepSeek 周期性读取候选池，输出 `promote / watch / suppress / expire`。
5. 后端硬风控复核被 promote 的候选。
6. 通过风控后进入人工确认队列。

关闭组合策略时的兼容流程：

1. 标的扫描产生单标的信号。
2. `HOLD` 只写入历史策略信号。
3. 非 `HOLD` 信号沿用当前老逻辑，直接进入后端硬风控。
4. 通过硬风控后进入人工确认队列。
5. 不创建候选项，不更新候选池状态，不调用组合裁决 Prompt。

## 组合策略开关

开关字段建议：

```ts
type LivePortfolioStrategyMode = {
  enabled: boolean
  mode: 'legacy_direct' | 'candidate_pool'
  updatedAt: string
  updatedBy?: string
}
```

状态含义：

- `enabled: true`: 启用候选池与组合裁决。非 HOLD 信号先进入候选池，只有被组合裁决 promote 且通过硬风控后，才进入待确认订单队列。
- `enabled: false`: 关闭候选池与组合裁决。系统完全沿用当前老逻辑，非 HOLD 信号直接进入硬风控，风控通过后进入待确认订单队列。

前端按钮设计：

- 按钮位置：放在“实盘策略与 Prompt 版本”或新增“组合策略总览”区域顶部。
- 打开状态文案：`组合策略已开启`，按钮动作显示 `关闭组合策略，回到老逻辑`。
- 关闭状态文案：`组合策略已关闭，当前走老逻辑直推`，按钮动作显示 `开启组合策略`。
- 状态标签必须同步展示当前链路：
  - `候选池模式：标的扫描 -> 候选池 -> 组合裁决 -> 硬风控 -> 人工确认`
  - `老逻辑模式：标的扫描 -> 硬风控 -> 人工确认`

切换规则：

- 开启组合策略后，只影响后续新信号；已有待确认订单不迁移、不删除。
- 关闭组合策略后，已有候选池记录保留为历史，但不再参与组合裁决，也不再自动 promote。
- 如果关闭时已有 `PROMOTED` 但尚未进入待确认订单的候选，应保持原状态并标记 `DISABLED_BY_MODE_SWITCH` 或写入事件说明，避免静默推进。
- 切换动作必须写入配置事件日志，便于复盘某笔订单到底来自候选池模式还是老逻辑模式。

已确认的切换语义：

- `legacy_direct -> candidate_pool`: 从下一轮扫描开始，后续非 `HOLD` 信号进入候选池；已有待确认订单不迁移、不删除。
- `candidate_pool -> legacy_direct`: 候选池中所有未过期、未禁用的候选应立即标记为 `DISABLED_BY_MODE_SWITCH`，并写入持久化事件；不等待下一轮扫描才处理。
- `legacy_direct` 运行期间：后续非 `HOLD` 信号不进入候选池，直接走老逻辑，即 `后端硬风控 -> 人工确认队列`。
- 再次切回 `candidate_pool`: 之前被 `DISABLED_BY_MODE_SWITCH` 的候选不得恢复，不得参与组合裁决；新的非 `HOLD` 信号重新进入候选池。
- 同一候选如果历史中同时存在旧的 `ACTIVE` 记录和新的 `DISABLED_BY_MODE_SWITCH` 记录，恢复时必须只认最新状态，旧 `ACTIVE` 不允许复活。

## 状态流转

候选状态：

```text
NEW -> ACTIVE -> PROMOTED -> RISK_REJECTED
              -> CONFIRMED_ORDER
              -> SUPPRESSED
              -> SUPERSEDED
              -> EXPIRED
              -> DISABLED_BY_MODE_SWITCH
              -> USER_REJECTED
```

含义：

- `NEW`: 新进入候选池，尚未被组合裁决处理。
- `ACTIVE`: 当前仍有效，可参与组合裁决。
- `PROMOTED`: 被组合裁决选中，准备进入后端风控。
- `CONFIRMED_ORDER`: 已进入待确认订单队列。
- `RISK_REJECTED`: 被后端硬风控拦截。
- `SUPPRESSED`: 当前不优先，但可以保留观察。
- `SUPERSEDED`: 被同组更优候选替代。
- `EXPIRED`: 超过有效期或市场条件失效。
- `DISABLED_BY_MODE_SWITCH`: 用户关闭组合策略后，该候选不再参与组合裁决或推进。
- `USER_REJECTED`: 用户明确拒绝该候选或对应订单。

`DISABLED_BY_MODE_SWITCH` 的补充约束：

- 该状态是候选池退出组合策略链路的终态之一。
- 进入该状态后，即使服务重启或用户再次开启组合策略，也不能恢复为 `ACTIVE / WATCH / PROMOTED`。
- 该状态用于表达“用户主动切回老逻辑，历史候选只保留用于复盘”，不是风控失败，也不是 DeepSeek 组合裁决失败。

## 候选池数据模型

候选项建议字段：

```ts
type LiveTradeCandidate = {
  id: string
  ticker: string
  action: 'BUY' | 'SELL_SHORT' | 'SELL_TO_CLOSE'
  groupKey: string
  riskTags: string[]
  model: string
  modelLabel: string
  promptVersion: string
  signalPromptVersion: string
  portfolioReviewPromptVersion?: string
  firstSeenAt: string
  lastSeenAt: string
  expiresAt: string
  status: CandidateStatus
  signalCount: number
  firstSignalPrice: number
  latestSignalPrice: number
  latestMarketPrice: number
  priceDriftPct: number
  proposedQuantity: number
  proposedNotional: number
  confidence: 'low' | 'medium' | 'high'
  recentReasons: string[]
  lastDecisionReason?: string
  suppressionReason?: string
  supersededByCandidateId?: string
}
```

`groupKey` 示例：

- `NVDA_LONG_BETA`: `NVDA`, `NVDL`
- `AMD_LONG_BETA`: `AMD`, `AMDL`
- `AMZN_LONG_BETA`: `AMZN`, `AMZZ`
- `TSM_LONG_BETA`: `TSM`, `TSMU`
- `SK_HYNIX_LONG_BETA`: `07709`
- `SAMSUNG_ELECTRONICS_LONG_BETA`: `07747`
- `SPACEX_LONG_BETA`: `SPCX`, `SPCU`, `SPAL`
- `NASDAQ_LONG_BETA`: `TQQQ`

风险标签示例：

- `LEVERAGED_2X_ETF`
- `HIGH_BETA_TECH`
- `SINGLE_STOCK_LEVERAGED`
- `LOW_LIQUIDITY_SESSION`
- `OVERNIGHT_SESSION`
- `REPEATED_SIGNAL`
- `PRICE_DRIFTED_UP`
- `PRICE_DRIFTED_DOWN`

## DeepSeek 组合裁决 Prompt

组合裁决由 DeepSeek 执行，但必须受系统硬约束约束。DeepSeek 输出的是“推进建议”，不是最终下单。

Prompt 版本建议：

- `live_portfolio_candidate_review_v1`

输入结构：

```json
{
  "task": "从实盘交易候选池中决定哪些候选应推进到人工确认订单队列",
  "promptVersion": "live_portfolio_candidate_review_v1",
  "reviewPreset": {
    "id": "deepseek_balanced_v1",
    "label": "DeepSeek 平衡版 v1"
  },
  "candidatePool": [
    {
      "candidateId": "candidate-xxx",
      "ticker": "NVDL",
      "action": "BUY",
      "groupKey": "NVDA_LONG_BETA",
      "riskTags": ["LEVERAGED_2X_ETF", "HIGH_BETA_TECH"],
      "firstSeenAt": "2026-06-18T17:00:00Z",
      "lastSeenAt": "2026-06-18T17:08:00Z",
      "signalCount": 3,
      "firstSignalPrice": 99.6,
      "latestSignalPrice": 99.94,
      "latestMarketPrice": 99.8,
      "priceDriftPct": 0.34,
      "proposedQuantity": 10,
      "proposedNotional": 998,
      "recentReasons": ["..."]
    }
  ],
  "portfolioState": {
    "cash": "...",
    "buyingPower": "...",
    "positions": [],
    "pendingOrders": [],
    "recentPromotedCandidates": []
  },
  "constraints": {
    "maxPromotedOrdersPerReview": 1,
    "minSignalConfirmations": 2,
    "leveragedEtfCooldownMinutes": 8,
    "sameGroupMutualExclusion": true,
    "humanConfirmationRequired": true
  },
  "requiredJson": {
    "promotedCandidates": [],
    "watchedCandidates": [],
    "suppressedCandidates": [],
    "expiredCandidates": [],
    "portfolioRationale": "中文说明"
  }
}
```

输出结构：

```json
{
  "ok": true,
  "promptVersion": "live_portfolio_candidate_review_v1",
  "promotedCandidates": [
    {
      "candidateId": "candidate-xxx",
      "rank": 1,
      "ticker": "NVDL",
      "action": "BUY",
      "orderQuantity": 10,
      "limitPrice": 99.8,
      "reason": "相对同组候选，NVDL 的趋势确认次数更高，价格偏离可控，流动性更好。",
      "riskAssessment": "2x 杠杆 ETF，需限制单笔名义金额并设置冷却。",
      "whyPromoteNow": "连续多轮确认且未明显追高，优先于 AMDL/AMZZ。",
      "whyNotOthers": "AMDL 与 NVDL 同属高 beta 科技杠杆暴露，本轮不重复推进。"
    }
  ],
  "watchedCandidates": [],
  "suppressedCandidates": [
    {
      "candidateId": "candidate-yyy",
      "ticker": "AMDL",
      "reason": "与 NVDL 风险暴露高度相关，本轮保留观察。"
    }
  ],
  "expiredCandidates": [],
  "portfolioRationale": "本轮只推进一个候选，避免多个 2x 科技杠杆 ETF 同时放大组合风险。"
}
```

## 时间配置与版本预设

前端必须可视化展示并可切换版本。配置项需要显示版本号、适用风格、当前生效值和说明。

配置项：

```ts
type LivePortfolioTimingPreset = {
  id: string
  label: string
  version: string
  description: string
  singleSignalScanIntervalMinutes: number
  portfolioReviewIntervalMinutes: number
  candidateTtlMinutes: number
  leveragedEtfCooldownMinutes: number
  minSignalConfirmations: number
  maxPromotedOrdersPerReview: number
  maxActiveCandidates: number
  enabled: boolean
}
```

预设版本：

| 预设 ID | 名称 | 定位 | 标的扫描 | 组合裁决 | 候选有效期 | 杠杆 ETF 冷却 | 最少确认 | 每轮推进 |
|---|---|---|---:|---:|---:|---:|---:|---:|
| `deepseek_conservative_v1` | DeepSeek 保守版 v1 | 降低噪声和重复订单 | 5 分钟 | 10 分钟 | 25 分钟 | 15 分钟 | 2 | 1 |
| `deepseek_balanced_v1` | DeepSeek 平衡版 v1 | 推荐默认值，保留趋势速度但加系统刹车 | 2 分钟 | 5 分钟 | 15 分钟 | 8 分钟 | 2 | 1 |
| `deepseek_aggressive_v1` | DeepSeek 激进版 v1 | 强趋势日快速响应 | 1 分钟 | 3 分钟 | 10 分钟 | 5 分钟 | 1 | 2 |

平衡版采用前面讨论中给 DeepSeek 设置的折中值。

保守版适合：

- 夜盘、盘前低流动性时段。
- 连续亏损后降频。
- 高相关杠杆 ETF 信号密集出现时。

平衡版适合：

- 常规盘中默认运行。
- 需要保留 DeepSeek 捕捉趋势能力，同时避免订单泛滥。

激进版适合：

- 明确强趋势日。
- 用户主动短时间观察和手动确认。
- 需要配合更严格的单笔仓位和冷却约束。

## 前端可视化设计范围

这次原型阶段建议新增或扩展“实盘交易配置 / 组合策略”区域。

必须展示：

- 组合策略开关按钮。
- 当前链路模式：候选池模式或老逻辑模式。
- 当前单标的扫描 Prompt 版本。
- 当前组合裁决 Prompt 版本。
- 当前时间预设版本。
- 三个时间预设卡片：保守、平衡、激进。
- 每个预设的所有时间值和短说明。
- 当前候选池列表。
- 当前候选池排序。
- 被 DeepSeek promote 的候选。
- 被 suppress / supersede / expire 的候选及原因。
- 同组互斥提示。
- 最近一次组合裁决日志。

推荐页面模块：

1. `组合策略总览`
   - 组合策略开关。
   - 当前运行链路。
   - 当前 Preset。
   - 当前 Prompt 版本。
   - 下一次标的扫描倒计时。
   - 下一次组合裁决倒计时。

2. `时间预设配置`
   - 保守 / 平衡 / 激进三张卡片。
   - 当前选中卡片高亮。
   - 每项时间值可读说明。
   - 后续可扩展自定义版本，但原型先不做自由编辑。

3. `候选池指挥台`
   - ACTIVE 候选按分数或裁决优先级排序。
   - 展示 `firstSeenAt`, `lastSeenAt`, `signalCount`, `expiresAt`, `priceDriftPct`。
   - 2x 杠杆 ETF 使用明显风险标签。
   - 同组候选折叠展示，避免横向信息过载。

4. `组合裁决结果`
   - promoted candidates。
   - suppressed candidates。
   - expired candidates。
   - portfolioRationale。

5. `待确认订单入口`
   - 只展示通过组合裁决和硬风控的订单。
   - 明确标注来源候选 ID 和组合裁决版本。
   - 如果组合策略关闭，则标注来源为 `legacy_direct`，不显示候选 ID。

## 双态原型交互规则

原型确认采用“当前实盘页面增量扩展”，不是新增独立页面，也不是替换现有页面。当前页面已有模块必须保留：

- 顶部实盘控制。
- 账户指标。
- 大模型配置。
- 实盘门禁 / 硬风控说明。
- 实盘策略与 Prompt 版本。
- 历史策略信号。
- 待确认订单队列。
- Futu REAL 订单状态。
- 二次确认弹窗。

组合策略开关必须联动以下页面状态：

开启态 `candidate_pool / enabled`：

- 顶部状态标签显示 `组合策略已开启`。
- 策略配置区显示当前链路：`标的扫描 -> 候选池 -> DeepSeek 组合裁决 -> 硬风控 -> 人工确认`。
- 候选池模块正常显示时间预设、候选表、`PROMOTE / WATCH / SUPPRESS` 状态和组合裁决理由。
- 历史策略信号显示候选池状态，例如 `进入候选池 · PROMOTED`、`进入候选池 · SUPPRESSED`。
- 待确认订单来源显示候选 ID、组合裁决版本和 rank。
- 二次确认弹窗展示候选池来源、组合裁决理由、被压制候选摘要、Prompt 版本和时间预设版本。

关闭态 `legacy_direct / disabled`：

- 顶部状态标签显示 `组合策略已关闭 · 老逻辑直推`。
- 策略配置区显示当前链路：`标的扫描 -> 硬风控 -> 人工确认`。
- 候选池模块保留为只读历史，不再展示新的组合裁决倒计时，不产生新的 `PROMOTE / SUPPRESS`。
- 已有候选显示 `DISABLED_BY_MODE_SWITCH`，避免用户误以为关闭后还会静默推进。
- 历史策略信号显示老逻辑路径，例如 `老逻辑直推 · 已入队` 或 `老逻辑直推 · 风控拦截`。
- 待确认订单来源显示 `legacy_direct`，不显示候选 ID。
- 二次确认弹窗不展示组合裁决理由，改为展示 `legacy_direct` 和硬风控通过详情。

切换交互要求：

- 开关点击后页面必须立即切换状态，不需要等待下一轮评估才改变视觉状态。
- 切换只影响后续新信号；已有待确认订单不迁移、不删除。
- 关闭时已有候选池记录保留为历史，只读展示。
- 开启后从下一轮扫描开始重新写入候选池。
- 配置保存失败时，前端必须回滚显示或展示错误，不允许让 UI 与后端实际模式不一致。

## 后端设计边界

后端需要新增候选池服务，但本计划不实现。

预期职责：

- 读取组合策略开关，决定走候选池模式还是老逻辑模式。
- 将单标的信号写入候选池。
- 合并同一 `ticker + action + groupKey` 的重复信号。
- 根据 Preset 更新 TTL 和冷却。
- 调用组合裁决 DeepSeek。
- 记录组合裁决事件。
- 对 promote 结果执行硬风控。
- 通过后写入现有待确认订单队列。

模式分支：

- `candidate_pool`: 执行候选池写入、候选合并、组合裁决、promote 后风控。
- `legacy_direct`: 跳过候选池和组合裁决，沿用现有非 HOLD 信号直接风控入队逻辑。

需要持久化：

- candidates。
- candidate_events。
- portfolio_review_events。
- timing_preset_config。
- prompt_version_config。
- portfolio_strategy_mode_config。
- portfolio_strategy_mode_events。

候选池持久化约束：

- 候选池不能只保存在内存中；否则服务重启会导致跨时间候选积累作废。
- 每次候选 `upsert`、组合裁决状态变化、TTL 过期、模式切换禁用，都必须写入候选池持久化事件。
- 服务启动或首次读取候选池时，应从持久化记录恢复未过期、未禁用的候选。
- 恢复时按候选唯一键读取最新状态；如果最新状态是 `EXPIRED` 或 `DISABLED_BY_MODE_SWITCH`，不得用更早的 `ACTIVE / WATCH / PROMOTED / SUPPRESSED` 记录恢复。
- `SUPPRESSED` 候选在 TTL 内应继续展示在候选池中，便于复盘和观察，但不再参与下一轮组合裁决，除非后续新信号重新激活该候选。
- `PROMOTED` 候选如果已经生成待确认订单，订单生命周期由待确认订单队列管理；候选池只保留来源、组合裁决 ID、rank 和裁决理由用于追溯。

## 不在本阶段做的事

- 不改代码。
- 不改现有实盘下单链路。
- 不自动执行任何订单。
- 不取消人工确认。
- 不把候选池收益回测做成正式绩效模块。
- 不做自由编辑 Prompt 的复杂 UI；原型只展示版本和只读内容。
- 不在关闭组合策略时删除候选池历史数据。

## 原型输出要求

用户确认本文档后，下一步输出原型，原型应包含：

- 组合策略开关按钮。
- 当前链路模式展示。
- 实盘组合策略配置区。
- 时间预设三卡片。
- Prompt 版本展示区。
- 候选池表格。
- 组合裁决结果区。
- 待确认订单来源链路展示。

原型只表达交互和信息架构，不接真实后端。

## 待用户确认的问题

1. 三个时间预设是否接受当前默认值？
2. 平衡版是否作为默认启用版本？
3. 候选池是否只接收 `BUY / SELL_SHORT / SELL_TO_CLOSE`，继续忽略 `HOLD`？
4. 同组互斥关系是否接受当前分组？
5. 原型是否以 `LiveTradingView` 扩展区域呈现，还是新增独立“组合策略”页面？
6. 组合策略开关默认是否关闭，以保证上线后先沿用老逻辑？
