# Longbridge 自动回补停留待确认修复

## 云端证据

- `longbridge_live.execution_controls.autoSubmitEnabled=true`，Worker 快照同时显示 `liveTradingEnabled=true`。
- GOOG 持仓为 `quantity=-1`，Longbridge SDK 返回 `availableToClose=-1`。
- GOOG `BUY 1` 回补订单均停留在 `PENDING_CONFIRMATION`，没有系统确认记录或提交结果。

## 根因

`finalAccountOrderFailure()` 将 `availableToClose` 限定为非负数。Longbridge 对空头持仓返回带方向符号的可平量 `-1`，导致合法的 `BUY 1` 回补被误判为“可平量未知或平仓数量超限”。

同时，Longbridge 引擎忽略 `confirmPendingOrder()` 的失败结果，既不记录日志，也不更新订单状态，因此界面只能显示普通“待确认”，掩盖了自动提交已经被门禁拦截。

## 修复

1. 在 Longbridge SDK/CLI 持仓适配层将可平量统一为非负股数，并让公共最终风控兼容空头的带符号可平量。
2. 系统自动提交被前置门禁拒绝时，将订单持久化为 `BLOCKED_BY_RISK`，把具体原因写入风险提示。
3. 引擎记录自动提交成功/失败结构化日志，并返回提交后的真实订单状态。
4. 历史信号从关联订单的风险提示恢复风控拦截原因。
5. 提示词和页面文案按运行时自动提交设置表达，不再固定声明“仅人工确认”。
6. Worker 成为 Leader 后先从 PostgreSQL 水合交易设置，再恢复期望为运行中的引擎，避免重启首轮使用环境默认值。

## 安全边界

- 不放宽账户快照、持仓可平量、行情时效、价格偏离、市场时段、跨进程锁和真实交易总开关。
- 不重试或提交已经由用户批量过期的历史订单。
- 本地测试不得调用真实券商下单。

## 验证

- TypeScript 类型检查通过。
- ESLint 通过。
- 生产构建通过。
- 全量测试：89 个测试文件通过，560 项通过，1 项按条件跳过，无失败。
