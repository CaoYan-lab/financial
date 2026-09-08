# admin 长桥盘前评估修复

## 现网证据

- 2026-09-08 17:55（Asia/Shanghai），`longbridge_live` 引擎为 `running`，17 个美股标的处于允许评估的盘前时段。
- Worker 心跳正常，长桥 SDK 鉴权、行情订阅和账户读取均正常。
- 最新一轮信号仍停留在港股收盘前；美股盘前没有新信号。
- `longbridge_live_skipped` 持续记录 `spawn longbridge ENOENT`，说明请求在方舟调用前被行情兜底链路拦截。

## 根因

长桥实时缓存不足 120 根 1 分钟 K 线时，历史回补仍调用本地 `longbridge`
命令行。云端 Worker 镜像只部署 Node SDK，没有安装该命令行，因此所有盘前
美股在模型调用前失败。状态 Banner 仅依据引擎运行状态和市场时段判断，把
“当前时段允许评估”错误显示成“正在评估”。

## 修复

1. 长桥实时订阅复用 admin SDK Gateway 的 Quote Context 和统一限频器。
2. 历史 K 线回补直接调用 SDK `candlesticks`，不再依赖容器内命令行。
3. 云模式下缓存不足时不再尝试命令行兜底，保留明确的数据未就绪原因。
4. 状态聚合支持逐标的数据就绪异常，避免把模型前失败显示为正在评估。

## 验收

- 单元测试覆盖 SDK 历史回补和数据未就绪状态。
- 类型检查与相关交易测试通过。
- 发布后 `longbridge_live_skipped` 不再出现 `spawn longbridge ENOENT`。
- 美股盘前出现方舟请求日志和新的策略信号。
