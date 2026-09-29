# 长富 SELL PUT 30 日研究模块

## 目标

在 macOS 客户端提供与 Web 端 30 日报告同源的研究能力。该能力属于“研究”页的 SELL PUT 期权研究模块，使用自动同步的美股 Top30 专属标的池，报告统一进入“策略中心 → 报告”。

## 产品边界

- 固定入口：只允许从“研究”页的 SELL PUT 期权研究模块直接执行，不新增左侧一级入口。
- 套餐门禁：只有有效套餐且当前券商已绑定到有效槽位时才允许执行；客户端按钮、启动函数和 Gateway 写接口均失败关闭。
- 专属标的池：以 StockAnalysis 当日在 NYSE/NASDAQ 交易的全球市值排名为准，合并 Alphabet、Berkshire 等重复股权类别后固定 30 家；不复用套餐研究池。
- 数据源一致：正股快照、估值、260 根日 K 技术指标、期权链、Greeks 和期权报价均通过 Futu OpenD 获取；来源不可用时失败关闭。
- 独立运行：一次报告覆盖池内全部标的，但每个标的由客户端发起独立、并发的数据采集请求。
- 统一归档：报告运行、逐标的原始快照、分析结果和 Markdown 均落库，并在“策略中心 → 报告”查看。
- 失败关闭：缺期权链、权利金、Delta、IV 或流动性字段时，只记录数据缺口，不生成候选。
- 提示词一致：最终 Markdown 由 Decision Worker 使用 Web `Top 30 Mega-Cap Cash-Secured Put 分析 Prompt v3` 同源约束生成。

## 数据流

1. 客户端调用 `/v1/sell-put/pools/FUTU/sync-top30`，Gateway 获取并锁定当日 Top30，原子更新 SELL PUT 专属池版本。
2. 用户在研究页的 SELL PUT 期权研究模块启动 30 日报告。
3. 客户端按每批 8 个、批间 31 秒针对 30 个标的调用本地 Futu BrokerHost；每个标的拥有独立 `requestId`，分别采集正股快照、260 根日 K、目标到期日期权链及期权快照。每批开始显示起止序号，完成 30 个 observation 后立即进入报告生成状态；单标的 180 秒预算耗尽时保留原 `requestId` 并生成不可用 observation。
4. 客户端将每个标的的独立 observation 一次提交到 `/v1/sell-put/reports`。
5. Gateway 使用 `sell_put_research_pools` 和 `sell_put_research_pool_items` 校验专属池版本及 30 个标的，计算确定性规则基线。
6. Decision Worker 使用 Prompt v3、逐标的 OpenD 原始数据和规则基线生成 Markdown；Gateway 持久化报告及逐标的结果。
7. 客户端成功后进入策略中心报告模块展示结果。

## API

- `GET /v1/sell-put/pools/FUTU`
- `POST /v1/sell-put/pools/FUTU/sync-top30`
- `POST /v1/sell-put/reports`
- `GET /v1/sell-put/reports/latest?provider=FUTU`
- `GET /v1/sell-put/reports/history?provider=FUTU&page=1&pageSize=10`
- `GET /v1/sell-put/reports/{runId}`
- `GET /v1/sell-put/prompt`

所有写请求要求 `Idempotency-Key`。所有查询以访问令牌中的用户 ID 为边界。
同步专属池、修改专属池和创建报告还必须实时校验有效套餐及当前 Provider 槽位；
无权益时返回 `SELL_PUT_ENTITLEMENT_REQUIRED`，不得访问外部排名源或启动数据采集。

SELL PUT 专属池只由同步接口维护，不提供独立一级 Tab 或用户手工编辑入口。

## 报告契约

逐标的结果包含：

- 当前价、市值、PE、RSI14、MA50/200、20/60/120 日趋势、52 周位置、30 日实现波动率
- 30 日涨跌、到期日、行权价
- 安全边际、权利金、年化收益、现金占用
- IV、Delta、买卖价差、成交量、未平仓量
- 是否候选、评分、风险与退出条件
- 数据缺口及采集时间

摘要包含可用性、Top 5 候选、Bottom 5 风险、数据质量计数和 Markdown。最新报告默认展开摘要，逐标的详情按需展开。

## 验收

- 左侧导航保持今日总览、市场、研究、交易、资产、策略中心六项，不出现 SELL PUT 一级 Tab。
- 研究页可直接执行 SELL PUT 研究，且只使用自动同步的 Futu Top30 专属池。
- 未配置套餐、套餐失效、权益读取失败或当前券商未绑定时执行按钮禁用，且显示可操作的具体原因。
- 每次运行严格包含 30 个标的，并产生 30 个独立并发采集请求和 30 个独立 `requestId`。
- 第四批开始时状态从“已采集 24/30”更新为“正在采集 25-30/30”，全部采集完成后显示“已采集 30/30，正在生成报告”；取消等待不得被吞掉。
- Futu 市场前缀必须幂等规范化，`US.US.*`、`HK.HK.*` 不得进入标的池或报价匹配链路，`US.BRK.B` 等合法代码保持不变。
- StockAnalysis 当日来源不可用时停止生成，不将静态兜底名单伪装为当日 Top30。
- Prompt 标题、系统约束、Raw Data、Top 5/Bottom 5 和禁止估算权利金规则与 Web Prompt v3 一致。
- 完整期权字段可生成候选；缺 Delta 或流动性字段不得生成候选。
- 报告、逐标的原始数据和分析结果均可从数据库恢复，并在策略中心报告模块查看。
- Gateway 测试、Swift 测试、构建和本地启动通过。
