# Debug Session: cloud-report-queue
- **Status**: [OPEN]
- **Issue**: 云端报告提交后持续显示“已排队”，用户看到的 Worker 实例日志持续为 standby。
- **Debug Server**: pending
- **Log File**: `.dbg/trae-debug-log-cloud-report-queue.ndjson`

## Reproduction Steps
1. 登录云端 Futu 工作台并完成二次验证。
2. 点击生成 30 日或 60 日报告。
3. 页面持续显示“报告任务已排队，正在等待处理”。
4. 在 veFaaS Worker 实例日志中观察 leader/standby 与任务消费事件。

## Hypotheses & Verification
| ID | Hypothesis | Likelihood | Effort | Evidence |
|----|------------|------------|--------|----------|
| A | 用户查看的是 standby 实例，实际 leader 在另一实例 | High | Low | Confirmed：可见 v52 为 worker-54，数据库 leader 为 worker-45 |
| B | leader 被无超时的旧任务占用，报告一直无法 claim | High | Low | Confirmed：1427 running，1428 report.generate queued |
| C | 报告已完成，但前端轮询了另一任务 | Medium | Low | Rejected：页面对应 1428，数据库状态确为 queued |
| D | 滚动发布残留实例持续持有 advisory lock | Medium | Medium | Confirmed：旧 worker-45 仍持有 advisory lock，v52 日志持续 standby |

## Log Evidence
- `.dbg/trae-debug-log-cloud-report-queue.ndjson` 第 1 条：v52 `worker-54` 与数据库 leader `worker-45` 不一致。
- 第 2 条：旧 leader 正在处理无超时版本的 `futu_live.orders` 任务 1427。
- 第 3 条：用户报告任务 1428 确实停留在 queued。
- 第 4 条：旧版本会话仍持有 PostgreSQL advisory lock。
- Post-fix：逐个终止残留旧 leader 的 advisory lock 会话后，v52 实例取得 leader。
- Post-fix：任务 1428 从 queued 重新入队后由 v52 leader 领取，最终于 00:27:44 succeeded。
- Post-fix：报告结果包含 25,390 字符 Markdown，并已进入报告历史。

## Verification Conclusion
- 根因是滚动发布残留的旧 Worker 获得 leader 锁，并被旧版无超时订单读取任务卡住。
- v52 已实际接管任务队列，订单读取新增 30 秒硬超时，避免同类任务无限占用串行消费者。
- 报告异步接口保持可查询，任务 1428 已完成，但用户确认症状变为“报告全部数据不可用”。
- 任务 1428 的 30 行数据中，价格、估值、技术指标、期权和新闻字段全部不可用；当前进入第二轮调查。

## Iteration 2
| ID | Hypothesis | Likelihood | Expected Signal |
|----|------------|------------|-----------------|
| E | `futu_snapshot.py` 整体调用超过 240 秒，被 Node Bridge 强杀 | High | 日志包含 bridge timeout，Python 无正常响应 |
| F | OpenD 地址可连接，但单票订阅/历史 K/期权链串行调用累计超时 | High | Python 分阶段耗时集中在 technical/options |
| G | OpenD 权限或市场订阅失败导致所有 ticker 返回错误 | Medium | Python 正常返回且每行包含统一权限错误 |
| H | 降级校验错误地允许 30 行全空数据标记 succeeded | High | `isUsableForAnalysis=true` 但关键字段可用数为 0 |

### Iteration 2 Evidence
- E Confirmed：30 只整批、6 个 5 只报价批次均达到 Bridge 硬超时且无 JSON 响应。
- F Rejected：关闭 technical/options 后，quote-only 阶段仍超时。
- G Inconclusive：Python 进程在 API 返回前被超时终止，尚未获得权限错误正文。
- H Confirmed and fixed：全量价格不可用现在触发 blocking，并终止报告而非生成误导结果。
- OpenD 主机已定位为 Windows ECS `fin-opend`（私网 `10.20.1.37`），实例状态 RUNNING；需要通过 Cloud Assistant 读取进程与端口状态。
