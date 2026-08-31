# 长桥实盘历史列表 SQLite 分表持久化计划

## Summary

当前 `/longbridge/live-trading` 点击“启动实盘评估”后，页面顶部能显示“最近一次评估”，但下方“历史策略信号”“候选池历史”“待确认订单队列”仍然是静态空表或进程内状态。这与实盘测试需求不一致。

目标是：

* 长桥历史策略信号必须入库，并能在页面历史策略 list 展示。

* 长桥历史策略 list、待确认订单 list、候选池 list 与 Futu 使用同一个 SQLite 文件，但使用独立物理表。

* 不写入 Futu `live_events` 表，不复用 Futu 的 `signals / pending_orders / candidate_pool` kind。

* Longbridge 页面 list 从 Longbridge 分表读取，刷新页面或重启服务后仍可见。

* Futu 现有链路不改行为、不迁表、不污染。

## Current State Analysis

### 1. Futu 当前持久化结构

相关文件：

* `api/live/livePersistence.ts`

* `api/futu_bridge/live_history_db.py`

* `api/routes/liveTradingRoutes.ts`

* `src/hooks/useLiveTrading.ts`

* `src/pages/LiveTradingView.tsx`

Futu live 当前默认 SQLite 文件：

* `.data/live-trading-history.sqlite3`

* 可被 `LIVE_TRADING_HISTORY_DB_PATH` 覆盖。

Futu 物理表：

* `live_events`

Futu 在 `live_events.kind` 中区分：

* `signals`

* `pending_orders`

* `submitted_orders`

* `rejected_orders`

* `skipped`

* `confirmations`

* `candidate_pool`

Futu 页面通过接口读取历史：

* `GET /api/live-trading/history/signals`

* `GET /api/live-trading/history/pending-orders`

* `GET /api/live-trading/history/candidate-pool`

* `GET /api/live-trading/history/submitted-orders`

* `GET /api/live-trading/history/rejected-orders`

* `GET /api/live-trading/history/skipped`

Futu 的生命周期分页逻辑集中在 `api/futu_bridge/live_history_db.py`，包括：

* `paginate_signal_lifecycle`

* `paginate_pending_order_lifecycle`

* `paginate_candidate_pool_history`

### 2. Longbridge 当前持久化结构

相关文件：

* `api/longbridge/longbridgePersistence.ts`

* `api/longbridge/longbridgeLiveTradingEngine.ts`

* `api/longbridge/longbridgeCandidatePoolService.ts`

* `api/longbridge/longbridgeOrderQueueService.ts`

* `api/routes/longbridgeRoutes.ts`

* `src/pages/longbridge/LongbridgeLiveTradingView.tsx`

Longbridge 当前状态：

* `longbridgePersistence.ts` 使用进程内数组：

  * `signals: LiveSignalHistoryItem[]`

  * `pendingOrders: LivePendingOrder[]`

  * `candidatePool: LongbridgeCandidateRecord[]`

* `runOnceDryRun()` 调用了 `longbridgePersistence.appendSignal(signal)`，但只写内存。

* `longbridgeCandidatePoolService.upsert()` 调用了 `appendCandidate()`，但只写内存。

* `longbridgeOrderQueueService.createPendingOrder()` 调用了 `appendPendingOrder()`，但只写内存。

* 重启后 Longbridge 历史信号、候选池、待确认订单都会丢失。

Longbridge 当前 API：

* `GET /api/longbridge/live-trading/dashboard`

* `POST /api/longbridge/live-trading/run-once`

* `POST /api/longbridge/live-trading/pending-orders/:id/confirm`

缺少：

* `GET /api/longbridge/live-trading/history/signals`

* `GET /api/longbridge/live-trading/history/pending-orders`

* `GET /api/longbridge/live-trading/history/candidate-pool`

### 3. Longbridge 当前页面问题

相关文件：

* `src/pages/longbridge/LongbridgeLiveTradingView.tsx`

当前页面问题：

* 顶部 metric “历史策略信号”会读取 `liveDashboard.signals.length`，但来源仍是进程内数组。

* “历史策略信号（0）”标题写死为 0。

* 历史策略信号表使用 `EmptyTable`，没有渲染真实 rows。

* “待确认订单队列（0）”标题写死为 0。

* 待确认订单过滤按钮只是静态按钮，没有状态和分页。

* 候选池历史使用 `EmptyTable`，没有连接候选池 history API。

### 4. 需要保留的约束

* Futu 代码行为不能被破坏。

* Longbridge 真实订单提交仍受 `LONGBRIDGE_LIVE_TRADING_ENABLED=true` 门禁保护。

* 本任务只做 Longbridge dry-run 历史、候选池、待确认订单入库和页面 list 展示，不实现 Longbridge 真实下单。

* Longbridge 数据源仍来自 Longbridge CLI / Skill / MCP。

* Longbridge 策略和 Prompt 仍复用 `trade_strategy` 下当前 live 配置。

## Proposed Changes

### 1. 新增长桥 SQLite bridge

新增文件：

* `api/longbridge/longbridge_live_history_db.py`

使用同一个 SQLite 文件：

* 默认：`.data/live-trading-history.sqlite3`

* 环境变量：`LIVE_TRADING_HISTORY_DB_PATH`

新增 Longbridge 独立物理表：

* `longbridge_live_signals`

* `longbridge_live_pending_orders`

* `longbridge_live_submitted_orders`

* `longbridge_live_rejected_orders`

* `longbridge_live_skipped`

* `longbridge_live_confirmations`

* `longbridge_live_candidate_pool`

每张表建议字段保持一致，便于分页和 JSON payload 扩展：

```sql
CREATE TABLE IF NOT EXISTS longbridge_live_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT,
  side TEXT,
  strategy TEXT,
  status TEXT,
  ok INTEGER,
  created_at TEXT NOT NULL,
  payload TEXT NOT NULL
);
```

其他表同结构，只改表名。索引：

```sql
CREATE INDEX IF NOT EXISTS idx_<table>_created_at ON <table>(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_<table>_ticker_created_at ON <table>(ticker, created_at DESC, id DESC);
```

bridge action 需要支持：

* `append`

* `read_latest`

* `paginate`

* `paginate_signal_lifecycle`

* `paginate_pending_order_lifecycle`

* `paginate_candidate_pool_history`

* `get_event_by_id`

* `find_event_by_payload_field`

* `clear`

实现策略：

* 复制并改造 `api/futu_bridge/live_history_db.py` 的成熟逻辑。

* 将 Futu 的 `live_events WHERE kind = ?` 查询改为 Longbridge 分表查询。

* 不修改 Futu `live_history_db.py` 的行为。

* 表名只能从白名单映射获得，禁止把客户端输入直接拼进 SQL。

表名映射：

```py
TABLES = {
  "signals": "longbridge_live_signals",
  "pending_orders": "longbridge_live_pending_orders",
  "submitted_orders": "longbridge_live_submitted_orders",
  "rejected_orders": "longbridge_live_rejected_orders",
  "skipped": "longbridge_live_skipped",
  "confirmations": "longbridge_live_confirmations",
  "candidate_pool": "longbridge_live_candidate_pool",
}
```

### 2. 改造 Longbridge persistence 为 SQLite 持久化

更新文件：

* `api/longbridge/longbridgePersistence.ts`

改造目标：

* 保留现有 public API，减少调用方改动：

  * `appendSignal(signal)`

  * `appendPendingOrder(order)`

  * `replacePendingOrder(order)`

  * `appendCandidate(record)`

  * `latestSignals()`

  * `latestPendingOrders()`

  * `activePendingOrders()`

  * `latestCandidates()`

  * `findPendingOrder(id)`

  * `clearForTests()`

* 新增分页能力：

  * `paginateSignalLifecycle(page, pageSize, direction, lifecycleStatus, ticker)`

  * `paginatePendingOrderLifecycle(page, pageSize, status, ticker, side)`

  * `paginateCandidatePoolHistory(page, pageSize, statusGroup)`

  * `paginate(kind, page, pageSize)`

底层实现：

* 用 `spawnSync` 调用 `api/longbridge/longbridge_live_history_db.py`。

* Python bin 沿用 `FUTU_PYTHON_BIN || 'python3'`，避免新增环境变量。

* DB path 使用 `LIVE_TRADING_HISTORY_DB_PATH || .data/live-trading-history.sqlite3`。

* `NODE_ENV === 'test' && process.env.LIVE_PERSIST_TEST !== '1'` 时仍可禁用持久化，保持现有单测轻量。

`replacePendingOrder(order)`：

* 不做 SQLite update，按现有 event-sourcing 模式 append 一条新的 `pending_orders` 记录。

* lifecycle 分页以最新 `updatedAt/createdAt/historyId` 计算最终状态。

`appendCandidate(record)`：

* 直接 append 到 `longbridge_live_candidate_pool`。

* lifecycle 分页以 `candidateId` 聚合最新记录，行为与 Futu candidate pool 一致。

### 3. 补齐 Longbridge history API

更新文件：

* `api/routes/longbridgeRoutes.ts`

新增接口：

* `GET /api/longbridge/live-trading/history/signals`

* `GET /api/longbridge/live-trading/history/pending-orders`

* `GET /api/longbridge/live-trading/history/candidate-pool`

参数与 Futu 对齐：

`signals`：

* `page`

* `pageSize`

* `direction`

* `lifecycleStatus`

* `ticker`

`pending-orders`：

* `page`

* `pageSize`

* `status`

* `ticker`

* `side`

`candidate-pool`：

* `page`

* `pageSize`

* `statusGroup=ACTIVE|INACTIVE`

后续可选但本轮不必须：

* `GET /api/longbridge/live-trading/history/submitted-orders`

* `GET /api/longbridge/live-trading/history/rejected-orders`

* `GET /api/longbridge/live-trading/history/skipped`

### 4. 确保 run-once 后真正入库

检查并保持现有调用链：

* `api/longbridge/longbridgeLiveTradingEngine.ts`

  * `longbridgePersistence.appendSignal(signal)` 必须写入 `longbridge_live_signals`。

  * candidate mode 下 `longbridgeCandidatePoolService.upsert()` 必须写入 `longbridge_live_candidate_pool`。

  * promoted candidate 创建 pending order 后必须写入 `longbridge_live_pending_orders`。

  * legacy direct 下非 HOLD pending order 必须写入 `longbridge_live_pending_orders`。

需要补强：

* `dashboard()` 不再只读内存数组，应读 SQLite latest。

* `resetForTests()` 调用 SQLite clear。

* `activePendingOrders()` 从 SQLite latest/pending lifecycle 中读取最终仍为 `PENDING_CONFIRMATION | CONFIRMED_SUBMITTING` 的订单，避免重启后重复生成或丢失待确认订单。

### 5. 前端新增 Longbridge live hook

新增文件：

* `src/hooks/useLongbridgeLiveTrading.ts`

职责类似 `src/hooks/useLiveTrading.ts`，但只连接 Longbridge 接口：

* `GET /api/longbridge/live-trading/dashboard`

* `POST /api/longbridge/live-trading/run-once`

* `GET /api/longbridge/live-trading/history/signals`

* `GET /api/longbridge/live-trading/history/pending-orders`

* `GET /api/longbridge/live-trading/history/candidate-pool`

状态：

* `data: LongbridgeLiveTradingDashboardResponse`

* `history.signals`

* `history['pending-orders']`

* `history['candidate-pool']`

* filters：

  * pending order status/ticker/side

  * signal ticker/direction/lifecycle

  * candidate pool status group

* `refreshAll()`

* `runOnce()`

* `setHistoryPage()`

* filter setters

不包含：

* Futu orders。

* Futu REAL order detail 跳转。

* Futu confirm submit。

### 6. Longbridge 页面 list 接入真实数据

更新文件：

* `src/pages/longbridge/LongbridgeLiveTradingView.tsx`

替换当前静态空表：

#### 历史策略信号

从：

* `EmptyTable title=""`

* 标题写死 `历史策略信号（0）`

改为：

* 读取 `history.signals`

* 标题显示 `history.signals.total`

* 展示列：

  * 标的

  * 方向

  * 生命周期状态

  * 模型

  * 时间

  * 理由

* 支持方向、生命周期、ticker 筛选。

* 支持分页。

#### 待确认订单队列

从：

* 标题写死 `待确认订单队列（0）`

* 静态筛选按钮

* 空状态固定展示

改为：

* 读取 `history['pending-orders']`

* 标题显示真实 total。

* 渲染 Longbridge pending order cards。

* 展示：

  * 标的 / 方向

  * 数量 / 价格

  * 状态

  * 来源：候选池裁决 / 大模型直推

  * 入队时间

  * 风险提示摘要

* 筛选按钮真正调用 hook filter setters。

* 支持分页。

* 不新增下级详情页跳转。

* confirm 按钮仍调用 `/api/longbridge/live-trading/pending-orders/:id/confirm`，并展示门禁关闭错误，不提交真实订单。

#### 候选池历史

从：

* `EmptyTable title="候选池历史（0）"`

改为：

* 读取 `history['candidate-pool']`

* 支持 `ACTIVE / INACTIVE` 筛选。

* 展示列：

  * 候选

  * 分组

  * 确认次数

  * 价格偏离

  * 名义金额

  * 状态

  * 时间

  * 裁决说明

* 支持分页。

### 7. 类型补充

更新文件：

* `shared/longbridgeTypes.ts`

补充：

* Longbridge history state 所需类型不重复定义共享基础类型。

* `LongbridgeHistoryKind` 扩展为：

  * `signals`

  * `pending-orders`

  * `candidate-pool`

  * 如实现额外接口，再包含 `submitted-orders/rejected-orders/skipped`。

保持：

* `LongbridgeLiveTradingDashboardResponse.signals`

* `pendingOrders`

* `candidatePool`

### 8. 测试补充

新增或更新测试：

* `tests/longbridgeLiveTradingDryRun.test.ts`

新增用例：

1. `runOnceDryRun()` 后，历史策略信号入库：

   * 设置 `LIVE_PERSIST_TEST=1`

   * 设置临时 `LIVE_TRADING_HISTORY_DB_PATH`

   * mock LLM 返回 `HOLD`

   * 断言 `longbridgePersistence.paginateSignalLifecycle(...).total >= 1`

   * 断言重置内存不影响 SQLite 读取。

2. Longbridge 与 Futu 分表隔离：

   * Longbridge 写入 signal。

   * Futu `livePersistence.paginateSignalLifecycle()` 不应读到 Longbridge signal。

   * SQLite 中应存在 `longbridge_live_signals`，且 Futu `live_events` 不增加 Longbridge kind。

3. 非 HOLD legacy direct 入库 pending order：

   * mock LLM 返回 `BUY`。

   * `executionMode='legacy_direct'`。

   * 断言 `longbridge_live_pending_orders` 有记录。

   * `paginatePendingOrderLifecycle()` 返回 `PENDING_CONFIRMATION`。

4. candidate pool 入库：

   * `executionMode='candidate_pool'`。

   * mock LLM 返回 `BUY`。

   * mock portfolio review 推进或 watch。

   * 断言 `longbridge_live_candidate_pool` 有记录。

   * `paginateCandidatePoolHistory()` 可分页读取。

5. confirm 门禁状态入库：

   * 创建 Longbridge pending order。

   * 调用 `confirmPendingOrder()`，门禁关闭。

   * 断言订单仍为 `PENDING_CONFIRMATION` 或记录安全阻断状态符合当前门禁设计。

也可新增：

* `tests/longbridgeLivePersistence.test.ts`

用于隔离测试 `longbridgePersistence` 与 Python bridge，不依赖真实 Longbridge CLI 和真实 LLM。

## Assumptions & Decisions

* 使用同一个 SQLite 文件 `.data/live-trading-history.sqlite3`，满足“与 Futu 用同一个 SQLite”。

* 使用 Longbridge 独立物理表，满足“分表”，不把 Longbridge 数据写入 Futu `live_events`。

* 不迁移历史内存数据；此前 Longbridge in-memory 数据本来重启即丢，本次从改造后开始持久化。

* 不修改 Futu 表结构和 Futu API 行为。

* Longbridge 真实订单提交仍不实现，确认接口继续受 `LONGBRIDGE_LIVE_TRADING_ENABLED` 门禁保护。

* 页面 list 只做 Longbridge 自己的数据展示，不跳转 Futu 订单详情。

* 分页和筛选交互优先复刻 Futu 页已有体验，但 Longbridge 保持青蓝/靛蓝视觉风格。

## Verification Steps

基础验证：

```bash
PATH="$PWD/.tools/node/bin:$PATH" npm run check
```

Longbridge persistence 单测：

```bash
PATH="$PWD/.tools/node/bin:$PATH" npm test -- tests/longbridgeLivePersistence.test.ts
```

Longbridge dry-run 和门禁测试：

```bash
PATH="$PWD/.tools/node/bin:$PATH" npm test -- tests/longbridgeLiveTradingDryRun.test.ts
```

真实 Longbridge dry-run 集成测试：

```bash
PATH="$PWD/.tools/node/bin:$PATH" RUN_LONGBRIDGE_INTEGRATION=1 RUN_LONGBRIDGE_LLM_INTEGRATION=1 RUN_LONGBRIDGE_DRY_RUN=1 npm test -- tests/longbridgeLiveTradingDryRun.test.ts
```

手工 API 验证：

```bash
curl http://localhost:3001/api/longbridge/live-trading/history/signals
curl http://localhost:3001/api/longbridge/live-trading/history/pending-orders
curl http://localhost:3001/api/longbridge/live-trading/history/candidate-pool
```

手工页面验收：

1. 进入 `/longbridge/live-trading`。
2. 点击“启动实盘评估”或“单轮评估”。
3. 如果 LLM 返回 HOLD：

   * 顶部最近一次评估显示 HOLD。

   * 历史策略信号 list 新增一条 HOLD。

   * 刷新页面后该记录仍存在。
4. 如果 LLM 返回非 HOLD：

   * 历史策略信号 list 新增一条非 HOLD。

   * 组合策略开启时，候选池历史出现候选记录。

   * 如果组合裁决推进，待确认订单队列出现 Longbridge 待确认订单。
5. 检查 Futu `/live-trading` 历史策略、候选池、待确认订单不出现 Longbridge 数据。

SQLite 手工检查：

```bash
sqlite3 .data/live-trading-history.sqlite3 ".tables"
sqlite3 .data/live-trading-history.sqlite3 "select count(*) from longbridge_live_signals;"
sqlite3 .data/live-trading-history.sqlite3 "select count(*) from longbridge_live_pending_orders;"
sqlite3 .data/live-trading-history.sqlite3 "select count(*) from longbridge_live_candidate_pool;"
```

验收标准：

* Longbridge run-once 后历史策略信号真实入库。

* Longbridge 页面历史策略 list 不再固定为空。

* Longbridge 待确认订单和候选池 list 来自 SQLite 分表。

* Futu 数据与 Longbridge 数据互不串表。

* 服务重启后 Longbridge 历史记录仍可读取。

* 所有真实提交仍被 Longbridge 门禁保护。

