# 大模型运行时配置页面化计划

## Summary

本计划将模拟盘量化交易的大模型运行配置从后端环境变量/常量改为页面可选、后端运行时立即保存、下一轮评估生效的动态配置。

目标：

* 页面可选择大模型推理接入点：

  * `ep-20260616231829-mnq2t`：`DeepSeek-v4-Pro`

  * `ep-20260410101451-dq9sg`：`Doubao-2.0-pro`

* 页面可选择大模型并发数：

  * 最小值 `1`

  * 最大值为当前用户股票池可选股票数量，即 `LLM_SIMULATION_UNIVERSE.length`

* 配置修改后：

  * 写入本地 SQLite，跨服务重启保留。

  * 不打断当前正在执行的一轮评估。

  * 从下一轮 `runOnce()` 或下一次定时轮询开始生效。

* 前端展示当前已生效配置，并允许用户保存新配置。

## Current State Analysis

### 当前并发实现

文件：`api/simulation/simulationTradingEngine.ts`

当前代码：

```ts
const LLM_DECISION_CONCURRENCY = Number(process.env.LLM_DECISION_CONCURRENCY || 6)
```

使用位置：

```ts
const evaluations = await mapLimit(universe, Math.max(1, LLM_DECISION_CONCURRENCY), async (ticker) => {
  ...
  const decision = await requestTradingDecision(...)
})
```

现状问题：

* 并发值在模块加载时固定。

* 页面无法修改。

* 后端运行中无法调整。

* 没有上限保护为股票池大小。

### 当前模型实现

文件：`api/simulation/llmResponseUtils.ts`

当前代码：

```ts
const model = process.env.ARK_MODEL || 'deepseek-v4-pro'
```

现状问题：

* 模型来自环境变量。

* 页面无法切换。

* 修改 `.env.local` 后需要重启或热加载，不适合运行时切换。

* 没有模型展示名和可选模型列表。

### 当前页面能力

文件：`src/pages/SimulationTradingView.tsx`

当前页面展示：

* SIMULATE 账户

* 引擎运行状态

* 用户股票池

* 模型建议数据窗口

* Futu 订单状态

* 历史策略信号

* 历史模拟订单

* 跳过日志

缺失：

* 没有“大模型运行配置”面板。

* 没有模型下拉选择。

* 没有并发数选择。

* 没有保存配置按钮或保存状态。

### 当前 API 路由

文件：`api/routes/simulationRoutes.ts`

已有：

* `GET /api/simulation/dashboard`

* `POST /api/simulation/start`

* `POST /api/simulation/stop`

* `POST /api/simulation/run-once`

* `GET /api/simulation/futu-orders`

* `GET /api/simulation/history/*`

缺失：

* 获取当前大模型运行配置的接口。

* 更新大模型运行配置的接口。

### SQLite 现状

文件：

* `api/simulation/simulationPersistence.ts`

* `api/futu_bridge/simulation_history_db.py`

当前 SQLite 用途：

* 保存历史策略信号。

* 保存历史模拟订单提交结果和大模型决策快照。

* 保存跳过日志。

本计划不改变上述历史数据边界。

新增配置持久化可以复用 SQLite 技术路线，但建议独立服务/表，不混入 `simulation_events`。

## Proposed Changes

### 1. 新增共享类型

文件：`shared/types.ts`

新增类型：

```ts
export type LlmModelOption = {
  id: string
  label: string
  provider: 'ark'
}

export type LlmRuntimeConfig = {
  model: string
  modelLabel: string
  concurrency: number
  maxConcurrency: number
  updatedAt: string
}

export type LlmRuntimeConfigResponse = {
  ok: boolean
  config: LlmRuntimeConfig
  modelOptions: LlmModelOption[]
  warnings: string[]
}

export type UpdateLlmRuntimeConfigRequest = {
  model?: string
  concurrency?: number
}
```

模型选项固定为：

```ts
[
  { id: 'ep-20260616231829-mnq2t', label: 'DeepSeek-v4-Pro', provider: 'ark' },
  { id: 'ep-20260410101451-dq9sg', label: 'Doubao-2.0-pro', provider: 'ark' },
]
```

### 2. 新增运行时配置服务

新增文件：`api/simulation/llmRuntimeConfigService.ts`

职责：

* 提供默认配置：

  * 默认模型：

    * 优先 `process.env.ARK_MODEL`

    * 若为空，使用 `ep-20260616231829-mnq2t`

  * 默认并发：

    * 优先 `process.env.LLM_DECISION_CONCURRENCY`

    * 若为空，使用 `6`

  * 并发最终 clamp 到 `[1, llmSimulationTickers().length]`

* 提供模型选项列表。

* 提供：

  * `getLlmRuntimeConfig()`

  * `updateLlmRuntimeConfig(input)`

  * `getActiveArkModel()`

  * `getActiveDecisionConcurrency()`

* 修改后保存到 SQLite。

* 内存缓存配置，避免每次模型调用都访问 SQLite。

* 配置更新后立即更新内存缓存。

* 当前正在执行的 `runOnce()` 不会被打断；下一轮读取新值。

### 3. 新增 SQLite 配置桥接

新增或扩展文件：`api/futu_bridge/simulation_history_db.py`

新增表：

```sql
CREATE TABLE IF NOT EXISTS simulation_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

新增 action：

* `get_config`

* `set_config`

存储方式：

* `key = 'llm_runtime_config'`

* `value = JSON.stringify({ model, concurrency, updatedAt })`

说明：

* 不放入 `simulation_events`，避免和历史事件混淆。

* 配置数据很小，SQLite 访问成本低。

* 运行时服务会缓存配置，避免频繁调用 Python。

### 4. 修改 Ark 调用模型来源

文件：`api/simulation/llmResponseUtils.ts`

当前：

```ts
const model = process.env.ARK_MODEL || 'deepseek-v4-pro'
```

改为：

```ts
const model = getActiveArkModel()
```

注意：

* `callArkResponses` 是 async，但读取模型可以是同步内存缓存。

* `llmRuntimeConfigService` 在模块初始化时加载或首次读取时加载。

* 若 SQLite 不可用，回退默认模型并返回 warning 到配置接口。

### 5. 修改并发读取方式

文件：`api/simulation/simulationTradingEngine.ts`

当前：

```ts
const LLM_DECISION_CONCURRENCY = Number(process.env.LLM_DECISION_CONCURRENCY || 6)
...
mapLimit(universe, Math.max(1, LLM_DECISION_CONCURRENCY), ...)
```

改为：

```ts
const concurrency = getActiveDecisionConcurrency(universe.length)
const evaluations = await mapLimit(universe, concurrency, async ...)
```

行为：

* 每次 `runOnce()` 开始时读取一次当前配置。

* 当前轮次用固定快照，避免一轮内部并发数变化。

* 页面更新配置后，下一轮 `runOnce()` 使用新并发。

### 6. 将配置加入 dashboard

文件：`shared/types.ts`

扩展 `SimulationDashboardResponse`：

```ts
llmRuntimeConfig: LlmRuntimeConfig
modelOptions: LlmModelOption[]
```

文件：`api/simulation/simulationTradingEngine.ts`

在 `dashboard()`、`stop()`、`runOnce()` 返回中加入当前配置和模型选项。

目的：

* 页面初始化时无需额外请求即可展示当前配置。

* 也可新增独立配置接口用于保存。

### 7. 新增配置 API

文件：`api/routes/simulationRoutes.ts`

新增接口：

* `GET /api/simulation/llm-config`

  * 返回 `LlmRuntimeConfigResponse`

* `PUT /api/simulation/llm-config`

  * body：

    * `model?: string`

    * `concurrency?: number`

  * 校验：

    * `model` 必须属于模型选项。

    * `concurrency` clamp 到 `[1, LLM_SIMULATION_UNIVERSE.length]`。

  * 返回更新后的配置。

接口语义：

* 保存后立即更新后端运行时配置。

* 当前正在运行的一轮不打断。

* 下一轮大模型请求生效。

### 8. 前端 Hook 增加配置读取/保存

文件：`src/hooks/useSimulationTrading.ts`

新增状态：

* `llmConfig`

* `savingConfig`

新增方法：

* `saveLlmConfig(input)`

行为：

* `refreshAll()` 从 dashboard 或配置接口同步当前配置。

* 保存配置后：

  * 调用 `PUT /api/simulation/llm-config`

  * 更新本地配置状态。

  * 可选调用 `refresh()` 更新 dashboard。

### 9. 前端新增“大模型运行配置”面板

文件：`src/pages/SimulationTradingView.tsx`

新增 UI 区域，建议放在“用户股票池/模型建议数据窗口”附近。

内容：

* 模型选择：

  * 下拉框

  * 选项：

    * `DeepSeek-v4-Pro`

    * `Doubao-2.0-pro`

* 并发选择：

  * 下拉框或数字选择。

  * 范围 `1..data.universe.length`。

  * 默认展示当前配置。

* 当前生效提示：

  * `当前模型：DeepSeek-v4-Pro`

  * `当前并发：6 / 最大 11`

  * `保存后从下一轮评估生效`

* 保存按钮。

* 保存失败错误提示。

语言要求：

* 中文界面全中文。

* 英文界面全英文。

* 模型名称可保留英文/产品名。

### 10. 测试

新增测试文件：`tests/llmRuntimeConfig.test.ts`

覆盖：

* 默认模型为 `ep-20260616231829-mnq2t` 或环境变量。

* 默认并发 clamp 到股票池大小。

* 更新模型只允许白名单模型。

* 更新并发最大不超过股票池数量。

* `getActiveDecisionConcurrency()` 返回当前缓存配置。

更新测试：

* 如 `SimulationDashboardResponse` 类型新增字段影响现有测试，补齐最小字段。

验证命令：

* `npm run check`

* `npm test`

* `npm run build`

手工/API 冒烟：

* `GET /api/simulation/llm-config`

* `PUT /api/simulation/llm-config` body：

```json
{
  "model": "ep-20260410101451-dq9sg",
  "concurrency": 11
}
```

* 再次 `GET /api/simulation/llm-config` 确认已保存。

* 重启服务后确认配置仍保留。

## Assumptions & Decisions

* 配置需要持久化，服务重启后保留。

* 修改配置后不打断当前评估，从下一轮 `runOnce()` 生效。

* 并发最大值是当前股票池数量，即 `LLM_SIMULATION_UNIVERSE.length`，当前为 11。

* 模型选项固定为两个 Ark endpoint：

  * `ep-20260616231829-mnq2t`：`DeepSeek-v4-Pro`

  * `ep-20260410101451-dq9sg`：`Doubao-2.0-pro`

* 不改 `ARK_API_KEY` 和 `ARK_RESPONSES_URL`，仍使用现有环境变量。

* 不把模型配置写 `.env.local`，避免运行时编辑环境文件；使用 SQLite 保存页面配置。

* 订单提交仍保持串行；本计划只调整大模型决策请求并发。

* SQLite 历史策略/订单存储边界不变。

## Verification Steps

1. 类型检查：

   * `npm run check`
2. 单元测试：

   * `npm test`
3. 构建：

   * `npm run build`
4. API 冒烟：

   * `GET /api/simulation/llm-config`

   * `PUT /api/simulation/llm-config` 切换到 Doubao endpoint 并设置并发为股票池最大值。

   * 再次 `GET /api/simulation/llm-config` 确认配置已变更。
5. 页面验证：

   * 打开 `/simulation`。

   * 确认出现“大模型运行配置”面板。

   * 切换模型和并发后保存。

   * 确认 UI 显示“下一轮评估生效”。
6. 行为验证：

   * 点击“单轮评估”。

   * 后端本轮开始时使用配置快照。

   * 大模型请求并发使用页面配置值。

   * Ark 请求使用页面选择的 endpoint。

