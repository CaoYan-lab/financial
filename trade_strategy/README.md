# Trade Strategy 配置目录

本目录保存交易策略、风控规则、LLM Prompt 与上下文规则的版本化配置。

配置文件是版本源；SQLite 只保存实盘和模拟盘当前选择的 `strategyId` 与 `promptPackId`。前端只允许选择和查看，不直接编辑 YAML。

## 目录

- `strategies/`: 交易策略与后端风控配置。
- `prompt_packs/`: 大模型 system prompt、hard constraints、上下文规则和 required JSON 描述。
- `docs/`: 策略说明文档。
- `schemas/`: 配置结构说明。

## 安全原则

- 实盘策略选择不会绕过 `LIVE_TRADING_ENABLED` 门禁。
- 实盘真实订单仍必须人工二次确认。
- 如果配置加载失败，后端应 fail-closed：禁止新开仓，仅允许降低风险动作。
- 默认策略不是任何机构的私有策略，而是基于公开机构风控原则抽象出的工程化兜底框架。
