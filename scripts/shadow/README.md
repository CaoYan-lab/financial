# 双券商提示词影子测试

只生成合成数据并调用模型推理接口，不连接券商、不读真实持仓、不下单、不撤单、不修改实盘提示词选择。

当前范围为 Longbridge 和 Futu，各 16 个场景，覆盖单票、组合和挂单三个角色。Futu 的规范化风险状态是合成输入，**不是复用 Longbridge 原始等级编码，也不表示已经完成生产映射**。

## v2.4 候选独立证据

每个组合候选增加 `marketEvidence`：独立的标的/时间/币种、报价、K线、趋势、委托方案和费用；AAPL与MSFT不再共用AAPL行情。晋级必须引用本候选的 `C_候选ID`，不能借用另一标的证据。

`candidateEvidence.mjs` 提供证据一致性校验与排序：通过准入后，先比较成本后收益风险比，再按风险占用、偏离、信号时间、代码ASCII、候选ID排序。相同比率不代表相同预期收益或真实胜率。排名指标在冻结前由各自风险方案计算，不输出预先排序的答案。

预算场景以MSFT在前的反序输入检验模型是否正确按同分规则选择AAPL；原无效交易指标不改，另在审计报告中列 `rankingChecks`，未选择与超时不能算排序通过。

```bash
npx tsx scripts/shadow/freeze.ts .data/shadow-trading/v24-frozen
node scripts/shadow/run.mjs --execute --input .data/shadow-trading/v24-frozen/dataset.json --out .data/shadow-trading/v24-run --concurrency 8
node scripts/shadow/audit.mjs .data/shadow-trading/v24-frozen/dataset.json .data/shadow-trading/v24-run
```

历史版本数据已冻结，当前生成器只产生v2.4，不要用它重新生成或覆盖历史目录。v2.3原始96条响应的旧评分与元数据绑定已验证不受升级影响。

## v2.3 复测

新版单票输出缩减为13字段，三个角色均不再让模型回传快照和版本；请求程序把元数据记录为独立 `binding`，模型原始输出不被补写。证据采用 `evidenceCatalog` 中固定编号，禁止未知编号、任意字段和超长说明。

当前 `compactPrompts.json` 是精简提示词正文，`compactContract.mjs` 同源生成提示词中的 Schema 并进行本地严格校验；**没有声称服务端启用了严格结构化生成**。使用该文件中受限的 Schema 词汇，不支持的关键字抛错，不静默忽略。

v2.3 修正了原持仓失效价与新开仓失效价混淆、账目与盈亏、七日均线区间、噪声末价、过期源时间及风险预留。`validateFacts` 在冻结前检查一致性。旧冻结请求和结果保留，冻结器拒绝覆盖已有数据集。

历史批次存放于 `.data/shadow-trading/v23-frozen/` 和 `.data/shadow-trading/v23-run/`；沿用旧字段校验，不重新调用模型。

相同路径只可恢复同一批次，不同参数/模型/数据必须新建目录。旧批次使用旧字段契约，评估器按冻结事实版本选择；不把新的评分标准回套旧批次。

## 运行

在仓库根目录运行，使用项目已有 Node、tsx 和依赖：

```bash
npx tsx scripts/shadow/freeze.ts
node scripts/shadow/run.mjs
node scripts/shadow/run.mjs --execute --out .data/shadow-trading/full --repeats 2 --concurrency 4
node scripts/shadow/audit.mjs .data/shadow-trading/frozen/dataset.json .data/shadow-trading/full
npm test -- tests/shadowTradingPrompts.test.ts
```

默认仅打印调用计划；加 `--execute` 才调用现有 Ark 推理接口并产生模型费用。默认每场景一次，共 96 次；两次为 192 次。只允许配置好的 Ark HTTPS 推理路径，不接受券商或应用执行接口。

凭据从进程环境或 `.env.local` 使用 dotenv 解析读取，不执行环境文件内容、不打印或写入结果。冻结请求阶段使用独立临时 SQLite 路径，不污染生产运行配置；只调用现有提示词组装函数，不调用请求模型或券商函数。

预检可以限定场景：

```bash
node scripts/shadow/run.mjs --execute --out .data/shadow-trading/pilot --cases financing-warning,qualified-long,cancel-risk-opening
```

同一输出目录可断点续跑，已记录的失败也保留，不自动重试直到“答对”。重新评估须指定新目录。输入摘要、模型或参数变化时拒绝混入旧结果。

默认模型输出上限为 8192 token，可通过 `--max-output-tokens` 在 1024 至 16384 之间显式指定。推理模型的思考与最终正文可能共享输出预算：首轮 2400 token 预检出现截断，因此正式实验统一使用 8192，而不是只为新版放宽。各组请求超时同为 120 秒，不自动重试；默认供应商推理模式未被关闭。

## 三组实验

- `legacy`：分别调用现有 Longbridge/Futu 单票组装器，以及现有组合/挂单组装器。隔离配置使用通用模板，不宣称等于线上领导实例当前请求。
- `legacy_enriched`：原提示词不改，通过 `shadowContext` 补入与新版相同的事实。
- `v2`：当前为 `compactPrompts.json` 中的精简共同指令和角色指令，加券商适配及严格本地输出契约；先前v2.2使用评审文档全文，保留在旧冻结数据中。

使用新旧“同等数据”分组，是为了揭示数据补齐的作用。布局、指令及输出结构也有变化，因此该组并非只测单句文案。三组使用同一模型和参数，采用固定种子打乱调用次序，不把标准答案、标签和预期动作发送给模型。

快照编号使用不含场景语义的散列值。冻结器额外检查场景名、oracle 字段没有进入请求；场景的描述性名称只用于结果报告。早期使用可读场景名的探索批次可能向模型暗示答案，**不得混入正式盲化测试结论**。

## 指标定义

场景标签在调用前定义并冻结：

- 无效交易：违反场景准入、订单冲突、合成成本后机会条件或数量/累计风险预算的开仓及晋级建议。
- 必要减仓对照：记录是否推荐正确方向和合法数量，防止“一律 HOLD”伪装改善。
- 合格机会未选择：不是客观盈利漏单率，仅作为模型是否过度保守的指示。
- 挂单错误：漏撤已确认风险阻断的开仓单，或误撤保护性/状态未知订单。
- 格式失败、接口失败、截断：单独统计，不算正确拒绝交易。v2.3校验固定证据编号、失效价、持仓效果和风险方案；快照、有效期由请求程序绑定并审计。v2.2仍按旧版元数据回传/证据路径校验。
- 配对改善：只统计相同场景/重复轮次下两组都有有效输出的情况，同时展示未完成和不可评估样本，不能隐藏选择偏差。

输出校验服务于实验计分，不是生产执行授权器。Schema校验只实现生成器所用的受限词汇，不是通用JSON Schema引擎。禁止将 `evaluation.evaluable` 或模型 `approved` 用于自动执行。

## 产物

- `frozen/dataset.json`：合成事实、独立判定标签、每组实际请求和摘要。
- `manifest.json`：数据摘要、模型标识、端点、采样和输出限制。
- `responses.jsonl`：每次原始模型文本、解析结果、错误、用量和耗时。
- `summary.json`、`paired.json`、`report.md`：分券商/组别指标及配对结果。
- `audit.json`、`audit.md`：运行审计脚本后生成的逐场景结果、全分母机会/减仓指标及不可评估样本保守范围。

`.data/` 保持忽略，不把凭据或账户数据提交 Git。合成场景由 `scenarios.mjs` 确定性再生成；所有模拟费用及预算仅供实验，不是券商费率或自动批准的生产参数。

## 不可推出的结论

这不是历史行情回测，没有真实成交和后续价格。不计算收益或最大回撤，不宣称减少亏损订单，不以少量合成场景证明策略获利。即使无效建议下降，也需要更广泛独立样本、真实只读快照和后端接入验证，再决定是否替换线上提示词。

新增提示词目前对两家券商均应用于影子请求。生产启用、阈值改变、真实风险字段适配、预算账本及撤单策略，均需单独完成与验收。
