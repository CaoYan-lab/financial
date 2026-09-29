# Debug Session: risk-budget-zero
- **Status**: [OPEN]
- **Issue**: Longbridge 本地新版提示词上下文出现 availableRiskBudget=0，并伴随 07747 持仓未知。
- **Debug Server**: pending
- **Log File**: .dbg/trae-debug-log-risk-budget-zero.ndjson

## Reproduction Steps
1. 启动本地 Web 5173 与 Worker 4102。
2. Longbridge 提示词模式选择新版实盘。
3. 等待港股单票评估生成 07709、09660、07747 信号。
4. 检查模型上下文中的 riskState、待确认订单和持仓知识状态。

## Hypotheses & Verification
| ID | Hypothesis | Likelihood | Effort | Evidence |
|----|------------|------------|--------|----------|
| A | 待确认订单按错误风险值耗尽预算 | High | Low | Pending |
| B | 终态或过期订单风险未释放 | High | Low | Pending |
| C | 并发评估重复累计风险预留 | Medium | Medium | Pending |
| D | 港股账户币种或持仓快照映射错误 | Medium | Medium | Pending |
| E | 后端预算正确，仅模型文字误判 | Low | Low | Pending |

## Log Evidence
Pending.

## Verification Conclusion
Pending.
