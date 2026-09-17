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
- 兼容 Node SDK 的 `Decimal` 返回值和原型 getter；禁止仅用字符串夹具验证 SDK 行为。

以下两条账户链路均复用该选择器：

- 全局长桥账户：`api/longbridge/longbridgeSdkGateway.ts`
- 多用户长桥账户：`api/cloud/multiuser/longbridge/tenantDataService.ts`

选出的时段现价用于持仓市值、今日盈亏和未实现盈亏计算，并进入后续模型账户上下文。

## 生产回归与补救

首次修复的测试把 SDK 价格伪造为字符串，但真实 Node SDK 的 `lastDone`、`prevClose` 和扩展时段 `lastDone` 均为 `Decimal` 对象。统一解析器当时只接受字符串和数字，导致生产环境所有持仓价格被错误标记为不可用。

补救措施：

- `numberValue` 通过 SDK 对象的 `toString()` 解析 `Decimal`。
- 回归测试改用原型 getter 和类 `Decimal` 对象，贴近真实 `SecurityQuote`。
- 同一个报价对象分别验证盘前、常规盘、盘后和夜盘，确保价格随纽约市场时段动态切换。
- 全局账户与租户账户测试都使用类 `Decimal` 报价，确保传入模型的 `Position.currentPrice`、市值和盈亏不再降级为不可用。

## 验收

- 盘前 TQQQ 持仓现价为 `70.15`，不再使用 `67.93`。
- 数量 `13` 时市值为 `911.95`。
- 成本 `70.16` 时未实现盈亏为 `-0.13`。
- 昨收 `67.93` 时持仓今日盈亏为 `28.86`。
- 盘中仍使用常规盘 `lastDone`。
- 盘后使用 `postMarketQuote.lastDone`，夜盘使用 `overnightQuote.lastDone`。
