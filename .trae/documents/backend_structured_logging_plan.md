# 后台服务标准化日志计划

## Summary

本计划为后端服务引入标准化日志组件，用于在终端实时观察关键操作和大模型调用链路。日志暂不做持久化，不写入 SQLite 或文件，主要输出到后台终端。

已确认决策：

* 日志组件：`pino`

* 终端格式：可读文本

* 唯一性字段：同时使用 `traceId` 和 `logId`

* `traceId`：串联一次 API 请求、一次量化启动/停止、一次 `runOnce()`、一次大模型批量评估。

* `logId`：每条日志唯一，用于定位单条日志。

目标日志覆盖：

* 服务启动、关闭、异常。

* HTTP 请求进入、完成、失败。

* 切换大模型、切换并发。

* 启动量化交易、停止量化交易、单轮评估。

* 每轮大模型评估开始/结束、并发数、模型、股票池数量、耗时。

* 单个股票的大模型调用成功/失败、耗时、模型、动作、是否批准。

* 风控阻断、跳过原因、订单提交成功/失败。

## Current State Analysis

### 依赖现状

文件：`package.json`

当前没有标准日志依赖：

* 无 `pino`

* 无 `winston`

* 无 `log4js`

* 无 `morgan`

当前仅少量 `console.log` 存在于：

* `api/server.ts`

  * `Server ready on port ...`

  * `SIGTERM signal received`

  * `Server closed`

### Express 入口

文件：`api/app.ts`

当前结构：

* 加载 `.env.local` / `.env`

* 注册 `cors`

* 注册 `express.json`

* 注册 API 路由

* 最后注册错误处理中间件和 404

当前问题：

* 没有请求级日志。

* 错误中间件没有打印异常详情。

* 没有请求上下文，无法在服务层自动拿到 `traceId`。

### 服务入口

文件：`api/server.ts`

当前直接使用 `console.log` 打印服务启动和退出。

需要替换为标准 logger：

* `logger.info(...)`

* `logger.warn(...)`

* `logger.error(...)`

### 大模型配置路径

文件：`api/simulation/llmRuntimeConfigService.ts`

当前负责：

* 读取/保存大模型运行时配置。

* 切换模型 endpoint。

* 切换并发。

* SQLite 持久化。

需要新增日志：

* 读取配置失败回退默认值。

* 更新配置成功：

  * `previousModel`

  * `nextModel`

  * `previousConcurrency`

  * `nextConcurrency`

  * `maxConcurrency`

* 保存 SQLite 失败但内存生效。

### Ark 调用路径

文件：`api/simulation/llmResponseUtils.ts`

当前负责：

* 读取 `ARK_API_KEY`

* 读取 `ARK_RESPONSES_URL`

* 读取当前模型 `getActiveArkModel()`

* 调用 Ark Responses API

需要新增日志：

* 调用开始：

  * `model`

  * `url`

  * `inputMessageCount`

* 调用成功：

  * `model`

  * `durationMs`

  * `outputLength`

* 调用失败：

  * `model`

  * `durationMs`

  * `httpStatus`

  * `error`

注意：

* 日志不得打印 `ARK_API_KEY`。

* 日志不得打印完整 prompt 或账户持仓明细，避免终端刷屏和敏感信息泄露。

### 量化引擎路径

文件：`api/simulation/simulationTradingEngine.ts`

当前关键流程：

* `start()`

  * 加载模拟账户

  * 启动行情订阅

  * 预热实时数据

  * 询问数据窗口

  * 调用 `runOnce()`

  * 启动定时轮询

* `stop()`

  * 停止定时器

  * 设置引擎停止

* `runOnce()`

  * 加载账户

  * 加载市场状态

  * 读取配置并发 `getActiveDecisionConcurrency(...)`

  * 并发请求大模型

  * 串行处理风控和订单

需要新增日志：

* `simulation.start.requested`

* `simulation.start.succeeded`

* `simulation.start.failed`

* `simulation.stop.requested`

* `simulation.stop.succeeded`

* `simulation.run_once.started`

* `simulation.run_once.completed`

* `simulation.run_once.failed`

* `simulation.llm_batch.started`

* `simulation.llm_batch.completed`

* `simulation.ticker.skipped`

* `simulation.decision.received`

* `simulation.order.blocked`

* `simulation.order.submitted`

* `simulation.order.failed`

### 大模型决策服务

文件：`api/simulation/llmTradingDecisionService.ts`

当前负责：

* 构造单标的大模型 prompt。

* 调用 `callArkResponses(...)`。

* 解析模型 JSON。

* 返回 `LlmTradingDecision`。

建议埋点：

* 在 `requestTradingDecision(...)` 层记录 ticker 级调用耗时和决策结果。

* 因为 `callArkResponses(...)` 会记录底层 Ark HTTP 调用耗时，ticker 层日志应记录业务字段：

  * `ticker`

  * `action`

  * `approved`

  * `orderQuantity`

  * `confidence`

  * `durationMs`

  * `error`

## Proposed Changes

### 1. 新增依赖

文件：`package.json`

新增依赖：

* `pino`

* `pino-pretty`

原因：

* `pino` 是 Node 后端标准高性能结构化日志组件。

* `pino-pretty` 用于本地终端可读文本输出。

* 未来如需接入日志平台，可切换为 JSON 行输出，不改业务埋点。

### 2. 新增日志工具模块

新增文件：`api/utils/logger.ts`

职责：

* 创建全局 `logger`。

* 根据环境配置日志级别：

  * `LOG_LEVEL`，默认 `info`

* 根据环境配置输出格式：

  * 默认本地开发用 `pino-pretty`

  * 可通过 `LOG_PRETTY=false` 输出 JSON 行

* 每条日志自动带唯一 `logId`。

* 支持从异步上下文读取 `traceId`。

建议实现：

```ts
import pino from 'pino'
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'

type LogContext = { traceId: string }

const storage = new AsyncLocalStorage<LogContext>()

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: undefined,
  mixin() {
    return {
      traceId: storage.getStore()?.traceId,
      logId: randomUUID(),
    }
  },
  transport: process.env.LOG_PRETTY === 'false' ? undefined : {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
      messageFormat: '{event} {msg}',
    },
  },
})

export function withLogContext<T>(traceId: string, callback: () => T): T
export function currentTraceId(): string | undefined
export function createTraceId(prefix?: string): string
```

字段规范：

* `event`：稳定事件名，例如 `simulation.run_once.started`

* `traceId`：一次请求/任务链路 ID

* `logId`：每条日志唯一 ID

* `durationMs`：耗时，单位毫秒

* `ticker`：标的

* `model`：模型 endpoint

* `modelLabel`：展示名

* `concurrency`：大模型并发

* `accountId`：模拟账户 ID

* `orderId`：Futu 订单 ID

* `error`：错误摘要

### 3. 新增请求日志中间件

新增文件：`api/middleware/requestLogger.ts`

职责：

* 每个 HTTP 请求创建 `traceId`。

* 通过 `withLogContext(...)` 将 `traceId` 注入 AsyncLocalStorage。

* 请求进入时打印：

  * `http.request.started`

  * `method`

  * `path`

  * `query`

* 响应结束时打印：

  * `http.request.completed`

  * `statusCode`

  * `durationMs`

* 异常由 `app.ts` 错误中间件打印 `http.request.failed`。

注意：

* 不打印完整 body，尤其避免 API key、账户详情、大模型 prompt。

* 可打印安全字段，如 `model`、`concurrency`。

修改文件：`api/app.ts`

* 在 `cors/json/urlencoded` 之后、路由之前注册 `requestLogger`。

* 错误处理中间件增加标准 logger 打印 error stack/message。

* 404 可打印 `http.request.not_found` 或依赖 completed 日志状态码。

### 4. 替换服务启动/退出日志

文件：`api/server.ts`

将 `console.log` 替换为：

* `logger.info({ event: 'server.started', port }, 'Server ready')`

* `logger.info({ event: 'server.sigterm' }, 'SIGTERM signal received')`

* `logger.info({ event: 'server.sigint' }, 'SIGINT signal received')`

* `logger.info({ event: 'server.closed' }, 'Server closed')`

### 5. 大模型配置变更日志

文件：`api/simulation/llmRuntimeConfigService.ts`

在 `updateLlmRuntimeConfig(...)` 中新增：

* 更新成功：

```ts
logger.info({
  event: 'llm.config.updated',
  previousModel,
  nextModel,
  previousConcurrency,
  nextConcurrency,
  maxConcurrency,
}, 'LLM runtime config updated')
```

* SQLite 保存失败：

```ts
logger.warn({
  event: 'llm.config.persist_failed',
  error,
}, 'LLM runtime config persistence failed; in-memory config is active')
```

在 `getCachedConfig()` 中：

* 读取失败时打印 `llm.config.load_failed`。

* 读取成功可选 `debug` 打印，默认不刷屏。

### 6. Ark HTTP 调用日志

文件：`api/simulation/llmResponseUtils.ts`

在 `callArkResponses(...)` 中新增：

* 开始：

```ts
const startedAt = performance.now()
logger.info({
  event: 'llm.ark.request.started',
  model,
  url,
  inputMessageCount: input.length,
}, 'Ark request started')
```

* HTTP 非 2xx：

```ts
logger.error({
  event: 'llm.ark.request.failed',
  model,
  statusCode: response.status,
  durationMs,
  error: ...
}, 'Ark request failed')
```

* 成功：

```ts
logger.info({
  event: 'llm.ark.request.succeeded',
  model,
  durationMs,
  outputLength: text.length,
}, 'Ark request succeeded')
```

* 网络/运行时异常：

```ts
logger.error({
  event: 'llm.ark.request.errored',
  model,
  durationMs,
  error,
}, 'Ark request errored')
```

敏感信息约束：

* 不打印 `Authorization`。

* 不打印完整 prompt。

* 不打印完整 Ark response payload，失败时只打印摘要和状态码。

### 7. 单标的大模型决策日志

文件：`api/simulation/llmTradingDecisionService.ts`

在 `requestTradingDecision(input)` 中新增：

* 开始：

  * `llm.decision.started`

  * `ticker`

  * `model`

* 成功：

  * `llm.decision.succeeded`

  * `ticker`

  * `action`

  * `approved`

  * `orderQuantity`

  * `confidence`

  * `durationMs`

* 被阻断/调用失败：

  * `llm.decision.failed`

  * `ticker`

  * `durationMs`

  * `error`

说明：

* 底层 Ark 日志记录 HTTP 层。

* 这里记录业务决策层。

### 8. 量化引擎关键操作日志

文件：`api/simulation/simulationTradingEngine.ts`

新增 trace 设计：

* `start()` 使用 `traceId = simulation-start-${randomUUID()}`

* `stop()` 使用 `traceId = simulation-stop-${randomUUID()}`

* 每次 `runOnce()` 使用 `traceId = simulation-run-${randomUUID()}`

* `start()` 内部调用 `runOnce()` 时，允许 `runOnce(traceId?)` 复用启动 trace，或由 `runOnce()` 自己生成子 trace。

为了最小侵入，建议新增私有方法：

```ts
async runOnceWithTrace(traceId?: string): Promise<SimulationDashboardResponse>
```

或让 `runOnce()` 内部：

```ts
return withLogContext(createTraceId('simulation-run'), async () => { ... })
```

关键日志：

* `simulation.start.requested`

  * `accountId?`

  * `universeCount`

* `simulation.start.succeeded`

  * `accountId`

  * `runIntervalMs`

  * `dataWindow`

  * `durationMs`

* `simulation.start.failed`

  * `error`

* `simulation.stop.requested`

* `simulation.stop.succeeded`

* `simulation.run_once.started`

  * `accountId`

  * `universeCount`

  * `concurrency`

  * `model`

  * `dataWindow`

* `simulation.llm_batch.started`

  * `universeCount`

  * `concurrency`

  * `model`

* `simulation.llm_batch.completed`

  * `durationMs`

  * `evaluatedCount`

  * `skippedCount`

* `simulation.run_once.completed`

  * `durationMs`

  * `signalCount`

  * `approvedCount`

  * `submittedOrderCount`

  * `blockedOrderCount`

  * `skippedCount`

* `simulation.ticker.skipped`

  * `ticker`

  * `reason`

* `simulation.order.blocked`

  * `ticker`

  * `side`

  * `reason`

* `simulation.order.submitted`

  * `ticker`

  * `side`

  * `quantity`

  * `orderType`

  * `orderSession`

  * `limitPrice`

  * `orderId`

* `simulation.order.failed`

  * `ticker`

  * `side`

  * `error`

### 9. 路由操作日志

文件：`api/routes/simulationRoutes.ts`

新增关键 API 操作日志：

* `POST /start`

  * `simulation.api.start`

* `POST /stop`

  * `simulation.api.stop`

* `POST /run-once`

  * `simulation.api.run_once`

* `PUT /llm-config`

  * `simulation.api.llm_config_update`

  * 打印请求中的安全字段：

    * `model`

    * `concurrency`

说明：

* 请求中间件已有 HTTP 基础日志。

* 路由日志用于突出业务操作。

### 10. 日志字段与示例

可读终端示例：

```text
[2026-06-17 13:20:01] INFO traceId=req-... logId=... event=simulation.api.llm_config_update model=ep-20260410101451-dq9sg concurrency=11 LLM config update requested
[2026-06-17 13:20:01] INFO traceId=req-... logId=... event=llm.config.updated previousModel=ep-20260616231829-mnq2t nextModel=ep-20260410101451-dq9sg previousConcurrency=6 nextConcurrency=11 LLM runtime config updated
[2026-06-17 13:21:00] INFO traceId=simulation-run-... logId=... event=simulation.run_once.started model=ep-20260410101451-dq9sg concurrency=11 universeCount=11 Simulation run started
[2026-06-17 13:21:02] INFO traceId=simulation-run-... logId=... event=llm.decision.succeeded ticker=NVDA action=HOLD approved=false durationMs=1832 LLM decision succeeded
```

### 11. 测试

新增/修改测试：

* 新增 `tests/logger.test.ts`

  * 验证 `createTraceId(prefix)` 带前缀且唯一。

  * 验证 `withLogContext(traceId, callback)` 中 `currentTraceId()` 可读取。

  * 验证不同调用生成不同 trace。

* 更新 `tests/llmRuntimeConfig.test.ts`

  * 不强制断言日志内容，避免测试脆弱。

  * 如 logger 引入影响环境，确保测试不输出过多日志。

* 如 `pino-pretty` transport 在 Vitest 环境导致异步 worker 问题：

  * 测试环境默认 `LOG_PRETTY=false`。

  * logger 模块根据 `process.env.NODE_ENV === 'test'` 关闭 pretty transport。

验证命令：

* `npm run check`

* `npm test`

* `npm run build`

手工验证：

1. 启动服务：

   * 终端看到 `server.started`。
2. 打开模拟盘：

   * 终端看到 HTTP 请求日志。
3. 页面切换模型和并发：

   * 终端看到 `simulation.api.llm_config_update` 和 `llm.config.updated`。
4. 点击启动：

   * 终端看到 `simulation.start.requested`、`simulation.start.succeeded`。
5. 点击单轮评估：

   * 终端看到 `simulation.run_once.started`、`llm.ark.request.*`、`llm.decision.*`、`simulation.run_once.completed`。
6. 点击停止：

   * 终端看到 `simulation.stop.requested`、`simulation.stop.succeeded`。

## Assumptions & Decisions

* 日志暂不持久化，仅输出到终端。

* 采用 `pino` 作为标准化日志组件。

* 采用 `pino-pretty` 做本地可读文本输出。

* 每条日志必须带唯一 `logId`。

* 业务链路必须带 `traceId`。

* 不打印 API key、完整 prompt、完整账户持仓明细、完整 Ark response。

* `LOG_LEVEL` 默认 `info`。

* 测试环境默认避免 pretty transport，防止 Vitest 输出干扰。

* 本计划不改变交易逻辑、风控逻辑、大模型 prompt、订单提交逻辑。

## Verification Steps

1. 安装依赖后运行：

   * `npm run check`
2. 运行测试：

   * `npm test`
3. 构建：

   * `npm run build`
4. 启动服务并观察终端：

   * `npm run dev`
5. 页面操作验证：

   * 切换大模型

   * 修改并发

   * 启动量化交易

   * 单轮评估

   * 停止量化交易
6. 确认每条关键日志都有：

   * `event`

   * `traceId`

   * `logId`

   * `durationMs`，仅耗时类日志需要
7. 确认终端不出现：

   * `ARK_API_KEY`

   * Authorization header

   * 完整 prompt

   * 大量账户明细

