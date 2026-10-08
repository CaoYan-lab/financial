# Top30 量化选股研究设计与实施计划

## Summary

将 macOS 客户端“研究”页现有的“量化研究”说明卡升级为可执行的 Top30 美股选股研究模块：

- 标的池复用 SELL PUT 的同一业务口径：当日全球市值前 30、且在 NYSE/Nasdaq 交易的公司；合并 Alphabet、Berkshire 等重复股权类别。
- Futu 与 Longbridge 分别生成独立报告：
  - 在 Futu 页面执行，只使用 SEC/FINRA 官方源和 Futu OpenD，不调用 Longbridge。
  - 在 Longbridge 页面执行，只使用 SEC/FINRA 官方源和 Longbridge，不调用 Futu。
- SEC/FINRA 官方源优先；官方源连接失败时，只回退到当前报告所属券商可提供的数据。任何路径都不读取 Yahoo。
- 选股使用五层证据：SEC XBRL 基本面、SEC 申报事件、FINRA 卖空数据、券商宏观环境、券商复权价格趋势。
- 每个标的拥有独立采集请求、独立模型请求和独立 `requestId`。单票失败不取消其他标的。
- 模型负责五维综合评分；服务端校验分项边界、证据引用和数据覆盖，并确定性求和、排序及选出 Top5。模型不能直接跨标的修改排名，也不能生成交易信号或订单。
- 结果统一进入“策略中心 → 报告”，包含 Top5、观察组、Bottom5、全 30 只明细、证据、反证、风险、数据缺口和退出/失效条件。
- 两家券商报告不自动比较。用户在任一报告中点击“对比报告”，手动选择另一券商的一份历史报告，系统生成即时、确定性的并排差异页，不新增模型调用。
- 首版只产出研究报告，不写交易候选池，不触发下单。

成功标准：

1. Futu 与 Longbridge 均能在各自研究页独立启动 Top30 量化选股。
2. 每次运行锁定 30 个标的并形成 30 个独立终态结果。
3. 官方源不可用时按照当前券商能力降级，缺口明确可见，不跨券商补数。
4. 有效评分按固定五维上限校验，Top5 只来自覆盖度和时效满足门槛的标的。
5. 报告持久化、可恢复、可分页查看，并支持用户手动选择异券商报告进行确定性对比。

## Current State Analysis

### 1. 研究页只有说明，没有量化报告执行链

- `changfu-desktop/macos/Domain/ResearchModels.swift`
  - `ResearchSkill.quantitative` 只有标题、说明、`research-quantitative-v1` 和四行能力清单。
- `changfu-desktop/macos/App/FutuWorkspaces.swift`
  - `researchSkillPanel(_:)` 只给 `.sellPut` 渲染执行按钮、进度和状态。
  - `.quantitative` 仍是静态能力说明卡。
- `changfu-desktop/macos/App/AppState.swift`
  - 只有按 Provider 隔离的 SELL PUT pool/report/run state，没有量化报告状态。
- 策略中心已经预留“量化研究”筛选项，但当前显示“暂无已生成内容”。

### 2. SELL PUT 已提供可复用的产品与工程模式

以下现有实现可作为结构参考，但量化研究使用独立领域对象、表和接口：

- Top30 解析与股权类别合并：
  - `changfu-backend/packages/domain/src/sellPutUniverse.ts`
- Provider 独立池、报告、历史、详情和幂等：
  - `changfu-backend/apps/gateway/src/routes/sellPutResearch.ts`
  - `changfu-backend/packages/persistence/src/postgresSellPutResearchRepository.ts`
  - `changfu-backend/migrations/008_sell_put_research.sql`
- 每批独立采集、单票 `requestId`、进度与 Provider 隔离：
  - `changfu-desktop/macos/App/AppState.swift`
- 报告中心固定列宽、斑马纹、详情弹窗和 Markdown：
  - `changfu-desktop/macos/App/SellPutResearchWorkspace.swift`

现有 `fetchSellPutTopThirty()` 在排名源失败时会返回静态 seed 并设置 `fallback=true`。SELL PUT 客户端已经在该状态下停止报告。量化研究沿用相同失败关闭语义，不将静态名单伪装为当日 Top30。

### 3. 当前券商数据能力

#### Futu

现有桥接已实现：

- 正股快照：现价、市值、PE。
- 260 根前复权日 K：20/30/60/120 日趋势、MA50/200、RSI14、实现波动率、52 周位置。
- 美国经济日历、FedWatch、财报日历。
- 新闻/公告搜索；Futu `NOTICE` 可作为申报事件的券商降级证据。

相关文件：

- `changfu-desktop/macos/FutuCppBridge/ChangFuFutuBridge.mm`
- `changfu-desktop/macos/NativeBroker/FutuNativeBroker.swift`
- `changfu-desktop/macos/Infrastructure/FutuBrokerClient.swift`

当前已打包的 Futu SDK 头文件未发现财务报表、每日卖空成交和 short interest 协议，不能在计划中假设它们一定存在。因此 Futu 报告在 SEC/FINRA 官方源不可用时，基本面和卖空层可能只有部分字段或完全不可用，必须降低覆盖度并禁止伪造。

#### Longbridge

本机 `.tools/longbridge/longbridge` 已确认存在以下只读命令：

- `financial-statement`、`financial-report`
- `filing`
- `insider-trades`（SEC Form 4）
- `investors`（SEC 13F）
- `short-trades`（每日卖空成交）
- `short-positions`（short interest）
- `finance-calendar macrodata`
- `quote`、`kline`

当前 `changfu-desktop/macos/LongbridgeHost/main.swift` 只暴露账户、行情、期权和交易相关命令，还没有量化研究只读命令。需要新增严格白名单命令和结构化 DTO，不能让主 App 传入任意 CLI 参数。

### 4. 当前 Worker 与报告协议不支持五维模型评分

- `changfu-backend/apps/decision-worker/src/server.ts`
  - 量化研究仅作为普通对话能力的一句提示。
  - SELL PUT 有独立整份报告模型路由，但没有单标的量化评分路由。
- `changfu-contracts/schemas/model-result.schema.json`
  - 面向对话/交易信号，不适合承载五维研究评分。

量化选股应使用独立、严格的研究结果 Schema，不扩张交易 `ModelResult`，避免把报告评分误接到信号或订单链路。

### 5. 策略中心已具备接入位置

`changfu-desktop/macos/App/FutuWorkspaces.swift` 的 `StrategyCenterWorkspace` 已有：

- “全部报告 / 量化研究 / SELL PUT 期权研究”筛选。
- SELL PUT 报告模块。

新增量化报告模块后，“全部报告”同时展示量化报告和 SELL PUT 报告；“量化研究”只展示量化报告。

## Product Decisions

### 1. Provider 隔离

- Futu 报告：官方 SEC/FINRA + Futu。
- Longbridge 报告：官方 SEC/FINRA + Longbridge。
- 禁止 Futu 报告调用 Longbridge 补缺，反之亦然。
- 报告、运行态、历史、缓存引用和详情按 `provider_id` 隔离。
- 当前页面 Provider 决定新报告 Provider；异步结果必须写回发起 Provider，不能因用户切换平台而回填到当前页面。

### 2. 数据源优先级

| 证据层 | 官方优先源 | Futu 降级 | Longbridge 降级 |
| --- | --- | --- | --- |
| 基本面 | SEC companyfacts/frames | 市值、PE 等 OpenD 快照；完整质量指标缺失时标记 PARTIAL | `financial-statement`、`financial-report` |
| 申报事件 | SEC submissions、Form 4 | Futu `NOTICE`/财报日历 | `filing`、`insider-trades`、必要时 `investors` |
| 卖空 | FINRA 日度 short volume | 仅在当前 OpenD/SDK 确认支持时使用；否则 UNAVAILABLE | `short-trades`、`short-positions` |
| 宏观 | 不新增第三方网页源 | 美国经济日历、FedWatch、财报日历 | `finance-calendar macrodata`、财报日历 |
| 价格 | 不使用 Yahoo | OpenD 前复权日 K 和快照 | Longbridge 前复权日 K 和报价 |

固定禁用：

- Yahoo 行情、K 线、财务和期权接口。
- 新浪、腾讯、东财等网页私有接口。
- 另一券商接口作为当前报告的 fallback。

### 3. 运行方式

- 仅手动执行。
- 同一交易日可复用官方数据缓存；每次执行都刷新当前券商行情、日 K 尾部和宏观/财报日历。
- 不增加后台定时任务和通知。
- 运行中允许用户切换工作区或 Provider，但同一 Provider 禁止重复启动。

### 4. 模型评分与确定性聚合

每个标的独立调用一次模型，模型只能返回以下五个分项：

| 维度 | 上限 | 主要内容 |
| --- | ---: | --- |
| 基本面质量与成长 | 30 | 盈利能力、营收/利润增长、现金转换、杠杆、估值合理性 |
| 申报与公司事件 | 20 | 10-K/10-Q/8-K、Form 4、财报窗口和重大风险事件 |
| 卖空拥挤度 | 10 | short-volume 自身历史异常、short interest、days-to-cover；绝对比例不得直接解释为看空 |
| 价格趋势与风险 | 25 | 前复权趋势、MA50/200、52 周位置、下行/实现波动率、成交活跃度 |
| 宏观适配 | 15 | 利率、通胀、就业、FedWatch 与公司行业/久期暴露的匹配度 |

模型还必须返回：

- `summary`
- `evidenceIds`
- `counterEvidenceIds`
- `risks`
- `dataGaps`
- `invalidationConditions`
- 每一维的 `availability: AVAILABLE | PARTIAL | UNAVAILABLE`

服务端负责：

1. 验证所有证据 ID 必须来自输入 evidence catalog。
2. 验证分项分数为整数且不超过对应上限。
3. 以分项之和计算 `totalScore`，不接受模型直接提交的总分。
4. 不因缺失维度重分配权重，不以 0 或估算值伪装缺失数据。
5. 按 `totalScore DESC`、原 Top30 市值排名、ticker 稳定排序。

候选覆盖门槛：

- 当前报价必须可用且时效合格。
- 至少 200 根前复权日 K 可用。
- 基本面和价格两层不能为 `UNAVAILABLE`。
- 可用/部分可用维度的原始权重合计至少 80。
- 模型结果必须通过 Schema 和证据引用校验。

不满足门槛的标的仍进入全量明细，但状态为“数据不足”或“评分失败”，不能进入 Top5。若合格标的不足 5 只，Top5 区只展示实际合格数量，不用低覆盖标的补足。

### 5. 报告分组

- Top5：合格标的中总分最高的最多 5 只。
- 观察组：Top5 之后的最多 5 只合格标的。
- Bottom5：所有有有效模型评分的标的中总分最低的 5 只；单纯采集失败不作为“最差股票”。
- 数据不足：缺少硬前置或模型失败的标的单独列出。
- 全量排名：固定列宽、斑马纹表格；点击行打开独立详情弹窗。

### 6. 模型失败策略

- 30 个标的独立请求，单票失败不取消同批其他请求。
- 单票模型请求最多重试一次，仅限超时和明确的可重试上游错误；复用原 `requestId` 和幂等键。
- 模型格式非法、证据越界或评分越界直接标记该票 `REJECTED`，不从自由文本恢复分数。
- 最终报告排序由已通过校验的单票结果生成。
- 最终 Markdown 可调用一次汇总模型，但汇总模型只能解释已锁定排名，不能修改分数、Top5 或数据缺口。
- 汇总模型失败时生成确定性 Markdown，报告仍可完成。

### 7. 手动报告对比

- 当前报告详情提供“对比报告”按钮。
- 用户只可选择另一 Provider 的历史量化报告。
- 不自动选择、不自动生成、不新增模型调用。
- 对比必须验证：
  - 两份报告属于同一用户。
  - Provider 不同。
  - prompt/scoring version 一致；不一致时显示醒目警告，但仍允许查看。
- 对比内容：
  - 共同标的、仅左侧、仅右侧。
  - 市值池排名、总分、五维分数、最终名次和候选状态差异。
  - 数据源、采集时间、官方源降级状态和缺口差异。
  - Top5 重合度、Spearman 排名相关性和最大排名偏差。

## Proposed Changes

### Phase 1：共享 Top30 universe 与领域契约

#### `changfu-backend/packages/domain/src/topThirtyUniverse.ts`（新增）

- 从 `sellPutUniverse.ts` 提取通用 Top30 类型、StockAnalysis 解析、股权类别合并、跨市场 ticker 映射和 Provider symbol 转换。
- 保留当前“排名源失败返回 `fallback=true`”的可观测结果。
- 不增加 Yahoo 或新的网页排名源。

#### `changfu-backend/packages/domain/src/sellPutUniverse.ts`（修改）

- 改为兼容 re-export/薄封装，保证现有 SELL PUT 行为和测试不变。

#### `changfu-backend/packages/domain/src/quantitativeResearch.ts`（新增）

定义：

- `QUANT_PROMPT_VERSION = top30-quant-selection-v1`
- `QUANT_SCORING_VERSION = top30-five-layer-score-v1`
- `QuantitativeObservation`
- `QuantitativeEvidence`
- `QuantitativeDimensionScore`
- `QuantitativeItemResult`
- `QuantitativeReportSummary`
- 五维上限、覆盖度计算、候选门槛、稳定排序和确定性 Markdown 渲染。

#### `changfu-contracts/schemas/quantitative-score-result.schema.json`（新增）

- 独立于交易 `model-result.schema.json`。
- 严格限制五维分数、availability、证据 ID、反证、风险、缺口和失效条件。
- 禁止 signal、candidate、orderIntent、proposedOrder 等交易字段。

### Phase 2：官方数据适配与日缓存

#### `changfu-backend/packages/research/src/secResearchClient.ts`（新增）

- 固定访问 SEC 官方域名，不接受客户端 URL，防止 SSRF。
- 使用配置的真实 SEC `User-Agent`；未配置时将官方 SEC 标记为不可用并进入券商 fallback。
- 获取并缓存 ticker/CIK 映射、companyfacts 和 submissions。
- 以 `filed/accepted` 作为可知时间，保留 accession、form、filedAt、periodEnd、unit 和 source URL。
- 财务标准字段至少覆盖：
  - revenue
  - net income
  - operating cash flow
  - assets/liabilities
  - equity
  - R&D
  - shares outstanding
- 对同期间重述按最新 `filed <= capturedAt` 选择，不按财报期末回填未来数据。
- 事件至少覆盖 10-K、10-Q、8-K、Form 4；13F 只作为机构持仓补充，不把管理人申报错误归为公司自身事件。

#### `changfu-backend/packages/research/src/finraResearchClient.ts`（新增）

- 固定访问 FINRA/Nasdaq 官方卖空数据端点。
- 拉取最近最多 60 个可用交易日并按日期缓存；历史文件视为不可变。
- 计算：
  - short-volume ratio
  - 20/60 日均值
  - 60 日 z-score
  - 5 日变化
- 明确保留分母口径，禁止把 short volume 当作 short interest。

#### `changfu-backend/packages/research/src/publicSourceCache.ts`（新增）

- PostgreSQL cache-first，网络失败时只允许使用仍在有效期内的同源缓存。
- SEC companyfacts/submissions：同一交易日复用。
- FINRA 历史日期：成功后长期缓存；最新日期按交易日刷新。
- 缓存记录 source、cache key、as-of、fetched-at、expires-at、checksum 和 payload。
- 日志只记录来源、状态、耗时和条目数，不记录完整响应。

#### `changfu-backend/migrations/014_quantitative_research.sql`（新增）

新增：

- `quantitative_research_pools`
- `quantitative_research_pool_items`
- `quantitative_report_runs`
- `quantitative_report_items`
- `quantitative_public_source_cache`

约束：

- pool/run/item 均包含 `provider_id`，仅允许 `FUTU | LONGBRIDGE`。
- run 保存 pool version、prompt version、scoring version、model profile、状态、30 只终态计数、候选数、缺口数和来源状态。
- item 保存独立 `request_id`、原始券商 observation、官方证据快照、模型原始结构化结果和规范化 analysis。
- `(run_id, symbol)`、`request_id` 唯一，防止重复写入。
- 运行状态使用 `COLLECTING | SCORING | FINALIZING | COMPLETED | FAILED | CANCELLED`。
- item 状态使用 `PENDING | COMPLETED | REJECTED | UNAVAILABLE`。

同时更新 `changfu-backend/tests/migrations.test.ts` 的最新版本和数量断言。

### Phase 3：Futu 与 Longbridge 本地只读采集

#### `changfu-desktop/macos/Domain/QuantitativeResearchModels.swift`（新增）

定义桌面 DTO：

- pool/run/report/history/compare
- broker observation
- financial/filing/short/macro/price evidence
- source availability、freshness、data gaps

所有数值使用可空字段；缺失不编码为 0。

#### `changfu-desktop/macos/Infrastructure/FutuBrokerClient.swift`（修改）
#### `changfu-desktop/macos/NativeBroker/FutuNativeBroker.swift`（修改）
#### `changfu-desktop/macos/FutuCppBridge/include/ChangFuFutuBridge.h`（修改）
#### `changfu-desktop/macos/FutuCppBridge/ChangFuFutuBridge.mm`（修改）

新增 `quantitative-research-observation` 白名单命令：

- 复用现有正股快照和 260 根前复权日 K 计算。
- 采集市值、PE、趋势、均线、52 周位置、波动率和成交活跃度。
- 复用美国经济日历、FedWatch、财报日历和 NOTICE。
- 若当前 SDK 确认存在财务或卖空协议，再通过编译期/能力检查接入；当前打包 SDK 不具备时返回明确 `UNAVAILABLE`，不阻止应用构建。
- 单标的 observation 只包含当前 Futu 数据，禁止调用 Longbridge。

宏观数据按一次运行采集一次，再作为同一只读快照引用到 30 个独立 observation，避免重复请求；每个 item 仍保留宏观快照 ID 和时间。

#### `changfu-desktop/macos/LongbridgeHost/main.swift`（修改）
#### `changfu-desktop/macos/Infrastructure/LongbridgeBrokerClient.swift`（修改）

新增严格白名单命令：

- `quantitative-price`
- `quantitative-financials`
- `quantitative-filings`
- `quantitative-short`
- `quantitative-macro`

内部只调用固定 Longbridge CLI argv：

- `quote`
- `kline --period day --count 260 --adjust forward`
- `financial-statement --kind ALL`
- `financial-report --latest`
- `filing`
- `insider-trades`
- `short-trades --count 60`
- `short-positions`
- `finance-calendar macrodata`
- 财报日历

禁止：

- 主 App 传入任意子命令或 flags。
- mutating CLI 命令。
- 用 Futu 或网页源补 Longbridge 缺口。

### Phase 4：Gateway 独立运行 API 与持久化

#### `changfu-backend/packages/persistence/src/postgresQuantitativeResearchRepository.ts`（新增）

实现：

- Provider 独立 pool 同步。
- 创建 run 并锁定 pool version/30 个 symbols。
- 单 item 幂等写入与终态更新。
- finalize 前验证 30 个 item 全部终态。
- 确定性总分、覆盖度、Top5/观察组/Bottom5 聚合。
- latest/history/detail 查询。
- 跨 Provider 报告对比查询和规范 ticker join。

#### `changfu-backend/apps/gateway/src/routes/quantitativeResearch.ts`（新增）

API：

- `GET /v1/quantitative/pools/{provider}`
- `POST /v1/quantitative/pools/{provider}/sync-top30`
- `POST /v1/quantitative/runs`
- `POST /v1/quantitative/runs/{runId}/items`
- `POST /v1/quantitative/runs/{runId}/finalize`
- `GET /v1/quantitative/runs/{runId}/status`
- `GET /v1/quantitative/reports/latest?provider=...`
- `GET /v1/quantitative/reports/history?provider=...&page=...&pageSize=...`
- `GET /v1/quantitative/reports/{runId}?provider=...`
- `GET /v1/quantitative/reports/compare?leftRunId=...&rightRunId=...`
- `GET /v1/quantitative/prompt`

写接口均要求 `Idempotency-Key`。

执行流程：

1. `sync-top30` 使用共享 universe；`fallback=true` 时客户端停止运行。
2. `runs` 校验套餐、当前 Provider 槽位、pool version 和严格 30 只。
3. 客户端按标的调用 `items`；Gateway 为单标的补充官方 SEC/FINRA 缓存证据。
4. 官方源失败后只接受 observation 中当前 Provider 的降级证据。
5. Gateway 调用 Worker 的单标的评分路由，规范化后原子写 item。
6. 30 个 item 都终态后客户端调用 `finalize`。
7. finalize 锁定排名，随后请求可选 Markdown 汇总；模型汇总失败时使用确定性 Markdown。

#### `changfu-backend/apps/gateway/src/server.ts`（修改）

- 注册 `handleQuantitativeResearchRoute`。
- 路由位置与 SELL PUT 并列，继续复用认证、请求中止、Worker URL 和 internal token。

### Phase 5：Decision Worker 单标的评分

#### `changfu-backend/apps/decision-worker/src/quantitativeScoreNormalizer.ts`（新增）

- 使用独立 JSON Schema 校验。
- 验证 evidence/counterEvidence ID 属于单标的 catalog。
- 校验 availability 与输入层可用性一致，模型不能把缺失层标为 AVAILABLE。
- 校验分项上限，服务端计算 total 和 coverage。
- 拒绝任何交易字段。

#### `changfu-backend/packages/domain/src/quantitativePrompt.ts`（新增）

Prompt v1 固定：

- 一次只评估一个授权标的。
- 使用五维锚定量表，不与其他标的作隐式比较。
- 不得把 short volume 等同 short interest。
- 内部人出售不自动判定为负面，必须结合交易类型和持仓变化。
- 宏观分数必须解释该公司的行业/久期敏感性，不能只复述全市场事件。
- 数据缺失不得估算或重新分配权重。
- 只引用提供的证据 ID。

#### `changfu-backend/apps/decision-worker/src/server.ts`（修改）

新增内部路由：

- `POST /internal/v1/quantitative/score`
- `POST /internal/v1/quantitative/summarize`

单标的评分使用温度 0、独立 request ID 和现有官方模型配置。汇总路由只接收已经锁定的规范化摘要，明确禁止修改排名和分数。

### Phase 6：macOS 执行状态与 API Client

#### `changfu-desktop/macos/Infrastructure/BackendClient.swift`（修改）

新增量化 pool/run/item/finalize/latest/history/detail/compare 方法：

- 单 item 请求使用独立幂等键和请求超时。
- finalize 使用独立幂等键。
- GET 继续使用 Provider 和用户归属校验。

#### `changfu-desktop/macos/App/AppState.swift`（修改）

新增按 Provider 隔离的：

- `quantitativeReports`
- `quantitativeReportHistories`
- `quantitativePools`
- `quantitativeRunStates`
- completed/total/status message

`startQuantitativeReport()`：

1. 校验套餐与当前 Provider 槽位。
2. 同步并锁定当日 Top30；fallback 时停止。
3. 采集一次当前 Provider 宏观快照。
4. 对 30 只标的创建独立任务；每票独立采集并独立调用 item API。
5. Futu 和 Longbridge 分别采用受控批大小，避免触发本地接口限流；失败不取消同批。
6. 收齐 30 个终态后 finalize。
7. 成功后切换“策略中心 → 报告”，并定位量化研究。

状态按发起 Provider 回写；切换 Provider 不丢失另一侧进度。

### Phase 7：研究页与报告中心 UI

#### `changfu-desktop/macos/Domain/ResearchModels.swift`（修改）

- 保留 `@量化研究` 对话能力及其现有 `research-quantitative-v1`，避免破坏普通对话契约。
- 为量化卡片增加独立执行 prompt/scoring version 展示。
- 文案改为“基于当日全球市值 Top30，融合基本面、申报事件、卖空、宏观和价格趋势形成可复核选股排名”。
- 清单改为五层证据。

#### `changfu-desktop/macos/App/FutuWorkspaces.swift`（修改）

量化研究卡新增：

- “执行量化选股”按钮。
- 30 只进度条与状态文本。
- 数据源说明随当前 Provider 显示：
  - Futu：SEC/FINRA + Futu OpenD。
  - Longbridge：SEC/FINRA + Longbridge。
- 明确显示“不使用 Yahoo，不跨券商补数”。
- 保持与 SELL PUT 卡双列顶部对齐、同行等高。

#### `changfu-desktop/macos/App/QuantitativeResearchWorkspace.swift`（新增）

报告视图：

- 摘要：Provider、生成时间、Top30 pool version、prompt/scoring version、有效评分数、缺口数、官方源状态。
- Top5 候选。
- 观察组。
- Bottom5 风险。
- 数据不足列表。
- 全量 30 只固定列宽斑马纹表格。
- 表格列：排名、标的、总分、基本面、申报、卖空、价格、宏观、覆盖度、状态、详情。
- 行内不展开；点击行打开独立详情弹窗。
- 详情弹窗成对展示证据/反证，另列风险、数据缺口、失效条件和逐字段来源时间。
- 完整 Markdown 使用独立弹窗。
- “对比报告”打开历史报告选择器和确定性差异弹窗。

#### `changfu-desktop/macos/App/FutuWorkspaces.swift` 的 `StrategyCenterWorkspace`（修改）

- “量化研究”范围渲染 `QuantitativeResearchReportModule`。
- “全部报告”同时渲染量化与 SELL PUT，模块之间保持无嵌套卡片的全宽分区。
- `.task(id: currentProviderId)` 同时刷新两类报告，互不清空。

### Phase 8：文档同步

修改：

- `.trae/documents/changfu_desktop_architecture_plan.md`
- `.trae/documents/futu_opend_skills_reference.md`
- `.trae/documents/longbridge_skills_reference.md`

补充：

- 量化选股 Provider 隔离与官方源优先/当前券商 fallback。
- 每标的独立模型请求。
- 五维评分、覆盖门槛和模型/服务端职责。
- 手动异券商报告对比。
- Yahoo 和跨券商补数禁令。

## Data Flow

```text
研究页点击执行
  -> 同步当前 Provider 的当日 Top30 独立池
  -> 创建 Quant Run
  -> 当前券商采集一次宏观快照
  -> 30 个独立任务
       -> 当前券商单票行情/财务/事件/卖空降级数据
       -> Gateway 读取 SEC/FINRA 当日缓存，必要时请求官方源
       -> 合并为单票 evidence catalog
       -> Worker 单票模型评分
       -> Schema/证据/分数边界校验
       -> 原子写入单票终态
  -> 30 票均终态
  -> 服务端求和、覆盖门禁、稳定排序
  -> 汇总模型只解释锁定结果，失败则确定性 Markdown
  -> 持久化 Futu 或 Longbridge 独立报告
  -> 策略中心展示
```

手动对比：

```text
当前报告 -> 点击对比 -> 选择另一 Provider 历史报告
  -> 服务端验证归属/Provider/版本
  -> canonical ticker 对齐
  -> 确定性计算分数、排名、来源和缺口差异
  -> 并排差异弹窗
```

## Failure Modes

- Top30 排名源失败：停止本次运行，不使用 seed 生成报告。
- SEC 未配置真实 User-Agent：官方 SEC 标记不可用，进入当前券商 fallback。
- SEC/FINRA 网络失败：使用同日有效缓存；无有效缓存时进入当前券商 fallback。
- 当前券商未连接/未授权：启动前失败关闭，不创建空报告。
- 当前券商某能力不可用：仅该层 PARTIAL/UNAVAILABLE，保留明确缺口。
- 单票采集失败：写 `UNAVAILABLE` item，继续其他标的。
- 单票模型失败：有限重试后写 `REJECTED`，继续其他标的。
- 客户端中断：run 保持可恢复状态；再次进入时读取 status，允许继续未终态 item 或显式取消。
- pool version 在运行中变化：item/finalize 返回冲突，禁止混合两个池版本。
- 汇总模型失败：使用确定性 Markdown，不改变已完成排名。
- 比较两份版本不一致报告：显示版本警告，不伪装为同口径结论。

## Verification

### Backend/domain

- Top30 解析、股权类别合并、跨市场映射与 fallback 失败关闭测试。
- 五维分数边界、服务端求和、稳定排序和覆盖门槛测试。
- short-volume z-score 黄金样例，验证不混用 short interest。
- SEC point-in-time 样例：重述、季度/累计值、`filed <= capturedAt`。
- 30 个 item 独立幂等、重复提交、pool version 冲突和 finalize 原子性。
- 单票失败不取消其余 29 票。
- Provider 归属隔离：Futu run 拒绝 Longbridge observation，反之亦然。
- 报告对比只能同用户、异 Provider；canonical ticker 正确对齐。
- 源码和 prompt 中不存在 Yahoo 请求路径。

运行：

- `cd changfu-backend && npm run check`
- `cd changfu-backend && npm run build`
- PostgreSQL migration/integration 测试。

### Worker

- 评分 Schema 黄金样例和恶意输出测试。
- 证据 ID 越界、分数越界、availability 伪造、交易字段注入均拒绝。
- 30 个请求上下文互不包含其他标的数据。
- 汇总模型不能修改服务端锁定排名。

### Desktop/domain

- Futu/Longbridge observation 编解码测试。
- 每标的独立 request ID 和独立 API 调用测试。
- Provider 切换时运行态、当前报告和历史互不污染。
- 取消、重试、恢复和 pool version 冲突状态测试。
- Longbridge Host argv 白名单测试，确认不能执行任意 CLI 或交易命令。
- Futu 不支持的财务/卖空能力返回显式缺口，不导致解码失败。

运行：

- `cd changfu-desktop/macos && swift run ChangFuDesktopTests`
- `cd changfu-desktop/macos && swift build`
- `changfu-desktop/macos/scripts/check-ui-contract.sh`

### UI acceptance

- 1440×900 和当前大屏分辨率下，研究页双列卡片无溢出、无高度跳动。
- 量化卡在 Futu/Longbridge 页面显示正确独立数据源文案。
- 执行按钮在无套餐、Provider 未绑定、券商未连接或已有同 Provider 任务运行时禁用并显示具体原因。
- 进度从 0/30 单调更新到 30/30；单票失败仍能 finalize。
- 策略中心“量化研究”展示真实报告，不构造示例数据。
- Top5、观察组、Bottom5、全量明细使用固定列宽和斑马纹；详情使用独立弹窗。
- 手动对比只列出另一 Provider 历史报告，不自动触发比较或模型请求。
- 中文界面不出现英文技术枚举；`PARTIAL/UNAVAILABLE` 映射为专业中文状态。

### Live data acceptance

Futu：

- OpenD 已连接时获得前复权日 K、快照、经济日历/FedWatch、财报日历和 NOTICE。
- 官方 SEC/FINRA 可用时形成完整相应层。
- 官方源断开后只使用 Futu fallback，并如实降低覆盖度。

Longbridge：

- 已授权账号可返回财务、Filing、Form 4、short trades/positions、宏观日历、报价和前复权日 K。
- 官方源断开后只使用 Longbridge fallback。

共同：

- 同日二次运行复用官方缓存但刷新券商数据。
- Futu 与 Longbridge 报告可分别完成，分数、来源和缺口可通过手动对比解释。
- 任一日志、数据库错误或报告中不包含券商密钥、访问令牌或完整模型凭据。

## Assumptions & Locked Decisions

- 面向用户：使用 Futu 或 Longbridge 的专业美股研究用户。
- Top30 口径：复用 SELL PUT 当前定义，不改成仅美国注册公司。
- 排名源：继续使用现有 StockAnalysis 当日来源；不可用时停止，不以静态 seed 继续。
- 选股权威：模型生成五维分项，服务端校验、求和和排序。
- 价格层：保留，宏观层用于公司暴露适配，不单独用全市场共同变量决定排名。
- 执行方式：手动执行，同日官方缓存。
- 报告用途：只读研究 Top5，不进入交易候选池。
- Provider：两份报告完全独立，不跨券商补数。
- 对比：用户手动选择另一券商报告，确定性比较，不调用模型。
- 官方源：允许 SEC/FINRA；连接不通后回退当前券商。
- 禁用数据源：Yahoo 及其他网页私有行情源。
- 每个标的必须是独立采集、独立模型请求和独立结果；不把 30 只股票压入一个评分请求。
- 普通 `@量化研究` 对话能力保持现有版本；Top30 报告使用新的独立 prompt/scoring version。
- 首版不增加定时调度、自动通知、回测、交易候选或订单能力。
