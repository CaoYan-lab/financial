# Futu OpenD Skills 参考摘要

来源：`https://openapi.futunn.com/skills/opend-skills.zip`

已验证 zip 包包含：
- `skills/futuapi/SKILL.md`
- `skills/install-futu-opend/SKILL.md`
- `skills/futuapi/docs/API_REFERENCE.md`
- `skills/futuapi/docs/FIELD_MAPPING.md`
- `skills/futuapi/docs/TROUBLESHOOTING.md`

## futuapi

- 用途：富途 OpenAPI 行情、期权、交易、账户、实时订阅助手。
- 前提：OpenD 运行且版本 >= `10.4.6408`，默认 `127.0.0.1:11111`。
- Python SDK：`futu-api >= 10.4.6408`。
- 股票代码：美股使用 `US.AAPL`、`US.NVDA`、`US.TSM` 等格式。
- 本项目仅使用行情能力，不使用交易、下单、撤单、解锁交易等能力。

## install-futu-opend

- 用途：下载安装 Futu OpenD 并升级 Python SDK。
- macOS 下载地址由官方重定向提供：`https://www.futunn.com/download/fetch-lasted-link?name=opend-macos`
- GUI 版默认 API 地址：`127.0.0.1`
- GUI 版默认 API 端口：`11111`
- 使用前需要用户在 OpenD GUI 中手动登录。

## API 能力映射

- `get_market_snapshot(code_list)`：市场快照，无需订阅，最多 400 个标的。
- `request_history_kline(...)`：历史 K 线，用于 RSI、50MA、200MA 计算。
- `get_option_chain(...)`：获取期权链静态信息。
- `get_market_snapshot(option_codes)`：获取期权 IV、Delta、strike、contract size 等快照字段。
- `get_global_state()`：可用于判断 `qot_logined` 等连接状态。

## 安全约束

- 禁止通过 SDK 调用 `unlock_trade`。
- 禁止在本项目中暴露交易 API。
- 实盘交易不属于本应用范围。
- OpenD 必须由用户手动登录。

