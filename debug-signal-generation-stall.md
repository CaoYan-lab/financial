# Debug Session: signal-generation-stall
- **Status**: [OPEN]
- **Issue**: 云上策略信号生成间隔异常拉长；截图中 INTC 相邻信号间隔约 13 分 41 秒，需要确认其他标的范围并定位调度、模型、行情预检或持久化链路原因。
- **Debug Server**: http://127.0.0.1:7777/event
- **Log File**: `.dbg/trae-debug-log-signal-generation-stall.ndjson`

## Reproduction Steps
1. 打开云上策略信号库。
2. 按标的检查最近信号时间。
3. 观察 INTC 在 2026-09-16 21:16:24 与 21:30:05 之间无新信号。
4. 对比其他活跃标的的相邻信号间隔。

## Hypotheses & Verification
| ID | Hypothesis | Likelihood | Effort | Expected Signal | Evidence |
|----|------------|------------|--------|-----------------|----------|
| A | v70 发布后 Worker 重启或 Leader 抖动中断扫描 | High | Low | Worker 启动时间、Leader 代际或心跳频繁变化 | Rejected：Revision 67 仅一个 Ready 实例，信号持续按轮次写入 |
| B | 多标的扫描串行等待慢模型调用 | High | Medium | 同一轮中标的按固定顺序完成，前序模型耗时累加 | Confirmed：运行时模型并发为 21，但 Longbridge 专用并发未配置时硬限制为 1；单请求约 33-52 秒 |
| C | 扫描间隔、候选池复核间隔或冷却配置被放大 | Medium | Low | 配置值明显大于预期间隔，且时间差呈固定倍数 | Confirmed：激进档扫描间隔为 1 分钟，但下一轮在整批完成后才开始计时 |
| D | 休市或行情新鲜度预检错误跳过信号 | Medium | Medium | 日志出现市场关闭、行情过期或数据缺口跳过 | Partially confirmed：港股休市被正确跳过，不解释美股 17 个标的的长间隔 |
| E | 信号已生成但数据库持久化或页面查询遗漏 | Low | Medium | 模型完成日志存在，但信号表无对应记录 | Rejected：数据库信号时间与模型成功日志时间一致 |

## Log Evidence
- 截图：INTC 信号时间 2026-09-16 21:16:24 与 21:30:05，间隔约 13 分 41 秒。
- Worker Revision 67：单个 Ready 实例，未发现 Leader 重复运行证据。
- PostgreSQL 最近两小时：17 个美股标的平均信号间隔 899-945 秒，最大 995-1124 秒；问题覆盖全部开市美股，不是 INTC 单点。
- INTC 最近四个间隔：927、821、1056 秒；截图中的 821 秒与数据库一致。
- 运行时配置：`llm_runtime_config.concurrency=21`；容器未设置 `LONGBRIDGE_LIVE_EVALUATION_CONCURRENCY`，代码默认值为 1。
- Worker 日志：SPCX 单次模型请求 32925ms，SPCU 单次模型请求 52364ms，且完成后才启动下一个标的，符合串行执行。
- 激进档 `singleSignalScanIntervalMinutes=1`；`scheduleNextScan()` 在整批 Promise 完成后的 `finally` 中再等待完整间隔，形成“批次耗时 + 1 分钟”。
- 21:49:26 至 21:49:53 出现一次 stop/start；新启动 bootstrap 仅 7969ms 完成，暴露停止后旧 `runInFlight` 尚未结束时新启动跳过首轮的竞态，但不是此前持续 15 分钟间隔的主因。

## Verification Conclusion
主因是 Longbridge 评估并发默认硬封顶为 1，覆盖了用户配置的 21 并发；次因是固定延迟调度在整批完成后再次等待 1 分钟。

本地修复：
- 未显式配置 `LONGBRIDGE_LIVE_EVALUATION_CONCURRENCY` 时遵循运行时模型并发；显式配置仍作为硬上限。
- 下一轮正常扫描按批次开始时间计算剩余延迟；数据库瞬时故障仍从失败完成时起等待完整重试间隔。
- 保留订单最终提交锁和串行风控，不改变真实订单门禁。

本地验证：
- TypeScript 类型检查通过。
- ESLint 静态检查通过。
- 生产构建通过。
- 89 个测试文件通过，563 项测试通过，1 项外部集成测试按配置跳过。
- 默认并发、显式并发上限和固定周期调度新增 3 项回归测试。

云端 v71 post-fix 验证：
- Git 提交 `8a6c545`（恢复 Longbridge 信号节奏）和 `7c7a038`（系统自动提交 FIFO）已推送。
- 热修复镜像 `docker-cr-input-cn-beijing.cr.volces.com/fin/financial-workbench:v71` 已发布至 Worker Revision 69、Web Revision 60。
- Worker 仅一个 Ready 实例；Leader 代际为 209，目标代际为 209，数据库咨询锁持有者为 1，跨心跳窗口持续更新。
- 公网 `/api/health` 连续 3 次返回 200。
- 两轮 17 个美股信号均已落库；逐标的相邻间隔为 101-309 秒，INTC 为 152 秒。相比修复前 INTC 821-1056 秒、全体平均 899-945 秒，长间隔问题已消除。
- 热修复后 TQQQ 自动提交成功，状态为 `SUBMITTED`；INTW、INTC、AMDL 后续提交均因账户现金上限被真实风控拦截，日志中未再出现“账户已有提交校验进行中”或跨进程提交锁竞争错误。

调试状态保持 `[OPEN]`，等待用户确认线上表现后关闭。
