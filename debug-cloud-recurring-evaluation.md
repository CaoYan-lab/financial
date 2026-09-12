# Debug Session: cloud-recurring-evaluation
- **Status**: [OPEN]
- **Issue**: 云端多用户 Longbridge 开启评估后只运行一轮；需同时确认 admin 是否停止周期评估。
- **Debug Server**: Pending
- **Log File**: `.dbg/trae-debug-log-cloud-recurring-evaluation.ndjson`

## Reproduction Steps
1. 云端 `chuangye` 绑定并验证 Longbridge 凭据。
2. 开启 Longbridge 实盘评估。
3. 观察仅产生一轮策略信号，后续无方舟 DeepSeek 请求。
4. 对比 admin 引擎心跳、任务与策略信号时间线。

## Hypotheses & Verification
| ID | Hypothesis | Likelihood | Effort | Evidence |
|----|------------|------------|--------|----------|
| A | 多用户 `desired` 未保持 `running`，周期调度条件不成立 | High | Low | Rejected: `desired=running` |
| B | `run_once` 去重条件持续命中，后续任务未入队 | Medium | Low | Rejected: 约每分钟持续入队 |
| C | 首轮任务失败或卡在 `running`，阻塞后续任务 | Medium | Low | Confirmed: 11/13 轮因 Longbridge `429003` 失败 |
| D | Worker leader 切换后多用户定时器未启动 | Medium | Medium | Rejected: leader 和租户心跳持续更新 |
| E | admin 引擎恢复或扫描定时器也未运行 | Medium | Medium | Inconclusive: admin 当前为 `stopped` |

## Log Evidence
- `.dbg/trae-debug-log-cloud-recurring-evaluation.ndjson:1`：租户状态为 `running/live`。
- `.dbg/trae-debug-log-cloud-recurring-evaluation.ndjson:2`：13 个周期任务持续入队，2 个成功、11 个失败。
- `.dbg/trae-debug-log-cloud-recurring-evaluation.ndjson:3`：失败原因为 Longbridge `429003`，要求两次调用至少间隔 0.02 秒。
- `.dbg/trae-debug-log-cloud-recurring-evaluation.ndjson:4`：Worker leader 与租户心跳正常。
- `.dbg/trae-debug-log-cloud-recurring-evaluation.ndjson:5`：admin Longbridge/Futu 当前均为 `stopped`。

## Verification Conclusion
多用户周期调度没有停止。根因是同一租户 SDK Context 内并发发起多个
Longbridge 请求，违反 20ms 最小调用间隔；失败发生在模型调用前，因此方舟
没有收到后续请求。admin 当前未开启，不能用现网运行态验证是否存在同类问题。

## Fix
- 为每个 Longbridge SDK 账户 Context 增加共享调用队列。
- 行情与交易查询跨 Context 串行执行，相邻调用至少间隔 30ms。
- 同一限频器同时用于多用户 Context 和 admin SDK Gateway。
- 新增队列间隔与失败恢复测试。

## Post-Fix Verification
- 发布镜像 `v41`：Web Revision 36、Worker Revision 40。
- 多用户任务 77、78、79 连续三轮成功，均遍历 20 个标的。
- 每轮当前可交易港股成功 3 个、休市跳过 17 个、失败 0 个。
- 修复后未再出现 Longbridge `429003`。
- admin SDK Gateway 并发读取 USD/HKD 账户和港美交易日历成功。
- admin 引擎仍保持用户原状态 `stopped`，未主动启动。
- 验证结束后 `chuangye` 已恢复 `stopped`，自动提交始终为关闭。
