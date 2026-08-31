# 可点击列表气泡凸起 Hover 效果计划

## Summary

为模拟盘页面中“可点击的列表行”设计更明显的鼠标悬停反馈：从当前很浅的 `hover:bg-cyan-50/70` 改为“气泡凸起”效果，让用户明确知道该行可点击。

本次只规划视觉交互调整：

- 只作用于已经具备 `onRowClick` 的可点击表格行。
- 不新增任何入口。
- 不改变历史模拟订单、Futu 订单状态、详情页、数据查询或路由逻辑。
- 历史策略信号列表仍不可点击，因此不加该 hover 效果。

已按 `figma` skill 做技能检查。当前用户未提供 Figma URL / node id，无法执行 Figma MCP 的 `get_design_context` 和 `get_screenshot` 流程；本计划基于用户截图与现有代码实现，若后续提供具体 Figma 节点，则再按 skill 要求补充 MCP 设计上下文。

## Current State Analysis

### 当前代码位置

文件：`src/pages/SimulationTradingView.tsx`

当前 `TablePanel` 支持行点击：

```tsx
onRowClick?: (rowIndex: number) => void
```

当前可点击行样式在 `TablePanel` 内：

```tsx
className={onRowClick ? 'cursor-pointer hover:bg-cyan-50/70' : undefined}
```

当前可点击入口只有两处：

- “Futu 订单状态”表，传入 `onRowClick={openFutuOrderDetail}`
- “历史模拟订单（大模型决策）”表，传入 `onRowClick={openHistoryOrderDetail}`

“历史策略信号”表未传 `onRowClick`，不可点击。

### 当前问题

从截图看，当前 hover 只是整行浅青色背景变化：

- 颜色变化太浅，金融表格中不够明显。
- 没有层级变化，用户难以感知“这是一条可进入详情的记录”。
- 在高密度表格中，浅色背景与表格底色接近，视觉反馈不友好。

### 技术约束

- 当前表格使用原生 `<table> / <tr> / <td>`。
- 直接对 `<tr>` 做 `box-shadow`、`border-radius` 在不同浏览器和 table layout 下表现不稳定。
- 更稳妥的做法是：
  - 在 `<tr>` 上使用 `group`、`transition`、`hover:-translate-y-*`
  - 在每个 `<td>` 上使用 `group-hover:bg-*`、`group-hover:shadow-*`
  - 首尾 `<td>` 添加圆角，形成整行气泡卡片感
  - 用 `relative z-*` 避免 hover 行被相邻行压住

## Proposed Changes

### 1. 提升 TablePanel 可点击行的 hover 层级

文件：`src/pages/SimulationTradingView.tsx`

修改 `TablePanel` 中可点击 `<tr>` 的 class：

从：

```tsx
className={onRowClick ? 'cursor-pointer hover:bg-cyan-50/70' : undefined}
```

改为按可点击状态动态应用：

```tsx
className={
  onRowClick
    ? 'group relative z-0 cursor-pointer transition-transform duration-200 ease-out hover:z-10 hover:-translate-y-1 focus-visible:z-10 focus-visible:-translate-y-1 focus-visible:outline-none'
    : undefined
}
```

说明：

- `group`：让子 `td` 统一响应 hover/focus。
- `relative z-0 hover:z-10`：hover 行浮到上层，避免阴影被相邻行遮住。
- `hover:-translate-y-1`：产生轻微上浮。
- `transition-transform duration-200 ease-out`：保证动效干净，不拖沓。
- `focus-visible`：键盘访问时也有同等视觉反馈。

### 2. 在可点击行的 td 上做“气泡卡片”视觉

文件：`src/pages/SimulationTradingView.tsx`

当前单元格：

```tsx
<td key={`${title}-${rowIndex}-${index}`} className="max-w-[360px] px-3 py-3 align-top text-slate-700">{cell}</td>
```

改为根据 `onRowClick` 和单元格位置追加 class：

```tsx
const clickableCellClass = onRowClick
  ? [
      'transition-all duration-200 ease-out',
      'group-hover:bg-white group-hover:text-slate-950',
      'group-hover:shadow-[0_14px_34px_rgba(15,23,42,0.14)]',
      'group-hover:ring-1 group-hover:ring-cyan-200/80',
      'group-focus-visible:bg-white group-focus-visible:text-slate-950',
      'group-focus-visible:shadow-[0_14px_34px_rgba(15,23,42,0.14)]',
      'group-focus-visible:ring-1 group-focus-visible:ring-cyan-300',
      index === 0 ? 'group-hover:rounded-l-2xl group-focus-visible:rounded-l-2xl' : '',
      index === row.length - 1 ? 'group-hover:rounded-r-2xl group-focus-visible:rounded-r-2xl' : '',
    ].join(' ')
  : ''
```

然后合并到 `<td>`：

```tsx
className={`max-w-[360px] px-3 py-3 align-top text-slate-700 ${clickableCellClass}`}
```

视觉结果：

- Hover 行像一张轻微浮起的白色气泡卡片。
- 边缘有很淡的 cyan ring，用来保持和页面现有 cyan/violet 风格一致。
- 阴影明显但不厚重，适合金融高密度表格。
- 文字颜色变深，提高可读性和交互确认感。

### 3. 增加 active/pressed 反馈

文件：`src/pages/SimulationTradingView.tsx`

在可点击 `<tr>` class 中增加：

```tsx
active:translate-y-0 active:scale-[0.998]
```

效果：

- 鼠标按下时轻微回落，形成“可按压”的确认反馈。
- 不改变点击行为。

### 4. 保持非点击表格不变

文件：`src/pages/SimulationTradingView.tsx`

不传 `onRowClick` 的表格保持当前普通行样式：

- 历史策略信号：不加气泡 hover
- 历史跳过原因与错误日志：不加气泡 hover

这样符合用户要求“入口就来自于可点击，不要在其他地方乱加入口”的既有约束。

### 5. 可选的小提示设计，不新增入口

不在页面上新增按钮、图标或独立入口。

只通过 hover/focus 让当前可点击行具备明确反馈。

不增加 tooltip，因为用户要求的是“气泡凸起效果”，不是解释型提示；tooltip 还可能遮挡表格内容。

## Assumptions & Decisions

- “可点击的列表”指当前代码中传入 `onRowClick` 的表格：Futu 订单状态、历史模拟订单（大模型决策）。
- 不给历史策略信号列表加点击或 hover 气泡效果。
- 不新增 tooltip、详情按钮、图标入口或其他导航入口。
- 使用 Tailwind 原子类完成，不引入 CSS 文件、不改 Tailwind 配置、不新增依赖。
- 选择“白色浮层 + cyan 细 ring + 中等阴影 + 轻微上浮”的方案，而不是继续加深背景色。原因是截图中浅色背景反馈不足，气泡凸起更符合用户要求。
- 动效保持轻量：`duration-200`、`-translate-y-1`，避免表格滚动和高密度数据阅读时产生强烈晃动。
- 若用户后续提供 Figma 节点链接，再按 `figma` skill 要求执行 `get_design_context` 和 `get_screenshot`，对齐精确设计稿。

## Verification Steps

1. 类型检查：

```bash
PATH="$PWD/.tools/node/bin:$PATH" node_modules/.bin/tsc --noEmit
```

2. 相关单测：

```bash
PATH="$PWD/.tools/node/bin:$PATH" node_modules/.bin/vitest run tests/simulationPersistence.test.ts tests/simulationStore.test.ts tests/llmRuntimeConfig.test.ts tests/llmAutonomousTrading.test.ts
```

3. UI 手工验证：

- 打开 `/simulation`
- 鼠标移入“Futu 订单状态”任意行
  - 行应有明显白色浮层、阴影、圆角、轻微上浮
  - 点击仍进入 Futu 订单详情
- 鼠标移入“历史模拟订单（大模型决策）”任意行
  - 行应有同样气泡凸起效果
  - 点击仍进入历史模拟订单详情
- 鼠标移入“历史策略信号”行
  - 不应出现气泡凸起效果
  - 不应可点击
- 键盘 Tab 聚焦可点击行
  - 应有类似 hover 的可见反馈
  - Enter / Space 仍触发进入详情

4. 视觉验收标准：

- Hover 反馈必须明显强于当前浅色背景变化。
- 不遮挡表格文字。
- 不改变表格列宽、分页、刷新按钮和已有详情入口。
- 不在其他位置新增入口。
