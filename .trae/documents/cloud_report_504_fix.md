# 云端报告 504 修复

## 现象与证据

- `POST /api/report/generate` 经 APIG 长时间保持同步请求，最终返回 HTTP 504。
- 2026-09-13 22:43:52 创建的 `report.collect` 任务 `1418` 一直处于 `running`。
- Worker 心跳持续更新且 `processing=true`，说明进程存活，但报告采集调用未返回。
- 原实现仅在 Web 请求内等待采集结果；请求超时后，即使采集稍后完成，也不会继续生成和持久化报告。
- Futu 报告快照子进程和 StockAnalysis 股票池请求原先均缺少硬超时。

## 修复

1. 云端 `POST /api/report/generate` 改为立即返回 `202`、`jobId` 和 `batchId`。
2. 新增 `GET /api/report/jobs/:jobId`，返回排队、运行、失败或完整报告结果。
3. 前端每 2 秒轮询任务状态，最长等待 15 分钟；同步本地接口保持兼容。
4. Worker 新增 `report.generate` 任务，完整执行数据采集、市场资讯、大模型生成和持久化。
5. Futu 报告快照子进程默认 240 秒超时，可通过 `FUTU_REPORT_SNAPSHOT_TIMEOUT_MS` 调整。
6. StockAnalysis 请求增加 15 秒超时并沿用既有静态股票池降级。
7. 前端同时读取后端 `message` 和 `error` 字段，错误提示统一为中文。

## 验证

- `npm run check`
- `npm run lint -- --quiet`
- 报告、持久化、Python Bridge 超时与异步路由测试共 67 项通过。
- `npm run build` 通过。

## 发布检查

1. 同一镜像同时发布 `fin-web` 与 `fin-worker`。
2. 发布会终止旧 Worker 中卡住的任务 `1418`；该旧任务可保留作审计，不应继续复用。
3. 登录云端后分别生成 30 日和 60 日报告，确认创建请求快速返回且页面显示排队/生成状态。
4. 确认 `cloud_jobs` 中新任务类型为 `report.generate`，最终状态为 `succeeded`。
5. 确认报告历史新增对应 `batchId`，并检查 Worker 心跳持续推进。
