# 本地发布前测试

## 安全边界

- 测试数据库固定为本机 `financial_test`，脚本拒绝删除远程数据库。
- 默认不执行外部真实请求。
- 外部冒烟只读；检测到任一真实交易开关为 `true` 时立即退出。
- 不得将 `.env.local`、`.data/`、测试日志、Cookie 或券商凭据提交到 Git。

## 执行

```bash
export PATH=/Users/bytedance/.nvm/versions/node/v24.16.0/bin:$PATH
npx playwright install chromium
RUN_EXTERNAL_READONLY_SMOKE=1 npm run test:release:local
```

快速本地回归可省略真实外部冒烟：

```bash
npm run test:release:local
```

结果写入 `.data/test-results/`，覆盖率写入 `coverage/`，浏览器报告写入
`playwright-report/`。任一阶段失败即阻断发布。

## 分层命令

```bash
npm run check
npm run lint
npm run build
npm run test:unit
npm run test:integration:db
npm run test:integration:http
RUN_EXTERNAL_READONLY_SMOKE=1 npm run test:smoke:external
npm run test:e2e
```

## 发布前人工检查

- 所有阶段通过且无跳过的发布必测项。
- 多用户模块行覆盖率至少 85%，分支覆盖率至少 80%。
- owner/member 双浏览器会话、Futu 二次解锁和 Longbridge 租户数据完全隔离。
- 日志、响应、任务载荷和报告中无 App Secret、Access Token、Cookie 或完整账户号。
- 券商替身没有将写请求转发到真实环境，真实账户没有新增订单或撤单。
- 审阅 Git diff 后再提交或部署。
