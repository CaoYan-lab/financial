# 真实操作盘原型模型配置补充计划

## Summary

用户指出当前 `live_trading_prototype.html` 原型缺少“模型配置切换、并发切换”模块。经只读核对，模拟盘已有完整运行时模型配置能力：默认值来自环境变量 `ARK_MODEL` 与 `LLM_DECISION_CONCURRENCY`，运行中通过 `/api/simulation/llm-config` 获取和保存，并持久化到 SQLite。真实操作盘应沿用这套模型配置机制，不新增一套独立模型配置体系。

本计划用于修正原型与后续实盘实现设计：在真实操作盘原型中补充“运行时模型与并发”区块，并在实盘编码阶段复用现有 `llmRuntimeConfigService.ts` 的模型选项、默认值、保存行为和并发上限规则。

## Current State Analysis

### 模拟盘现有实现

- `api/simulation/llmRuntimeConfigService.ts`
  - 默认模型：`process.env.ARK_MODEL || DEFAULT_MODEL`
  - 默认并发：`process.env.LLM_DECISION_CONCURRENCY || 6`
  - 现有模型选项：
    - `DeepSeek-v4-Pro`
    - `Doubao-2.0-pro`
    - `GLM5.2`
  - GLM 使用：
    - `GLM_API_KEY`
    - `GLM_RESPONSES_URL`
    - `chat_completions` 协议
  - DeepSeek / Doubao 使用：
    - `ARK_API_KEY`
    - `ARK_RESPONSES_URL`
    - `responses` 协议
  - 配置持久化：
    - key: `llm_runtime_config`
    - 当前写入模拟盘 SQLite bridge。

- `api/routes/simulationRoutes.ts`
  - `GET /api/simulation/llm-config`
  - `PUT /api/simulation/llm-config`

- `src/pages/SimulationTradingView.tsx`
  - 已有“大模型配置”区块。
  - 包含：
    - 当前模型展示。
    - 当前并发 / 最大并发展示。
    - 模型下拉选择。
    - 并发下拉选择。
    - 保存配置按钮。
  - 保存后从下一轮评估生效。

- `src/hooks/useSimulationTrading.ts`
  - `saveLlmConfig(input)` 调用 `/api/simulation/llm-config`。

### 当前真实操作盘原型遗漏

- `.trae/documents/live_trading_prototype.html`
  - 已包含“模型与数据窗口”展示卡。
  - 但没有可切换模型的 select。
  - 没有并发下拉。
  - 没有“保存配置，下轮生效”按钮。
  - 没有体现沿用 `ARK_MODEL` / `LLM_DECISION_CONCURRENCY` 默认配置。

## Decisions

1. 真实操作盘必须包含“大模型配置”模块，结构与模拟盘保持一致。
2. 模型选项必须沿用现有 `LLM_MODEL_OPTIONS`：
   - DeepSeek-v4-Pro
   - Doubao-2.0-pro
   - GLM5.2
3. 并发上限按实盘股票池数量计算，规则沿用模拟盘：
   - 最小 1。
   - 最大为当前 universe 数量。
   - 默认来自 `LLM_DECISION_CONCURRENCY`，未配置时为 6。
4. 默认模型仍来自 `ARK_MODEL`，未配置时使用当前默认 DeepSeek-v4-Pro。
5. 实盘与模拟盘可以共用同一个运行时模型配置，确保用户切换模型后两个交易环境对齐；如果后续用户希望分离，再增加独立配置 key。
6. 原型中必须明确“保存后从下一轮实盘评估生效”，避免误解为立即影响正在进行的 LLM 请求。

## Proposed Prototype Changes

文件：`.trae/documents/live_trading_prototype.html`

需要新增或替换一个独立区块：

### 区块标题

- `大模型配置`
- 副标题：`沿用模拟盘运行时配置，默认来自 ARK_MODEL / LLM_DECISION_CONCURRENCY`

### 区块内容

1. 当前配置摘要：
   - 当前模型：`GLM5.2`
   - 当前并发：`6 / 11`
   - 更新时间：`2026-06-17T...`
   - 生效规则：`保存后从下一轮评估生效`

2. 模型选择：
   - select 样式控件。
   - 选项：
     - `DeepSeek-v4-Pro`
     - `Doubao-2.0-pro`
     - `GLM5.2`

3. 并发选择：
   - select 样式控件。
   - 选项示例：`1` 到 `11`。
   - 辅助文案：`并发越高，评估越快，但受 RPM / TPM 限制。`

4. 保存按钮：
   - `保存配置`
   - 按钮旁提示：`不会提交订单，只影响后续 LLM 决策请求。`

5. 环境变量说明：
   - `ARK_MODEL`
   - `LLM_DECISION_CONCURRENCY`
   - `ARK_API_KEY / ARK_RESPONSES_URL`
   - `GLM_API_KEY / GLM_RESPONSES_URL`

### 布局位置

建议放在原型主区域中：

1. 实盘账户资产卡片之后。
2. 策略股票池与数据窗口之前，或与“模型与数据窗口”合并为左右双栏。

为了和模拟盘页面保持认知一致，推荐新增独立卡片，不只做小提示。

## Proposed Implementation Changes Later

后续进入代码实现时，不在当前步骤执行。

### 1. 后端复用配置服务

文件：未来 `api/live/liveTradingEngine.ts`

- 从现有 `api/simulation/llmRuntimeConfigService.ts` 导入：
  - `getLlmRuntimeConfig`
  - `updateLlmRuntimeConfig`
  - `getActiveDecisionConcurrency`
- 实盘 engine dashboard 返回：
  - `llmRuntimeConfig`
  - `modelOptions`

如果需要避免从 `api/simulation` 目录跨域引用，可后续重构为：

- `api/llm/llmRuntimeConfigService.ts`

但第一版不强制重构，避免扩大范围。

### 2. 实盘 API 增加配置接口

文件：未来 `api/routes/liveTradingRoutes.ts`

- `GET /api/live-trading/llm-config`
  - 直接返回 `getLlmRuntimeConfig()`。

- `PUT /api/live-trading/llm-config`
  - 调用 `updateLlmRuntimeConfig({ model, concurrency })`。
  - 日志事件建议：
    - `live.api.llm_config_update`

### 3. 前端 Hook 增加保存能力

文件：未来 `src/hooks/useLiveTrading.ts`

- 增加 `saveLlmConfig(input)`。
- 调用 `/api/live-trading/llm-config`。
- 更新 dashboard 中的：
  - `llmRuntimeConfig`
  - `modelOptions`
  - `warnings`

### 4. 实盘页面增加配置 UI

文件：未来 `src/pages/LiveTradingView.tsx`

- 复制模拟盘 `SimulationTradingView.tsx` 的“大模型配置”区块。
- 文案改为实盘：
  - `保存后从下一轮实盘评估生效。`
  - `不会绕过人工确认；模型切换只影响信号生成。`
- 风险提示：
  - `并发变高只加速生成候选订单，不会自动提交真实订单。`

## Interaction Rules

1. 保存模型配置不会启动引擎。
2. 保存模型配置不会提交订单。
3. 如果实盘引擎正在运行，配置从下一轮评估生效。
4. 如果选择的模型缺少 API Key，后端返回 warning，并保留现有配置或使用默认配置。
5. 并发超过 universe 数量时自动 clamp 到 universe 数量。

## Verification Steps

原型修正后验证：

1. 打开 `.trae/documents/live_trading_prototype.html`。
2. 确认可见“大模型配置”独立区块。
3. 确认可见模型选择项：
   - DeepSeek-v4-Pro
   - Doubao-2.0-pro
   - GLM5.2
4. 确认可见并发选择与最大并发说明。
5. 确认可见“保存后从下一轮评估生效”。
6. 确认文案说明模型切换不会绕过实盘人工确认。

编码阶段验证：

1. `GET /api/live-trading/llm-config` 返回现有模型选项。
2. `PUT /api/live-trading/llm-config` 可保存模型与并发。
3. 实盘 dashboard 返回更新后的 `llmRuntimeConfig`。
4. 实盘 engine 使用 `getActiveDecisionConcurrency()` 控制并发。
5. 模拟盘现有 `llmRuntimeConfig` 测试继续通过。

## Acceptance Criteria

1. 真实操作盘原型包含模型配置切换和并发切换模块。
2. 原型明确沿用模拟盘运行时配置机制和环境变量默认值。
3. 原型明确保存配置不会提交真实订单，也不会绕过人工确认。
4. 后续实盘实现复用现有模型配置选项，不新增第二套模型列表。
5. 并发规则与模拟盘一致，并受股票池数量限制。
