# 云端券商任务队列隔离

## 问题

云端 Worker 原先串行消费全部 `cloud_jobs`。报告生成或模型评估长时间运行时，
Longbridge 与 Futu 的订单列表、订单详情和交易控制任务只能排队。Web 等待窗口到期后
返回 504，即使订单代理本身正常。

`longbridgeOrderProxyConfigured=true` 只代表代理配置存在。订单任务
`status=queued, attempts=0` 表示尚未被 Worker 认领，不能归因于 Longbridge SDK 或
代理网络。

## 约束

- 订单列表、订单详情、确认、拒绝、撤单、批量过期、交易设置及启动/停止属于交互泳道。
- 报告生成、单轮评估等长任务属于后台泳道。
- 两个泳道可并行，各泳道内部保持单任务串行。
- 同一用户的订单列表读取只保留最新的未执行请求。
- 新 Worker 获得 leader 锁后，必须终止其他 Worker 遗留的 `running` 任务。
- 不修改 `liveTradingEnabled` 或 `autoSubmitEnabled`，部署前后必须校验门禁连续性。

## 验收

1. 后台报告运行时，Longbridge 订单读取仍能被交互泳道认领。
2. 重复刷新不会累积同一用户的未执行订单列表任务。
3. Worker 换代后，旧 Worker 遗留任务不再永久显示为运行中。
4. 订单接口在 35 秒 Web 等待窗口内返回，且不再因后台队列阻塞返回 504。
