# 双券商新版提示词生产接入

## 当前模式

Futu 与 Longbridge 均支持三种模式：

- `legacy`：调用旧版决策服务，提示词来自当前选中的 `trade_strategy/prompt_packs/*.yaml`。
- `shadow`：使用真实上下文调用新版生产提示词，只保存审计结果，不产生可执行授权。
- `live`：使用真实上下文调用新版生产提示词；模型结果必须继续通过契约、政策、快照时效、后端硬风控、重新采样与原子提交校验。

页面“交易提示词”开关是模式的唯一控制入口。Futu 与 Longbridge 独立保存模式，单票、组合、挂单三个角色显示各自有效模式。环境变量覆盖存在时页面只读并明确显示覆盖来源；非法配置失败关闭，不回退旧版。

## 展示与调用一致性

“实盘策略与提示词版本”区域必须展示当前真正发送给模型的提示词版本：

- 切换到旧版后，提示词下拉展示当前旧版 YAML Prompt Pack，允许在旧版 Prompt Pack 之间选择；展开全文展示对应 YAML。
- 切换到新版影子或新版实盘后，提示词下拉展示 `dual-broker-production-v2.4.1-1` 并禁用旧版 Prompt Pack 选择；展开全文分别展示单票、组合和挂单的生产指令。
- 模式切换成功后，页面通过同一 `prompt-mode` 响应立即更新展示，不依赖刷新页面。
- 新版展示与模型请求共同调用 `productionPromptInstruction()`，不是复制的说明文本。生产版本、券商身份、角色和影子/实盘语义均来自后端。

相关代码：

- `api/live/tradingPromptV2.ts`：新版生产指令、输入契约、输出契约、校验和审计。
- `api/live/tradingPromptReleaseService.ts`：模式持久化、有效模式解析及当前生产提示词元数据。
- `api/live/liveTradingDecisionService.ts`：Futu 单票模式分流。
- `api/longbridge/longbridgeLiveDecisionService.ts`：Longbridge 单票模式分流。
- `src/components/trading/TradingPromptModePanel.tsx`：模式切换。
- `src/components/trading/TradeStrategyConfigPanel.tsx`：当前实际提示词版本和全文展示。

## 配置优先级

持久化模式用于日常页面切换。以下环境变量仅作为部署覆盖，优先级从高到低：

1. `{BROKER}_{ROLE}_PROMPT_MODE`
2. `{BROKER}_PROMPT_MODE`
3. `TRADING_PROMPT_MODE`
4. 本地或云端持久化模式
5. 未配置时默认 `legacy`

其中 `BROKER` 为 `FUTU` 或 `LONGBRIDGE`，`ROLE` 为 `SINGLE`、`PORTFOLIO` 或 `MANAGED`。可选值为 `legacy|shadow|live`。

## 真实数据与风控

- 输入来自当前券商账户、持仓、行情、趋势、订单和策略配置，不使用固定测试价格或预算。
- 来源时间不改写为当前时间；账户或行情快照超过有效期时，可执行动作被阻断。
- Longbridge 使用 SDK 返回的融资风险等级；Futu 使用 OpenD 的 `exposure_level`、`risk_status`、融资权益、初始保证金和维持保证金进行规范化。
- `openingRiskStatus` 只可能为 `ALLOWED`、`BLOCKED` 或 `UNKNOWN`。`UNKNOWN` 表示字段缺失、币种不匹配或快照过期，不等于券商接口报错。
- 无完整组合风险预留账本时，可用风险预算保持未知；购买力不能替代最大亏损预算。
- 模型输出使用严格契约，保留失效价、退出条件、持仓效果、证据编号及跟进动作。
- 新版实盘模型返回不是订单提交许可。提交前仍需刷新账户和行情，校验可平数量、价格偏离、风险预算、订单冲突及券商权限。
- 审计写入受限本地目录，普通日志不输出完整账户上下文或模型原文。

## 实盘执行边界

- Futu 不允许正股卖空自动提交。
- A 股不使用这套双券商美股/港股提示词。
- 止损字段是决策契约，不代表系统已创建止损单。
- 自动下单和自动撤单由独立门禁控制；切换提示词不会绕过这些门禁。
- 影子模式不会创建候选订单、组合晋级或撤单授权。

## 验证记录

2026-09-13 已完成当前 20 个交易标的 × Futu/Longbridge × 旧版/新版的 80 项真实模型矩阵。测试独立禁用订单队列和券商提交：

- 旧版请求命中旧版决策服务，原始输出不含新版审计对象。
- 新版请求命中 `dual-broker-production-v2.4.1-1`，保存完整审计、契约和政策校验结果。
- 修正版风险输入：Futu 20/20 为 `BLOCKED`，Longbridge 20/20 为 `ALLOWED`，不存在 `UNKNOWN`。
- Futu `07747` 的新版减仓建议因模型耗时 107 秒导致快照过期，被最终门禁阻断；未提交订单。
- 对比结果保存于 `.data/trading-prompt-comparison.sqlite3`，并在两个实盘页面展示。

修正版报告：

`.trae/documents/prompt_version_matrix_prompt-matrix-2026-09-13T15-03-48-979Z-3dedafbe.md`

旧的 `prompt-matrix-2026-09-13T14-40-05-116Z-33925d0b` 报告已作废，原因是测试脚本复用了超过60秒的账户快照。
