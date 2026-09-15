# 长桥数据库连接超时重试与调度恢复

## 故障现象

- 长桥页面显示：`Connection terminated due to connection timeout`。
- Worker 日志在 2026-09-15 16:01:16 记录
  `multiuser.worker.heartbeat_failed`。
- 同一时间段长桥主引擎定时扫描停止，必须人工重新启动。

## 根因

该错误由 `pg-pool` 在 PostgreSQL 新连接未能于 10 秒内建立时抛出，
不是 Longbridge SDK、账户授权或交易接口错误。

长桥定时扫描会先从 PostgreSQL 读取系统托管挂单。原实现将扫描过程中的
任意异常都视为致命错误，调用 `setError()` 把引擎运行状态改为停止，并且
不再安排下一轮扫描。因此一次短暂的数据库网络或 TLS 握手抖动会永久停止
长桥引擎。

## 修复

### PostgreSQL 连接重试

- `api/cloud/db/pgClient.ts` 对共享查询和事务连接获取过程中“连接尚未建立”的
  超时进行最多 3 次尝试。
- 默认退避间隔为 250ms、500ms。
- 可通过以下环境变量调整：
  - `PG_CONNECTION_RETRY_ATTEMPTS`
  - `PG_CONNECTION_RETRY_DELAY_MS`
- SQL 执行超时和其他查询错误不重试，避免对结果未知的写操作进行重复提交。

### 长桥调度恢复

- `api/longbridge/longbridgeLiveTradingEngine.ts` 将 PostgreSQL 建连超时识别为
  可恢复错误。
- 数据库重试仍失败时，引擎保留运行态并展示错误，默认 15 秒后再次扫描。
- 启动初始化、定时扫描和组合裁决三个调度入口使用相同恢复策略。
- 下一轮成功后由既有 `markRun()` 清空错误。
- 账户凭据错误、业务校验错误等非瞬时异常仍按原逻辑停止引擎。
- 可通过 `LONGBRIDGE_TRANSIENT_RETRY_DELAY_MS` 调整恢复间隔。

## 安全边界

- 不重试语句执行超时。
- 不放宽下单、撤单、账户现金、购买力或融资风险门禁。
- 本次验证不调用真实下单或撤单接口。

## 验证

- 新增 PostgreSQL 重试测试：
  - 两次建连超时后第三次成功。
  - 包装后的 `connect ETIMEDOUT` 可识别。
  - SQL statement timeout 不重试。
  - 达到最大尝试次数后返回原始错误。
- 新增长桥错误策略测试：
  - PostgreSQL 建连超时保持可恢复。
  - 非瞬时错误保持致命停机语义。
