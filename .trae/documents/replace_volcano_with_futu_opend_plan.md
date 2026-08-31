# 用 Futu OpenD 替换火山融合信息搜索的实现规划

## 1. Summary

本次目标是把当前 Top 30 Mega-Cap CSP 分析 Web 应用中的“火山融合信息搜索”占位数据源替换为 Futu OpenD / Futu API 数据源，并按官方文档安装或引用 Futu OpenD Skills。

已阅读官方文档：
- AI 与 OpenClaw 接入文档：`https://openapi.futunn.com/futu-api-doc/intro/ai.html`
- OpenD 可视化运行文档：`https://openapi.futunn.com/futu-api-doc/quick/opend-base.html`
- 市场快照接口：`https://openapi.futunn.com/futu-api-doc/quote/get-market-snapshot.html`
- 实时 K 线接口：`https://openapi.futunn.com/futu-api-doc/quote/get-kl.html`
- 期权链接口：`https://openapi.futunn.com/futu-api-doc/quote/get-option-chain.html`

核心决策：
- Universe 仍按现有规则使用 StockAnalysis / CompaniesMarketCap，不改为 Futu 条件选股，避免偏离用户原始 Prompt 中的 Top 30 市值排名要求。
- Futu OpenD 替换当前 `VolcanoFusionProvider`，成为市场快照、K 线、期权链和期权快照的主要数据源。
- 因当前项目是 Node/Express 后端，而 Futu 文档和 Skills 主要围绕 Python SDK，计划采用“Node Provider + Python Bridge”的方式接入 OpenD。
- 交易能力不接入、不暴露、不调用；本项目只使用行情和分析数据，避免误触实盘交易风险。

## 2. Current State Analysis

### 2.1 当前代码中的火山占位点

已确认需要替换的文件：

- `api/providers/volcanoFusionProvider.ts`
  - 当前类名为 `VolcanoFusionProvider`。
  - `getStatus()` 返回 `volcanoFusionAvailable: false`。
  - `fetchMarketSnapshot()` 把价格、P/E、RSI、MA、IV、财报等字段全部标记为 `unavailable`。
- `api/routes/reportRoutes.ts`
  - 直接 `import { VolcanoFusionProvider }`。
  - `POST /api/report/generate` 直接实例化 `new VolcanoFusionProvider()`。
- `api/routes/sourceRoutes.ts`
  - 直接实例化 `VolcanoFusionProvider`。
  - `/api/source/test` 返回 `ok: status.volcanoFusionAvailable`。
- `shared/constants.ts`
  - `DATA_SOURCES.volcanoFusion` 当前为 `Volcano Fusion Information Search`。
- `shared/types.ts`
  - `SourceStatusResponse` 当前字段为 `volcanoFusionAvailable`。
- `api/services/analysisService.ts`
  - 缺失数据 rationale 中写死 `until Volcano Fusion data is connected`。
- `src/components/DataSourcePanel.tsx`
  - UI 文案展示“火山融合信息搜索”。
  - 使用 `status?.volcanoFusionAvailable`。
- `src/pages/Dashboard.tsx`
  - 空状态文案写“接入火山融合信息搜索技能 zip 包前”。
- `.trae/documents/top30_csp_prd.md`
- `.trae/documents/top30_csp_technical_architecture.md`
- `.trae/documents/top30_mega_cap_csp_analysis_plan.md`
  - 均包含火山融合信息搜索相关说明，需要同步改为 Futu OpenD。

### 2.2 当前架构中可复用部分

- `api/providers/DataProvider.ts` 已经抽象出 `DataProvider` 接口，可继续复用。
- `api/services/marketDataService.ts` 已经通过 provider 采集数据并锁定 Top 30。
- `api/services/universeService.ts` 的 Top 30 合并股权类别逻辑可保留。
- `api/services/analysisService.ts`、`optionStrategyService.ts`、`reportRenderer.ts` 可保留，只需接收更完整的 Futu 行情数据。
- 前端状态面板和报告页可保留，只需改文案和状态字段。

### 2.3 Futu 官方文档要点

来自 `intro/ai.html`：

- 官方提供 `opend-skills.zip`，下载地址：`https://openapi.futunn.com/skills/opend-skills.zip`。
- Skills 包含：
  - `install-futu-opend`：OpenD 安装助手。
  - `futuapi`：行情交易助手。
- `futuapi` 覆盖市场快照、K 线、买卖盘、逐笔成交、分时、市场状态、资金流、条件选股、下单、持仓、实时订阅等脚本。
- 使用 Skills 前需要先手动登录 OpenD。
- 交易默认模拟环境，实盘需明确说“正式/实盘/真实”并二次确认；本项目不使用交易能力。

来自 `quick/opend-base.html`：

- OpenD 需要本地运行并登录。
- API 监听地址通常为 `127.0.0.1`。
- 监听端口由 OpenD 配置，Python 示例常用 `11111`。
- 行情接口在本地监听下不需要交易私钥；如果监听地址不是本地，交易接口需私钥。本项目只接行情。

来自行情接口文档：

- `get_market_snapshot(code_list)` 可一次请求最多 400 个标的，返回 `last_price`、`total_market_val`、`pe_ratio`、`pe_ttm_ratio`、`bid_price`、`ask_price` 等字段。
- `get_cur_kline(code, num, ktype=KLType.K_DAY, autype=AuType.QFQ)` 可获取实时 K 线，但需要先订阅 K_DAY。
- `get_option_chain(code, start, end, option_type, ...)` 返回期权链静态信息；动态报价和希腊值需要对期权代码订阅/获取快照。
- `get_market_snapshot()` 对期权代码可返回 `option_implied_volatility`、`option_delta`、`option_strike_price`、`option_contract_size` 等字段。

### 2.4 Futu 能力与原 Prompt 字段映射

| 原字段 | Futu 计划来源 | 处理规则 |
|---|---|---|
| Current Price | `get_market_snapshot().last_price` | 可获取则写价格和时间戳 |
| Market Cap | `get_market_snapshot().total_market_val` | 可获取则写市值；Universe 排名仍以 StockAnalysis 为准 |
| P/E Ratio | `pe_ttm_ratio` 优先，回退 `pe_ratio` | 标注 TTM 或回退来源 |
| 14-Day RSI | `get_cur_kline(... K_DAY)` 后本地计算 | 需要订阅 K_DAY；失败则 `unavailable` |
| 50-Day MA | K_DAY close 本地计算 | 需要至少 50 根日 K |
| 200-Day MA | K_DAY close 本地计算 | 需要至少 200 根日 K |
| IV (30-Day) | 30-45 DTE 附近期权快照 `option_implied_volatility` | 用接近 30D、接近 0.30 delta 或 ATM 的 put |
| IV Rank | 项目本地 52 周 IV 缓存计算 | 初次接入无历史时必须 `unavailable`，不得伪造 |
| Next Earnings Date | Futu 已读文档未确认覆盖 | 默认 `unavailable`，除非 futuapi skill 或后续文档确认有接口 |
| Capital per Contract | 选定 strike × 100 | 有 strike 后计算 |
| 7-Day News | Futu 已读文档未确认覆盖新闻 | 默认 `unavailable`，除非 futuapi skill 或后续文档确认有接口 |

## 3. Proposed Changes

### 3.1 安装并记录 Futu OpenD Skills

执行阶段计划：

1. 下载官方 Skills 包：
   - `https://openapi.futunn.com/skills/opend-skills.zip`
2. 解压并检查目录结构：
   - 预期包含 `skills/futuapi/SKILL.md`
   - 预期包含 `skills/install-futu-opend/SKILL.md`
3. 安装或引用位置：
   - 优先按当前工具环境可识别的方式安装。
   - 若当前 TRAE 会话无法动态加载新 Skill，则把解压后的 `SKILL.md` 作为项目参考文档放入 `.trae/documents/futu_opend_skills_reference/`，并在代码实现中直接使用 Futu Python SDK。
4. 调用或参考 `install-futu-opend` 安装 OpenD 与 Python SDK。
5. 明确运行前置：
   - OpenD 必须本地运行。
   - 用户必须在 OpenD 中手动登录。
   - 默认 host：`127.0.0.1`。
   - 默认 port：`11111`，支持通过环境变量覆盖。

注意：安装技能属于后续执行阶段的非只读动作，当前 Plan Mode 不执行。

### 3.2 新增 Futu OpenD Provider

新增 `api/providers/futuOpenDProvider.ts`

职责：
- 实现 `DataProvider`。
- 通过 Python Bridge 调用 Futu OpenD。
- `getStatus()` 检查：
  - OpenD host/port 是否可连。
  - Python SDK 是否可导入。
  - OpenD 是否登录并可执行行情快照请求。
  - 是否具备期权链和 K 线订阅能力。
- `fetchUniverse()` 继续委托 `fetchUniverseFromStockAnalysis()`。
- `fetchMarketSnapshot(universe)` 返回标准化 `RawCompanyData[]`。

替换或删除 `api/providers/volcanoFusionProvider.ts`
- 推荐删除旧文件，避免误用。
- 如保留，需要改名为 `futuOpenDProvider.ts` 并更新所有引用。

### 3.3 新增 Python Bridge

新增目录 `api/futu_bridge/`

新增 `api/futu_bridge/futu_snapshot.py`

输入：

```json
{
  "host": "127.0.0.1",
  "port": 11111,
  "tickers": ["NVDA", "MSFT"],
  "includeOptions": true,
  "includeTechnicals": true
}
```

输出：

```json
{
  "ok": true,
  "source": {
    "source": "Futu OpenD",
    "url": "https://openapi.futunn.com/futu-api-doc/",
    "accessedAt": "ISO timestamp",
    "timestamp": "market snapshot update_time or batch time"
  },
  "rows": [
    {
      "ticker": "NVDA",
      "currentPrice": "$...",
      "marketCap": "$...",
      "peRatio": "... TTM",
      "rsi14": "...",
      "ma50": "$...",
      "ma200": "$...",
      "ivRank": "unavailable",
      "iv30": "...%",
      "nextEarningsDate": "unavailable",
      "capitalPerContract": "$...",
      "sevenDayNews": "unavailable"
    }
  ],
  "warnings": []
}
```

实现细节：
- 将 ticker 映射为 Futu 美股代码格式：`US.NVDA`、`US.BRK.B` 等。
- 对 ADR 和海外公司仍按美股/ADR 代码请求，例如 `US.TSM`、`US.ASML`。
- `get_market_snapshot()` 一次最多支持 400 个标的，Top 30 可一次请求。
- 对每个股票订阅 `SubType.K_DAY`，然后用 `get_cur_kline(code, 220, KLType.K_DAY)` 获取足够计算 RSI/MA 的日 K。
- 计算：
  - 14-Day RSI：Wilder RSI 或标准 rolling gain/loss，统一在代码中实现。
  - 50-Day MA：最近 50 根日 K close 均值。
  - 200-Day MA：最近 200 根日 K close 均值。
- 对期权：
  - 调 `get_option_chain(code, start=today, end=today+45d, option_type=PUT)` 获取 30-45 DTE put。
  - 对候选期权代码调用 `get_market_snapshot()` 获取 `option_delta`、`option_implied_volatility`、bid/ask。
  - 优先选择 delta 绝对值接近 0.30 的 put。
  - 若 delta 缺失，选择 strike 接近当前价 90%-95% 的 put。
  - `iv30` 使用选定期权的 `option_implied_volatility`。
  - `capitalPerContract = strike × 100`。
- 不在 Python Bridge 中生成分析结论，Bridge 只输出事实数据和缺失字段。

新增 `api/futu_bridge/futu_status.py`

职责：
- 检查 `from futu import *` 是否成功。
- 检查 OpenD host/port 是否可连接。
- 发起最小快照请求，例如 `US.AAPL` 或 `US.SPY`。
- 输出结构化 status JSON。

### 3.4 Node 后端调用 Python Bridge

新增 `api/utils/runPythonBridge.ts`

职责：
- 使用 `child_process.spawn` 调用 Python。
- 从 stdin 传 JSON，stdout 读取 JSON。
- 捕获 stderr 并转成 `DataQualityIssue` 或 source status warning。
- 使用环境变量：
  - `FUTU_OPEND_HOST=127.0.0.1`
  - `FUTU_OPEND_PORT=11111`
  - `FUTU_PYTHON_BIN=python3`
  - `FUTU_ENABLE_OPTIONS=true`
  - `FUTU_ENABLE_TECHNICALS=true`

更新 `api/providers/futuOpenDProvider.ts`
- `getStatus()` 调 `futu_status.py`。
- `fetchMarketSnapshot()` 调 `futu_snapshot.py`。
- 将 Python 输出标准化为 `RawCompanyData`。
- 对 Python 失败或字段缺失统一填 `unavailable`。

### 3.5 更新共享类型和常量

更新 `shared/constants.ts`
- 删除或停止使用 `DATA_SOURCES.volcanoFusion`。
- 新增：
  - `DATA_SOURCES.futuOpenD = 'Futu OpenD'`
  - `DATA_SOURCES.futuDocs = 'https://openapi.futunn.com/futu-api-doc/'`

更新 `shared/types.ts`
- 将 `SourceStatusResponse.volcanoFusionAvailable` 改为：
  - `futuOpenDAvailable: boolean`
  - `futuPythonSdkAvailable: boolean`
  - `futuOpenDLoggedIn: boolean`
  - `optionsDataAvailable: boolean`
  - `technicalDataAvailable: boolean`
- 保留 `universePrimaryAvailable` 和 `universeFallbackAvailable`。
- 保留 `missingCapabilities`。

兼容性：
- 同步更新前端所有引用，避免 `volcanoFusionAvailable` 残留。

### 3.6 更新后端路由

更新 `api/routes/reportRoutes.ts`
- 将 `VolcanoFusionProvider` 改为 `FutuOpenDProvider`。
- `POST /api/report/generate` 保持 API 不变，避免前端改动过大。
- 如果 Futu OpenD 不可用：
  - 仍可返回 Top 30 universe + `unavailable` 字段。
  - `dataQuality.issues` 中加入 warning/blocking，说明 OpenD 未连接或未登录。

更新 `api/routes/sourceRoutes.ts`
- 将 `VolcanoFusionProvider` 改为 `FutuOpenDProvider`。
- `/api/source/status` 返回 Futu OpenD 连接、Python SDK、登录状态。
- `/api/source/test` 返回 `ok: status.futuOpenDAvailable && status.futuPythonSdkAvailable`。

### 3.7 更新分析和报告文案

更新 `api/services/analysisService.ts`
- 将 `until Volcano Fusion data is connected` 改为 `until Futu OpenD data is connected`。

更新 `api/services/reportRenderer.ts`
- 数据来源中显示 Futu OpenD、Futu API docs URL、OpenD snapshot timestamp。
- 若 IV Rank 缺失，明确写 `unavailable`，不使用当前 IV 估算 IV Rank。

### 3.8 更新前端 UI

更新 `src/components/DataSourcePanel.tsx`
- 文案从“火山融合信息搜索”改为“Futu OpenD”。
- 展示：
  - OpenD 连接状态。
  - Python SDK 状态。
  - 登录状态。
  - 期权数据状态。
  - K 线/技术指标状态。
- 提示用户：
  - 需要启动 OpenD。
  - 需要在 OpenD 中手动登录。
  - 本应用只读取行情，不执行交易。

更新 `src/pages/Dashboard.tsx`
- 空状态文案从火山融合替换为 Futu OpenD。
- 保留“不可用字段不会伪造”的说明。

### 3.9 更新项目文档

更新：
- `.trae/documents/top30_csp_prd.md`
- `.trae/documents/top30_csp_technical_architecture.md`
- `.trae/documents/top30_mega_cap_csp_analysis_plan.md`

变更：
- 火山融合信息搜索全部替换为 Futu OpenD。
- 架构图改为 React → Express → FutuOpenDProvider → Python Bridge → OpenD。
- 添加 Futu OpenD 前置条件：
  - OpenD 本地运行。
  - 用户手动登录。
  - Python SDK 安装。
  - 行情权限可能影响字段可用性。

## 4. Assumptions & Decisions

- 不改 Universe 来源：仍以 StockAnalysis 当日排名为准，备用 CompaniesMarketCap。
- 不接入交易：即使 Futu Skills 支持下单，本项目仅使用行情读取能力。
- 不伪造新闻和财报：已读 Futu 文档未确认 7 日新闻和下一财报日接口，因此默认 `unavailable`。
- 不伪造 IV Rank：Futu 可提供当前期权 IV，但 52 周 IV Rank 需要历史 IV 序列；初始版本用 `unavailable`，后续可通过本地每日缓存积累。
- Futu Skills 安装作为开发辅助，不作为 Web 应用运行时硬依赖；运行时依赖 Python SDK + 本地 OpenD。
- 若当前 TRAE 环境不能动态加载官方新技能，则仍按官方 zip 下载并保存为参考文档，代码直接走 Futu Python SDK。
- Futu OpenD host/port 均通过环境变量配置，默认 `127.0.0.1:11111`。

## 5. Verification Steps

### 5.1 技能和 OpenD 验证

- 下载并解压 `https://openapi.futunn.com/skills/opend-skills.zip`。
- 验证存在 `futuapi` 和 `install-futu-opend`。
- 安装或引用 Skills。
- 安装 OpenD 与 Python SDK。
- 启动 OpenD，并由用户手动登录。
- 运行 `futu_status.py`，确认：
  - Python SDK 可导入。
  - OpenD 可连接。
  - 快照接口可返回数据。

### 5.2 后端验证

- `GET /api/source/status`
  - OpenD 未启动时返回清晰错误和 missingCapabilities。
  - OpenD 已启动登录后返回可用状态。
- `POST /api/report/generate`
  - 返回 30 行 raw data。
  - 能填充 Futu 可得字段。
  - Futu 不覆盖字段保持 `unavailable`。
  - Markdown 数据来源显示 Futu OpenD。

### 5.3 前端验证

- 首页显示 Futu OpenD 状态，不再出现火山融合文案。
- 未连接 OpenD 时有明确引导。
- 连接 OpenD 后可以生成报告并进入报告页。
- 报告页原始数据表仍先于分析出现。

### 5.4 自动化验证

运行：

```bash
PATH=/Users/ShockCao/AICoding/Financial/.tools/node/bin:$PATH npm run check
PATH=/Users/ShockCao/AICoding/Financial/.tools/node/bin:$PATH npm test
PATH=/Users/ShockCao/AICoding/Financial/.tools/node/bin:$PATH npm run build
```

新增或更新测试：
- `tests/futuOpenDProvider.test.ts`
  - mock Python Bridge 输出，验证标准化字段。
  - mock OpenD 不可用，验证 `unavailable` 和 missingCapabilities。
- 更新现有 report/analysis 测试，确保无 Volcano/Fusion 文案残留。

## 6. Execution Order

1. 下载并检查 Futu OpenD Skills zip。
2. 安装或保存 Skills 参考文档。
3. 新增 Python Bridge 脚本和 Node bridge runner。
4. 新增 `FutuOpenDProvider`。
5. 替换 `reportRoutes`、`sourceRoutes` 中的 provider。
6. 更新 shared constants/types。
7. 更新分析、前端和文档文案。
8. 补充 provider 测试和文案残留测试。
9. 运行类型检查、测试和构建。
10. 如本机 OpenD 已启动并登录，执行真实连接 smoke test；否则验证 OpenD 不可用时的降级路径。

