# 项目理解：多平台 LLM 量化交易工作台

> 基于 `.trae/documents/` 全部历史文档与代码结构梳理，2026-08-31。

## 一、产品定位

机构级个人量化交易工作站（Web 应用，本地/裸机部署），以「研究 + LLM 自主交易」双轮驱动：一端生成可复核的全球市值 Top30 美股 CSP（现金担保 Put）研究报告；一端让大模型在严格硬风控与人工确认下，驱动多市场模拟盘与实盘交易。面向专业投资者，核心诉求是数据可复核、决策可审计、下单可拦截。

## 二、技术架构

- 前端：React 18 + Vite + TypeScript + Tailwind + Zustand（5173），高密度深色金融终端风格，全中文本地化。
- 后端：Express + TS ESM（3001，`/api/health`），按平台分目录隔离：`api/live`（Futu 美港股实盘）、`api/longbridge`、`api/ashare`、`api/simulation`、`api/services`（报告）。
- 行情接入：Node Provider + Python Bridge（futu-api SDK）连接本地 Futu OpenD（`127.0.0.1:11111`，需手动登录）；Longbridge 走官方 SDK + 本地 CLI。实时数据采用「后台订阅回调写缓存（realtimeStore）、LLM 并发评估读缓存」模式，CLI 仅作冷启动补拉与降级兜底。
- 持久化：`.data/` 下按平台/场景完全隔离的 SQLite（模拟、实盘、A 股、Top30 报告各一库）。
- LLM：Ark/DeepSeek 兼容接口；Prompt 以 `trade_strategy/` 下 YAML 版本化配置，宏观新闻快照作为只增不减的风险上下文注入。
- 部署：Linux 裸机 PM2 + Nginx，日志强制轮转（曾因日志超 5GB 被系统终止）。

## 三、核心功能

1. **一级平台入口**：`/` 平台选择页 → Futu（`/futu`）、Longbridge（`/longbridge`）、A 股（`/a-share`）三个独立工作台，数据、配置、风控互不污染。
2. **Top30 CSP 报告**：锁定美股市值 Top30 universe，采集行情/技术指标/期权链/新闻，原始数据表先于分析呈现；缺失字段一律 `unavailable` 绝不伪造，输出中英双语 Markdown 与数据质量面板，历史报告持久化可回溯。
3. **模拟盘**：LLM 自主决策（已删除本地 Dual Thrust 策略）——启动时先问模型所需数据窗口，再逐票轮询产出 BUY/SELL_TO_CLOSE/HOLD，通过硬风控后自动提交 Futu SIMULATE。
4. **实盘三链路**（Futu 美港股、Longbridge、Futu A 股）：半自动队列——LLM 信号 → 后端硬风控 → 候选池（candidate_pool）→ 组合裁决 Prompt → 待确认队列 → 用户弹窗二次确认 → 才调用 REAL 下单；`LIVE_TRADING_ENABLED` 双门禁，订单最终状态始终以券商查询为准，signalId 全链路可追踪。
5. **平台规则差异**：A 股禁卖空、T+1、100 股整手、连续竞价、独立时段 Gate；美股跳过隔夜/夜盘 LLM 请求，卖空需高风险确认。

## 四、设计原则与演进

核心原则：fail-closed 数据完整性、平台隔离、人工确认不可绕过、研究结果永不自动触发交易。后续方向是借鉴 TradingAgents 的多角色辩论裁决、决策收益反思、checkpoint 恢复与模型目录分层，但不迁移其框架——实盘链路保持 Node/TS 轻量、低延迟、强门禁结构，多 Agent 能力仅落在候选池组合裁决与盘后复盘层。
