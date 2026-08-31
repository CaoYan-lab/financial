# GLM5.2 独立模型配置与盘前 K 线跨时段回填计划

## Summary

本次计划同时处理两个相关问题：

1. 在运行时大模型配置中新增 `GLM5.2`，模型名为 `glm-5.2`，接入地址为 `https://ark.cn-beijing.volces.com/api/coding`，并支持与现有 DeepSeek / Doubao 独立切换。
2. 修复盘前刚开始时“大模型一直返回/系统一直记录 `1 分钟 K 线不足 120 根`”的问题。只读检查确认：当前 Futu 回调缓存里的 K 线确实只有约 25 根，不是传给大模型的 input 上下文切片错误。原因是当前盘前 K 线种子只按 `ETH` 时段取数，盘前刚开始自然不足 120 根；用户已确认采用“跨时段回填”，即允许用夜盘/扩展时段历史 K 线补足模型窗口。

本计划不会改变交易动作语义、仓位计算、风控、订单类型选择或真实订单状态来源。

## Current State Analysis

### 1. 模型配置现状

已检查文件：

* `api/simulation/llmRuntimeConfigService.ts`

* `api/simulation/llmResponseUtils.ts`

* `src/pages/SimulationTradingView.tsx`

* `src/hooks/useSimulationTrading.ts`

* `shared/types.ts`

* `tests/llmRuntimeConfig.test.ts`

当前实现：

* `LLM_MODEL_OPTIONS` 只有两个 Ark 模型：

  * `ep-20260616231829-mnq2t` / `DeepSeek-v4-Pro`

  * `ep-20260410101451-dq9sg` / `Doubao-2.0-pro`

* 运行时配置只存储：

  * `model`

  * `concurrency`

  * `updatedAt`

* 模型调用入口是 `callArkResponses(...)`：

  * 当前统一使用 `process.env.ARK_API_KEY || process.env.DEEPSEEK_API_KEY`

  * 当前统一使用 `process.env.ARK_RESPONSES_URL || https://ark.cn-beijing.volces.com/api/v3/responses`

  * 当前日志会记录 `model`、`url`、耗时、状态，但不会记录 Authorization。

* 前端模型选择下拉框完全来自后端 `modelOptions`，因此新增选项后页面会自动出现。

* `.env.local` 存在，并且 `.gitignore` 中 `*.local` 已忽略，因此本地密钥适合放在 `.env.local`。

需要修正：

* 当前模型配置无法为不同模型选择不同 URL/API Key。

* GLM5.2 需要独立 URL 与独立 API Key，不能沿用现有 DeepSeek/Doubao 的 `ARK_RESPONSES_URL` 和 `ARK_API_KEY`。

* 不能把用户提供的明文 API Key 写进源码或日志。

### 2. K 线不足现状

已检查文件：

* `api/futu_bridge/futu_realtime_subscribe.py`

* `api/realtime/realtimeStore.ts`

* `api/simulation/realtimeDataAdapter.ts`

* `api/simulation/llmDataWindowAdvisor.ts`

* `api/simulation/simulationTradingEngine.ts`

* `tests/llmAutonomousTrading.test.ts`

当前运行时只读检查结果：

```text
marketState: PRE_MARKET_BEGIN
每个标的 klineBars: 约 25 根
每个标的 tickerPoints: 约 599-720 个
盘口 asks/bids: 10/10
```

结论：

* Futu 回调缓存中 1 分钟 K 线确实不足 120 根。

* 分时点和盘口深度是足够的。

* `loadStrategyMarketData(...)` 在大模型调用前做严格校验，K 线不足时不会调用大模型，而是记录跳过原因。

* 当前“1 分钟 K 线不足 120 根”不是模型 input 构造错误，而是数据窗口要求大于当前缓存实际可用 K 线数。

当前代码问题：

* `llmDataWindowAdvisor.ts` 给模型的数据可用范围是静态的：

  * K 线 `min: 30, max: 240`

  * 没有把当前盘前实际可用 K 线数量传给窗口顾问。

* `futu_realtime_subscribe.py` 在盘前状态下：

  * `history_session_for_market_state(PRE_MARKET_*)` 返回 `Session.ETH`

  * `request_history_kline(... session=Session.ETH)` 只拿当前 ETH 盘前累计数据，盘前刚开始自然只有几十根。

* 用户已确认希望用“跨时段回填”，即盘前/盘后/夜盘允许跨扩展时段取历史 K 线补足模型窗口。

## Proposed Changes

### 1. 扩展模型选项为“模型调用 Profile”

文件：`shared/types.ts`

变更：

* 扩展 `LlmModelOption` 类型，增加非敏感调用元数据：

```ts
export type LlmModelOption = {
  id: string
  label: string
  provider: 'ark'
  apiKeyEnv?: string
  urlEnv?: string
  defaultUrl?: string
}
```

说明：

* `apiKeyEnv` 只保存环境变量名称，不保存密钥值。

* `defaultUrl` 可以保存非敏感 URL。

* 前端不需要展示 `apiKeyEnv`，但后端响应中包含这些字段也不泄露密钥；如实现时希望更严格，可在返回给前端前剔除 `apiKeyEnv`。

文件：`api/simulation/llmRuntimeConfigService.ts`

变更：

* 新增 GLM5.2 模型选项：

```ts
{
  id: 'glm-5.2',
  label: 'GLM5.2',
  provider: 'ark',
  apiKeyEnv: 'GLM_API_KEY',
  urlEnv: 'GLM_RESPONSES_URL',
  defaultUrl: 'https://ark.cn-beijing.volces.com/api/coding',
}
```

* DeepSeek / Doubao 保持现有 id 和 label，但补齐默认 profile：

```ts
apiKeyEnv: 'ARK_API_KEY'
urlEnv: 'ARK_RESPONSES_URL'
defaultUrl: 'https://ark.cn-beijing.volces.com/api/v3/responses'
```

* 新增导出函数：

```ts
export function getActiveLlmModelOption(): LlmModelOption
```

用途：

* `getActiveArkModel()` 继续返回模型 id，兼容现有调用和测试。

* `getActiveLlmModelOption()` 给 `llmResponseUtils.ts` 决定当前模型的 URL 和 API Key 来源。

### 2. 按当前模型选择 URL/API Key

文件：`api/simulation/llmResponseUtils.ts`

变更：

* 从 `llmRuntimeConfigService.ts` 读取当前模型 profile。

* 选择 API Key 的规则：

  * 若当前模型 profile 指定 `apiKeyEnv`，优先读取该环境变量。

  * GLM5.2 使用 `process.env.GLM_API_KEY`。

  * DeepSeek / Doubao 使用 `process.env.ARK_API_KEY || process.env.DEEPSEEK_API_KEY`，保持兼容。

* 选择 URL 的规则：

  * 若当前模型 profile 指定 `urlEnv` 且环境变量存在，使用环境变量。

  * 否则使用 profile 的 `defaultUrl`。

  * GLM5.2 默认使用 `https://ark.cn-beijing.volces.com/api/coding`。

* 日志仍然只记录：

  * `model`

  * `url`

  * `inputMessageCount`

  * `durationMs`

  * 状态码和错误摘要

* 严禁记录：

  * API Key

  * Authorization

  * 完整 prompt

  * 账户资产明细

兼容性：

* 仍然使用当前请求体结构：

```ts
{
  model,
  temperature: 0,
  input,
}
```

* 继续使用 `extractOutputText(...)` 解析响应，兼容 `output_text`、`text`、`output[].content[].text`。

* 若 GLM `/api/coding` 返回格式不同，`extractOutputText(...)` 至少会回退 JSON 字符串，后续 `parseJsonObject(...)` 仍有机会解析；若验证失败，再基于实际返回补充解析分支。

### 3. 本地环境变量接入 GLM Key

文件：`.env.local`

变更：

* 新增：

```env
GLM_RESPONSES_URL=https://ark.cn-beijing.volces.com/api/coding
GLM_API_KEY=<用户提供的 GLM5.2 API Key>
```

安全约束：

* `.env.local` 已被 `.gitignore` 的 `*.local` 忽略。

* 实现时可以写入本地 `.env.local`，但不会把 Key 写进源码、测试、计划文件或日志。

* 如果最终响应需要说明，只说“已写入本地 `.env.local`”，不复述 Key。

### 4. 前端模型切换保持现有 UI

文件：`src/pages/SimulationTradingView.tsx`

变更：

* 不需要新增 UI 组件。

* 现有下拉框使用 `data.modelOptions`，新增 GLM5.2 后自动出现。

* 当前模型说明仍显示：

  * 模型 label

  * 并发

  * 更新时间

* 可选增强：如果后端返回 warnings，例如 `GLM_API_KEY missing`，页面现有 warnings 区域继续展示。

### 5. 盘前 K 线跨时段回填

文件：`api/futu_bridge/futu_realtime_subscribe.py`

变更：

* 调整 `history_session_for_market_state(...)`：

  * `MORNING` / `AFTERNOON` / `AUCTION` / `TRADE_AT_LAST`：继续 `Session.RTH`

  * `PRE_MARKET_BEGIN` / `PRE_MARKET_END`：改为 `Session.ALL`

  * `AFTER_HOURS_BEGIN` / `AFTER_HOURS_END`：改为 `Session.ALL`

  * `OVERNIGHT` / `NIGHT` / `NIGHT_OPEN`：继续 `Session.ALL`

  * fallback：`Session.ALL`

* 目的：

  * 盘前刚开始时不只拿当前盘前 25 根左右 K 线，而是允许拿夜盘 + 盘前的扩展时段历史，补足最多 240 根。

  * 保持当前 `extended_time=True`。

文件：`api/realtime/realtimeStore.ts`

计划不改：

* 当前 `MAX_KLINE_BARS = 240` 足够容纳回填窗口。

* `mergeKlineBars(...)` 按 `time` 去重合并，可以合并历史种子与实时 K 线回调。

### 6. 数据窗口建议加入实际可用性约束

文件：`api/simulation/llmDataWindowAdvisor.ts`

变更：

* 新增可选参数 `availability`，表示当前实时缓存可用数据窗口：

```ts
type DataWindowAvailability = {
  minKline1mBars: number
  minTickerPoints: number
  minOrderBookDepth: number
}
```

* `availableData.kline1mBars.max` 不再固定为 240，而是：

  * `Math.min(240, availability.minKline1mBars || 240)`

* `tickerPoints.max` 与 `orderBookDepth.max` 同理保守约束。

* `parseRecommendation(...)` 支持传入动态边界，确保模型即使返回 120，也会被裁剪到当前实际可用上限。

文件：`api/simulation/simulationTradingEngine.ts`

变更：

* 在 `start()` 或数据窗口咨询前，从 `realtimeStore` 读取当前股票池实时缓存可用性。

* 将可用性传给 `adviseDataWindow(...)`。

* 记录日志时只记录计数，不记录 prompt 或账户明细。

* 如果跨时段回填后 K 线仍不足最低要求：

  * 继续 fail-closed。

  * 跳过原因改得更明确，例如：`1 分钟 K 线不足：当前 25 / 要求 30，等待回填或预热。`

说明：

* 用户选择了“跨时段回填”，因此主要修复靠 Futu K 线 seed 使用 `Session.ALL`。

* 动态可用性约束是第二层保护，防止未来模型再次建议超过当前缓存上限的窗口。

### 7. 错误提示更可诊断

文件：`api/simulation/realtimeDataAdapter.ts`

变更：

* K 线不足原因从：

```text
1 分钟 K 线不足 120 根
```

改为：

```text
1 分钟 K 线不足：当前 25 / 要求 120
```

* 分时点、盘口深度也可按同样格式增强：

  * `分时点不足：当前 X / 要求 Y`

  * `买卖盘深度不足：当前 ask A / bid B / 要求 D`

目的：

* 下次页面能直接看出是真实数据不足，还是要求过高。

## Assumptions & Decisions

* GLM5.2 的模型 id 使用用户指定的 `glm-5.2`。

* GLM5.2 的默认 URL 使用用户指定的 `https://ark.cn-beijing.volces.com/api/coding`。

* GLM5.2 的 API Key 通过环境变量 `GLM_API_KEY` 接入，不写入源码。

* 可选 URL 环境变量命名为 `GLM_RESPONSES_URL`，用于未来切换 GLM 接入地址。

* DeepSeek / Doubao 继续使用现有 `ARK_API_KEY` / `ARK_RESPONSES_URL`，不改变默认模型。

* 当前默认模型仍保持 `DeepSeek-v4-Pro`，除非用户在页面手动切换到 GLM5.2。

* 配置变更仍遵循既有规则：保存后下一轮评估生效，不打断当前执行轮次。

* K 线不足问题的真实现状是 Futu 缓存确实不足 120 根；不是大模型 input 上下文切片错误。

* 盘前/盘后/夜盘允许跨时段回填 K 线；盘中仍优先使用 RTH K 线。

* 若 GLM `/api/coding` 的响应格式与现有 Ark Responses 完全不兼容，执行阶段会通过 `llm-test` 或单次调用结果暴露，并基于真实响应补解析，不猜测密钥或 prompt 内容。

## Verification Steps

### 静态检查

```bash
PATH="$PWD/.tools/node/bin:$PATH" node_modules/.bin/tsc --noEmit
python3 -m py_compile api/futu_bridge/futu_realtime_subscribe.py
```

### 单元测试

```bash
PATH="$PWD/.tools/node/bin:$PATH" node_modules/.bin/vitest run tests/llmRuntimeConfig.test.ts tests/llmAutonomousTrading.test.ts tests/realtimeStore.test.ts
```

新增/调整测试点：

* `llmRuntimeConfig.test.ts`

  * `modelOptions` 包含 `glm-5.2 / GLM5.2`。

  * 切换到 `glm-5.2` 后 `getActiveArkModel()` 返回 `glm-5.2`。

  * `getActiveLlmModelOption()` 返回 GLM profile，包含 `apiKeyEnv: GLM_API_KEY` 与 GLM URL。

* `llmAutonomousTrading.test.ts`

  * 数据窗口建议会按动态可用 K 线数裁剪。

  * K 线不足错误包含当前数量和要求数量。

* `realtimeStore.test.ts`

  * 已有 K 线合并去重逻辑保持通过。

### 运行时验证

1. 重启或重新启动实时订阅 Python 子进程，让 `Session.ALL` 回填逻辑生效。
2. 查询实时缓存：

```bash
curl -sS http://127.0.0.1:3001/api/realtime/TSM
```

验收：

* 盘前 `marketState` 为 `PRE_MARKET_BEGIN`。

* `klineBars.length` 应从约 25 提升到接近或达到模型窗口上限，至少应能满足 `120`。

* `tickerPoints` 和 `orderBook` 继续正常。

1. 查询模拟盘 dashboard：

```bash
curl -sS http://127.0.0.1:3001/api/simulation/dashboard
```

验收：

* 模型选项包含 GLM5.2。

* 当前默认模型未被强制切换。

1. 前端验收：

* 打开 `http://localhost:5173/simulation`。

* 大模型配置下拉框出现 `GLM5.2`。

* 选择并保存 GLM5.2 后，当前模型显示 `GLM5.2`。

* 重新切回 DeepSeek/Doubao 也正常。

1. GLM 连通性验收：

* 设置本地环境变量后，调用 `/api/simulation/llm-test` 或在停止状态下仅做测试请求。

* 成功时日志只显示模型、URL、耗时和状态，不出现 API Key、Authorization 或完整 prompt。

