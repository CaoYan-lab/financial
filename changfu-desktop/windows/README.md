# 长富 Windows

Windows 客户端是第二阶段工程，使用 WPF/.NET 8，并与 macOS 共享 `changfu-contracts` 协议语义。

当前已建立：

- WPF 三栏工作台外壳。
- 独立 `ChangFu.Domain`。
- 独立 BrokerHost 进程边界。
- Futu C# SDK 适配端口及 SDK 缺失时的 fail-closed 行为。

后续必须在 Windows 构建机安装 .NET 8 SDK 和官方 Futu C# SDK，再完成 Named Pipe、签名校验、KeyStore、安装包与 UI 自动化测试。本机未安装 `dotnet`，当前无法编译此解决方案。
