# 长富独立后台

本工程承载长富桌面客户端的 Gateway、Decision Worker 与独立 Web 管理端。它拥有独立依赖、镜像、数据库迁移和发布流程，不导入现有 `api/`、`src/` 或 `shared/` 代码。

## 服务

- `apps/gateway`：认证边界、设备、租约、业务 API 和模型请求内存转发。
- `apps/decision-worker`：上下文时效与完整性校验、模型调用、输出校验和订单意图签名。
- `apps/admin`：管理员会话、用户、套餐、人工订阅和全局长富Pro配置 API。
- `admin-web`：由 Admin 服务同源托管的 React/Vite 内部管理界面。
- `packages/domain`：无基础设施依赖的状态机与协议类型。
- `packages/observability`：默认拒绝敏感字段的结构化日志。
- `packages/persistence`：数据库端口定义；实现不得接收 `ContextEnvelope`。
- `packages/model-provider`：旗舰版第三方模型配置、Endpoint 安全校验与凭据加解密。
- `packages/admin`：管理员密码和会话安全基础能力。

## 隐私边界

`ContextEnvelope` 不得进入 PostgreSQL、消息队列、日志、APM 请求体采集或崩溃转储。允许长期保存的内容仅为请求标识、哈希、条目计数、时间范围、模型结果和审计结论。

第三方模型 API Key 只以 AES-256-GCM 密文保存。Gateway 与 Decision Worker
必须共享 `CHANGFU_MODEL_CREDENTIAL_KEY`（32 字节随机值的 base64），不得将该值
写入仓库、普通环境文件或日志；生产环境应由密钥管理服务注入。

管理端使用独立 `CHANGFU_ADMIN_DATABASE_URL` 和 `changfu_admin_runtime` 最小权限
账号。默认管理员 `admin` 仅在管理员表为空时通过
`CHANGFU_ADMIN_INITIAL_PASSWORD` Secret 播种，首次登录必须改密。浏览器只访问
同源 `/api/v1/admin/*`，不直接连接 PostgreSQL。

## 本地检查

需要 Node.js 22：

```bash
npm install
npm run check
```

分别启动：

```bash
npm run dev:worker
npm run dev:gateway
npm run dev:admin
npm run dev:admin-web
```
