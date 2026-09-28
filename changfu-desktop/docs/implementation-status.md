# 长富实施状态

> 更新日期：2026-09-17

## 已完成

- 建立 `changfu-contracts`、`changfu-backend`、`changfu-desktop` 三个隔离工程。
- 建立 OpenAPI、4 个 JSON Schema、黄金样例和零依赖契约检查。
- 建立独立 Gateway 与 Decision Worker 常驻服务入口。
- 实现兼容现有账号的登录、设备公钥原子注册、15 分钟 access token、30 天 refresh token 轮换与注销。
- 实现广告查询、90 秒单活交易租约和待确认订单原子 claim API。
- 实现 2 MiB 上下文限制、时效检查、规范化哈希和敏感日志拒绝策略。
- 实现订单状态机、90 秒单活交易租约领域逻辑和 Ed25519 订单意图签名。
- 建立独立 `changfu` PostgreSQL schema；原始账户、持仓和行情上下文无持久化字段。
- 建立 macOS SwiftUI 工作台、平台导航、模型对话区、广告倒计时和状态恢复。
- 建立强制登录门禁、Keychain refresh token/设备密钥存储、启动会话校验、自动 refresh 和 401 强制退出。
- 建立 Objective-C++ Futu 适配边界和 BrokerHost 可执行目标。
- 建立 Windows WPF、Domain、BrokerHost 与 Futu C# 适配工程骨架。

## 已验证

- 协议 JSON 检查通过。
- 后台 TypeScript 类型检查与 14 项单元测试通过。
- 后台核心模块行覆盖率 93% 以上。
- macOS `ChangFuApp` 与 `BrokerHost` 目标通过 Swift 编译。
- 新工程未修改现有 `src/`、`api/`、`shared/`、根 `package.json` 和现有发布脚本。

## 环境阻碍

- 当前机器未安装完整 Xcode，SwiftPM 测试框架、XPC 工程生成、签名和公证不可用。
- 当前机器未安装 .NET SDK，Windows 工程无法编译。
- 仓库没有 Futu C++/C# SDK，真实 OpenD 查询和订单调用不能编译或联调。
- 尚未提供长富独立 PostgreSQL 连接、模型密钥和签名密钥，无法做集成测试。

## 下一步

1. 完成会话、设备管理、执行回执和订单事件 HTTP API。
2. 接入 PostgreSQL 集成测试和迁移回滚验证。
3. 在完整 Xcode 环境生成 XPC 工程并链接官方 Futu C++ SDK。
4. 完成 macOS 账户、持仓、行情和模型增量流式对话。
5. 进入模拟盘影子决策与人工确认状态机联调。
