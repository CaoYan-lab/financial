# Debug Session: opend-refresh-disabled
- **Status**: [CLOSED]
- **Issue**: 长富 macOS 客户端在 Futu OpenD 已启动并监听 127.0.0.1:11111 时仍显示 SDK 未配置，账户数据不刷新且刷新按钮禁用。
- **Closed At**: 2026-09-17

## Reproduction Steps
1. 启动本机 Futu OpenD 并完成登录。
2. 启动长富客户端并登录。
3. 进入 Futu 今日总览。
4. 观察 OpenD 状态、账户数据和刷新按钮。

## Hypotheses & Verification
| ID | Hypothesis | Likelihood | Effort | Evidence |
|----|------------|------------|--------|----------|
| H1 | Futu C++ SDK 编译标志未启用，桥固定返回 SDK 不可用 | High | Low | Confirmed：日志 L2 `sdkAvailable=false` |
| H2 | OpenD 端口已监听但 SDK 握手失败 | Medium | Medium | Rejected：官方 FTAPI 10.10.7008 arm64 探针回调 `错误码=0，说明=Succeed!` |
| H3 | 刷新按钮由非 connected 状态直接禁用 | High | Low | Confirmed：SDK 不可用使状态停在 `.sdkUnavailable`，UI 对非 `.connected` 禁用 |
| H4 | 主应用未通过 BrokerHost 获取数据 | High | Medium | Confirmed：日志 L1 `clientType=FutuBrokerClient` |
| H5 | OpenD 登录、行情或交易权限未就绪 | Medium | Medium | Rejected：真实账户、持仓和市场状态均成功读取 |
| H6 | 一次性 BrokerHost 输出后在 SDK 析构阶段阻塞，客户端等待 EOF | High | Low | Confirmed：宿主已输出连接成功 JSON，但进程停在 `changfu_futu_destroy` |

## Log Evidence
调试期间加入的观测点：

- H1：`FutuBrokerClient.connect` 报告 SDK 可用性。
- H2：桥接连接完成后报告连接状态。
- H3：刷新处理器入口报告当前连接状态。
- H4：认证后启动券商服务时报告实际客户端类型。

Pre-fix 日志：

- L1：认证后直接启动 `FutuBrokerClient`，没有 BrokerHost IPC。
- L2：`sdkAvailable=false`，桥在握手前返回。
- L3：官方 FTAPI arm64 只读握手探针连接 `127.0.0.1:11111` 成功，回调 `错误码=0，说明=Succeed!`。

## Verification Conclusion
根因由两部分组成：

1. 初始客户端未装载 Futu C++ SDK，也没有通过独立 BrokerHost 读取 OpenD。
2. 完成桥接后，一次性 BrokerHost 虽已写出 JSON，仍会在 Futu SDK 回调线程析构阶段阻塞，导致 App 等待 EOF、刷新状态无法结束。

修复：

- BrokerHost 使用官方 FTAPI 连接本机 `127.0.0.1:11111`，读取真实账户、持仓和市场状态。
- App 仅在登录成功后启动 BrokerHost，首次立即刷新，之后每 30 秒轮询；刷新按钮只在请求进行中禁用。
- BrokerHost 写完 IPC 结果后以成功状态结束一次性进程，避免供应商 SDK 析构阻塞。
- 所有 7777 调试 HTTP 埋点、环境文件和会话日志均已移除。

Post-fix 验证：

- 桌面单元与真实 OpenD 冒烟：40 项全部通过。
- Swift LLVM 行覆盖率：领域层 100%，`BackendClient` 91.22%，`FutuBrokerClient` 98.97%。
- 真实 OpenD 握手、账户快照、持仓列表和市场状态读取通过，BrokerHost 正常退出。
- App 包含 BrokerHost 及所需动态库，本地签名校验通过。
