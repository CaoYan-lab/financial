# 长桥扩展时段持仓现价修复

## 问题

长桥 Node SDK 的证券报价同时包含：

- `lastDone`：常规交易时段最新成交价。
- `preMarketQuote.lastDone`：盘前最新成交价。
- `postMarketQuote.lastDone`：盘后最新成交价。
- `overnightQuote.lastDone`：夜盘最新成交价。

账户持仓聚合此前始终读取 `lastDone`。美股盘前时，该字段可能仍是上一交易日常规盘价格，导致持仓表、市值、未实现盈亏和模型账户上下文使用错误价格。

TQQQ 复现场景：

- 成本：`70.16`
- 常规盘价格：`67.93`
- 盘前价格：`70.15`
- 数量：`13`

错误链路显示市值 `883.09` 和未实现盈亏 `-28.99`；正确口径应为市值 `911.95`、未实现盈亏 `-0.13`。

## 修复

统一使用 `latestQuotePrice` 按纽约市场当前时段选择价格：

- 盘前优先 `preMarketQuote`。
- 盘中使用 `lastDone`。
- 盘后优先 `postMarketQuote`。
- 夜盘优先 `overnightQuote`。
- 同时保留对 CLI 返回的蛇形字段和旧字段格式的兼容。

以下两条账户链路均复用该选择器：

- 全局长桥账户：`api/longbridge/longbridgeSdkGateway.ts`
- 多用户长桥账户：`api/cloud/multiuser/longbridge/tenantDataService.ts`

选出的时段现价用于持仓市值、今日盈亏和未实现盈亏计算，并进入后续模型账户上下文。

## 验收

- 盘前 TQQQ 持仓现价为 `70.15`，不再使用 `67.93`。
- 数量 `13` 时市值为 `911.95`。
- 成本 `70.16` 时未实现盈亏为 `-0.13`。
- 昨收 `67.93` 时持仓今日盈亏为 `28.86`。
- 盘中仍使用常规盘 `lastDone`。
