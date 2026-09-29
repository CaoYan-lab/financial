# 长富协议

本目录是长富桌面客户端、Gateway 和 Decision Worker 的唯一跨端协议源，与现有 Web、Worker 工程完全隔离。

## 内容

- `openapi/changfu-v1.yaml`：桌面端 HTTP API 契约。
- `openapi/changfu-admin-v1.yaml`：独立管理 Web 的会话、用户、套餐和模型配置 API 契约。
- `schemas/`：JSON Schema 2020-12 数据契约。
- `fixtures/`：跨语言黄金样例，不含真实账户或行情数据。
- `scripts/check-contracts.mjs`：零依赖契约和隐私边界检查。

## 约束

1. `ContextEnvelope` 原文只能在一次模型请求的内存链路中存在。
2. PostgreSQL、队列、日志、APM 和崩溃转储均不得保存原始上下文。
3. 真实交易只能由持有有效租约的桌面客户端执行。
4. 所有交易写接口必须携带 `Idempotency-Key`。
5. 协议字段只允许向后兼容地新增；破坏性变更必须提升主版本。
6. 管理端写接口必须同时携带同源 CSRF Token 和 `Idempotency-Key`，且不得暴露密码哈希、Session Token 或模型密钥密文。

## 检查

```bash
node scripts/check-contracts.mjs
```
