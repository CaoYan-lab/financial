# Debug Session: cloud-risk-unknown
- **Status**: [OPEN]
- **Issue**: 云端全局 Longbridge 美股决策仍输出 openingRiskStatus=UNKNOWN，availableRiskBudget=0。
- **Debug Server**: http://127.0.0.1:7777/event
- **Log File**: .dbg/trae-debug-log-cloud-risk-unknown.ndjson

## Reproduction Steps
1. 云端 Worker 执行全局 Longbridge 美股自动评估。
2. 查看 TSLA、TSMU、TSM 等标的的最新模型决策。
3. 观察 openingRiskStatus 与 availableRiskBudget。

## Hypotheses & Verification
| ID | Hypothesis | Likelihood | Effort | Evidence |
|----|------------|------------|--------|----------|
| A | 云端实际请求走全局 Longbridge，而前次只修复了租户 Longbridge | High | Low | CONFIRMED：截图对应记录不在 multiuser.longbridge_events；全局引擎仍按批次复用账户 |
| B | Longbridge 账户风险字段本身缺失 | Medium | Low | REJECTED：云端实测 riskLevel=0，规范化结果 ALLOWED |
| C | 全局批量扫描复用批次开头快照，串行模型排队后超过 60 秒 | High | Low | CONFIRMED：runPoolOnceDryRun 将同一 account 传给全部标的，模型并发为 1 |
| D | 旧待确认订单缺少失效价时被按无限风险处理，导致全组合 availableRiskBudget=0 | High | Low | CONFIRMED：reservedPendingRisk 遇到旧订单缺字段直接返回 Infinity |
| E | Longbridge SDK 账户刷新失败 | Low | Low | REJECTED：云端 force=false/true 均读取成功，耗时 1259ms/403ms |

## Log Evidence
- Cloud Longbridge account probe at 2026-09-14T15:13:31Z:
  - `ok=true`, `financingRiskLevel=0`, `financingOpeningRestricted=false`.
  - `productionAccountRisk("longbridge", account, 0)` returned `openingRiskStatus="ALLOWED"`.
  - USD equity was `$14,472.82`; max portfolio loss budget was `723.641`.
- `runPoolOnceDryRun()` loads USD/HKD account snapshots before starting the ticker loop and passes them through `options.account`.
- Longbridge evaluation concurrency is 1. Later tickers can therefore reach the prompt after the 60-second freshness window.
- Existing legacy pending orders without `promptAudit.output.invalidationPrice` caused `reservedPendingRisk()` to return `Infinity`, reducing available risk budget to zero for every ticker.

## Verification Conclusion
- Root cause confirmed in the global Longbridge engine, not Futu and not the tenant Longbridge engine.
- Fix implemented:
  - remove batch-level Longbridge account reuse;
  - force one account refresh at each ticker's final prompt boundary;
  - skip the model when the refreshed account is unavailable or financing risk remains unknown;
  - reserve one configured per-trade loss budget for legacy pending orders whose invalidation price is unavailable, instead of reserving infinite risk.
- Automated verification:
  - 87 test files passed;
  - 538 tests passed and 1 integration test skipped by configuration;
  - TypeScript production build passed.
- Cloud verification remains pending deployment and a new Longbridge evaluation cycle.
