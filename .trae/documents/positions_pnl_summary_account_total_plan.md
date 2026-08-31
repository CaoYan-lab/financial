# 持仓父级盈亏汇总与账户总盈亏口径调整计划

## Summary

本计划覆盖用户最新提出的两项口径与展示调整：

1. 持仓父层级不能只显示一个市值数字，需要明确文字标签，并补充父层级总盈亏。
2. 父层级总盈亏等于该股票/标的下所有子持仓 `unrealizedPnL` 之和。
3. 账户总览里的 `总盈亏` 不再直接展示 Futu 账户字段，而应等于当前持仓列表所有子持仓 `unrealizedPnL` 之和。

本计划只规划，不执行代码改动；确认后再实施。

## Current State Analysis

### 1. 持仓父层级展示

相关文件：

- `src/components/workspace/PositionsPanel.tsx`

当前状态：

- `groupPositions()` 每个父组只计算：
  - `stockCount`
  - `optionCount`
  - `marketValue`
  - `items`
- 父层级 badge 当前显示：
  - `正股 N`
  - `期权 N`
  - `$18,674`
  - `收起/展开`
- `$18,674` 没有“市值”标签，用户看不出含义。
- 父层级没有显示 `总盈亏`。

### 2. 子层盈亏字段

相关文件：

- `shared/types.ts`
- `api/futu_bridge/futu_account.py`
- `src/components/workspace/PositionsPanel.tsx`

当前状态：

- `Position` 已有：
  - `marketValue`
  - `unrealizedPnL`
  - `pnlRatio`
  - `positionRatio`
- `futu_account.py` 已从 Futu `pl_val` 写入：
  - `unrealizedPnL`
- 前端已经可以用 `unrealizedPnL` 做子行盈亏染色。

### 3. 账户总览总盈亏

相关文件：

- `api/futu_bridge/futu_account.py`
- `src/components/workspace/AccountSummaryPanel.tsx`

当前状态：

- `fetch_summary()` 中 `totalPnL` 当前直接来自 Futu 账户字段：

```py
"totalPnL": money(row.get("total_pl_val")),
```

- 这可能与当前持仓列表子项盈亏合计不一致。
- 用户明确要求账户总览的总盈亏等于所有持仓总盈亏之和。

## Proposed Changes

### 1. `src/utils/displayText.ts`

复用现有 `parseSignedNumber()`，用于解析：

- `$-184`
- `-$184`
- `$615.50`
- `+12.3%`
- `unavailable`

不新增重复解析逻辑。

### 2. `src/components/workspace/PositionsPanel.tsx`

#### 父组计算新增字段

在 `groupPositions()` 中新增：

- `totalMarketValue`
  - 当前父组所有子持仓 `marketValue` 的数值和。
  - 如果无法解析，则回退为已有逻辑或 `unavailable`。
- `totalPnL`
  - 当前父组所有子持仓 `unrealizedPnL` 的数值和。
  - 若全部不可解析，则显示 `不可用/unavailable`。
- `pnlCount`
  - 成功参与求和的子项数量，用于避免误把全部不可用求成 `$0.00`。

#### 父层 UI 调整

父层 badge 从无标签数字改为明确标签：

```text
市值 $18,674
总盈亏 $-184
正股 0
期权 1
收起
```

英文模式：

```text
Market Value $18,674
Total P/L $-184
0 stocks
1 options
Collapse
```

#### 父层总盈亏颜色

- 正数：红色。
- 负数：绿色。
- 零值/不可用：灰色。
- 复用 `ProfitValue`，保证和子层颜色一致。

#### 排序逻辑

- 仍按父组市值排序。
- 排序字段改为 `totalMarketValue`，比当前“优先正股市值，否则第一条市值”更准确。

### 3. `src/components/workspace/AccountSummaryPanel.tsx`

#### 组件输入调整

当前：

```ts
export default function AccountSummaryPanel({ summary }: { summary?: AccountSummary })
```

调整为：

```ts
export default function AccountSummaryPanel({
  summary,
  positions = [],
}: {
  summary?: AccountSummary
  positions?: Position[]
})
```

#### 总盈亏口径

- `总盈亏` 展示值改为前端根据 `positions[].unrealizedPnL` 求和。
- 如果所有持仓 `unrealizedPnL` 都不可用，则回退展示 `summary?.totalPnL`，并保持不可用/灰色逻辑。
- 保留 `summary.totalPnL` 字段不删除，作为后端原始账户字段和 fallback。

#### 当日盈亏口径

- `当日盈亏` 暂不改，仍使用 `summary?.dailyPnL`。
- 原因：当前持仓子层只有总未实现盈亏，没有逐持仓当日盈亏字段，不能可靠求和。

### 4. `src/pages/Dashboard.tsx`

将 positions 传给账户总览：

```tsx
<AccountSummaryPanel
  summary={accountDashboard?.summary}
  positions={accountDashboard?.positions ?? []}
/>
```

### 5. `api/futu_bridge/futu_account.py`

建议保持后端原始字段不变，第一版不强行覆盖 `summary.totalPnL`：

- 后端继续返回 Futu 原始 `total_pl_val`。
- 前端工作台按用户口径展示“持仓求和总盈亏”。
- 如后续需要 API 层也统一口径，再新增字段：
  - `summary.positionsTotalPnL`
  - 或在后端 fetch positions 后覆盖 `summary.totalPnL`

本轮推荐前端计算，原因：

- 变更范围更小。
- 不破坏 `/api/account/summary` 对 Futu 原始账户字段的语义。
- 页面展示能立即满足“账户总览总盈亏 = 持仓总盈亏之和”。

## Data Rules

- 只对可解析的 `unrealizedPnL` 求和。
- 全部不可解析时，不显示 `$0.00`，避免误导。
- 格式化输出统一为美元金额：
  - 正数：`$615.50`
  - 负数：`$-184.00`
  - 不可用：中文 `不可用`，英文 `unavailable`
- 颜色规则延续当前已确认设计：
  - 正数红色。
  - 负数绿色。
  - 零值/不可用灰色。

## Verification Steps

### 自动化验证

执行：

```bash
PATH=/Users/ShockCao/AICoding/Financial/.tools/node/bin:$PATH npm run check
PATH=/Users/ShockCao/AICoding/Financial/.tools/node/bin:$PATH npm test
PATH=/Users/ShockCao/AICoding/Financial/.tools/node/bin:$PATH npm run build
```

验收：

- TypeScript 无错误。
- 现有测试通过。
- 构建成功。

### 浏览器验证

首页持仓：

- 父层显示 `市值 $...`，不是裸数字。
- 父层显示 `总盈亏 $...`。
- 父层 `总盈亏` 等于展开子层所有 `盈亏` 的数值和。
- 正数总盈亏为红色，负数总盈亏为绿色。

账户总览：

- `总盈亏` 等于全部持仓子项 `unrealizedPnL` 之和。
- 如果持仓盈亏全部不可用，则显示 Futu 原始 `summary.totalPnL` 或不可用。

回归：

- 当日盈亏仍使用账户字段。
- 子层盈亏颜色仍正确。
- 语言切换仍可用。
- 导航定位不受影响。

## Execution Order After Approval

1. 在 `PositionsPanel.tsx` 增加金额求和和格式化辅助函数。
2. 调整 `groupPositions()`，计算父组 `totalMarketValue` 与 `totalPnL`。
3. 更新父层 badge 文案，明确 `市值` 和 `总盈亏`。
4. 将父层 `总盈亏` 接入 `ProfitValue`。
5. 修改 `AccountSummaryPanel` 接收 `positions`，计算持仓合计总盈亏。
6. 修改 `Dashboard.tsx` 传入 `positions`。
7. 运行检查、测试、构建。
8. 浏览器验收父层总盈亏、账户总盈亏和语言切换。
