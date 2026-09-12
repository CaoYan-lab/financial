# Longbridge v44 实盘启动状态卡死修复

## 生产证据

- v44 发布后，`longbridge_live.start` 任务均被新 Worker 正常认领并成功完成。
- 最近多次启动任务返回的 `dashboard.engine.running` 均为 `true`，耗时约 2 至 8 秒。
- `cloud_engine_state` 中 `longbridge_live/primary` 的期望状态为 `running`。
- `cloud_worker_status/leader` 的心跳停留在旧 Worker，快照中的
  `longbridge_live.engine.running` 仍为 `false`。
- 页面启动后轮询的是 Leader 快照，因此持续读到旧状态并最终超时，表现为按钮一直
  “请求中”，随后仍显示“实盘评估已停止”。

## 根因

Worker 心跳串行调用全部引擎的 `status()`。Longbridge 的云快照采集会访问交易日历、
账户、持仓和订单等外部 SDK 数据。任一 SDK Promise 长时间不返回时，整次心跳不会写入
数据库。交易控制任务由独立循环消费，因此启动任务能够成功，但 Web 永远看不到新状态。

## 修复

1. 引擎快照改为并行采集，并为每个引擎设置独立超时。
2. 同一引擎只允许一个未完成的快照请求，避免超时后持续堆积外部 SDK 调用。
3. 启动、停止和单轮评估任务完成后，立即缓存并发布任务返回的最新看板。
4. 心跳采集失败时，保留数据库中最后一份完整快照，并用任务返回的最新看板覆盖运行态。
5. 心跳读取旧快照作为降级输入，单个引擎异常不得阻断其他引擎和 Worker 存活状态更新。
6. 并发中的旧心跳在最终写入前再次合并最新任务看板，不得把新状态覆盖回旧状态。
7. standby 发现 Leader 心跳超过 90 秒且锁仍被本应用连接占用时，先抢占独立恢复锁；恢复者
   终止旧连接后在同一数据库会话中立即获取 Leader 锁，杜绝多个 standby 互相终止。
8. 新 Leader 获取锁后先发布接管心跳，再执行耗时的引擎状态恢复。

## 验收标准

- Longbridge 外部快照请求永久不返回时，Worker 心跳仍能按周期更新。
- 成功启动后，下一次心跳中的 `engine.running` 为 `true`。
- 降级快照继续保留 `sourceStatus`、`account`、`workbench` 等最后可用数据。
- 不产生同一引擎的并发快照请求。
