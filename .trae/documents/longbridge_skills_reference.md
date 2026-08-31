# Longbridge Skills 参考摘要

来源：
- `https://www.skills.sh/longbridge/skills`
- `https://open.longbridge.com/skill/install.md`

本地安装结果：
- 已通过 `npx skills add longbridge/skills --yes --global` 安装。
- 安装器识别到 `13` 个 Longbridge skills，并 symlink 到 Trae CN。
- 本机 CLI 已安装到项目本地路径：`.tools/longbridge/longbridge`
- CLI 版本：`longbridge 0.23.3`

## 已装载 Skills

- `longbridge`
  - Longbridge Developers Platform 核心入口。
  - 覆盖行情、新闻、公告、基本面、组合账户和订单能力。
- `longbridge-market-data`
  - 实时报价、K 线、盘口、逐笔、分时、资金流、市场温度等行情能力。
- `longbridge-technical`
  - K 线形态、RSI、MACD、EMA、布林带、一目均衡表、缠论、海龟信号等技术分析框架。
- `longbridge-quant`
  - 配对交易、协整、多因子、IC/IR、波动率、季节性、机器学习、执行模型和对冲框架。
- `longbridge-portfolio`
  - 账户资产、持仓、盈亏、现金流水、保证金、最大可买卖数量、订单管理、组合诊断和再平衡。
- `longbridge-research`
  - 机构评级、目标价、一致预期、财报日历、股东数据、行业排名、同业对比和投资提案。
- `longbridge-earnings`
  - 财报预告、财报复盘、业绩修正和财务事件跟踪。
- `longbridge-fundamentals`
  - 公司基本面、财务报表、估值、股息、行业估值和财务分析。
- `longbridge-content`
  - 新闻、公告、SEC filings、公司事件和内容检索。
- `longbridge-derivatives`
  - 期权、波动率、期权策略、期权 P&L 和衍生品分析。
- `longbridge-watchlist`
  - 自选股、分组、价格提醒和社区股票清单。
- `longbridge-intel`
  - 情报、主题、产业链、催化剂和异常事件分析。
- `longbridge-value-investing`
  - Graham / Buffett 价值投资、NCAV、护城河、安全边际和批量筛选框架。

## 平台能力映射

- 行情层：`longbridge-market-data`
- 技术分析层：`longbridge-technical`
- 量化策略层：`longbridge-quant`
- 账户与订单层：`longbridge-portfolio`
- 研究与内容层：`longbridge-research`、`longbridge-earnings`、`longbridge-fundamentals`、`longbridge-content`
- 衍生品层：`longbridge-derivatives`
- 自选与提醒层：`longbridge-watchlist`
- 情报与主题层：`longbridge-intel`
- 价值投资层：`longbridge-value-investing`

## 授权状态

当前已完成 CLI 和 Skill 文件安装，但真实数据查询仍需要执行 Longbridge OAuth 登录：

```bash
.tools/longbridge/longbridge auth login
.tools/longbridge/longbridge auth status
```

登录后可用行情查询验证，例如：

```bash
.tools/longbridge/longbridge quote AAPL.US
```

## 安全约束

- 未完成授权前，页面只展示能力矩阵，不应假装已接入真实账户。
- 账户、持仓、订单、自选、提醒等涉及账户或变更的能力必须在后续产品实现中显式区分“只读”和“会变更账户状态”。
- 交易/下单/撤单类操作需要单独人工确认和风控门禁，不能因为 Skill 已安装就自动开放。
