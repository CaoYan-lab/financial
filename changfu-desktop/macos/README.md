# 长富 macOS

当前工程提供可独立编译的 SwiftUI 工作台、启动广告行为、后台客户端端口、BrokerHost 进程边界和 Objective-C++ Futu 适配层。

## 环境

- macOS 14+
- Xcode 16+
- Swift 6
- Futu OpenD 与官方 C++ SDK

未配置官方 SDK 时，客户端明确显示“Futu SDK 未配置”，不会返回模拟账户、行情或订单数据。

## 本地验证

```bash
swift test
swift run ChangFu
```

直接生成并打开本地 `.app`：

```bash
./scripts/run-local.sh
```

应用输出到 `build/长富.app`，采用本机临时签名，仅用于开发预览。

## 内部灰度 DMG

内部灰度包仅支持 Apple Silicon 与 macOS 14 及以上，采用 ad-hoc 临时签名且不做
Apple 公证。准备透明背景的 1024×1024 PNG 后执行：

```bash
export CHANGFU_RELEASE_VERSION=0.1.0
export CHANGFU_RELEASE_BUILD=2026092901
export CHANGFU_RELEASE_CHANNEL=internal
export CHANGFU_PUBLIC_API_ORIGIN=https://s1t8is7jgm85sfs523g5l.apigateway-cn-beijing.volceapi.com
export CHANGFU_APP_ICON_SOURCE=/absolute/path/to/changfu-app-icon-1024.png
./scripts/build-internal-dmg.sh
```

候选包、SHA-256 和发布清单输出到
`dist/<version>-<build>/`。完整发布、安装、干净机验收与回滚流程见
[`docs/internal-dmg-release-runbook.md`](docs/internal-dmg-release-runbook.md)。

该发行档位首次启动需要 Finder 右键“打开”或在“隐私与安全性”中人工放行。面向
普通用户公开分发前，必须迁移到 Developer ID 签名、Hardened Runtime 和 Apple
公证流程。

## 后台环境

App 默认通过
`https://s1t8is7jgm85sfs523g5l.apigateway-cn-beijing.volceapi.com`
连接云端。`CHANGFU_PUBLIC_API_ORIGIN` 仍可在构建或调试时覆盖 Info.plist 中的
`ChangFuPublicAPIOrigin`；正式打包时设置 `CHANGFU_RELEASE_BUILD=1`，构建脚本会
拒绝占位域名、HTTP 和本机地址。

登录后连续五次点击顶栏“只读设备”可进入 Debug 模式。Debug 固定连接
`http://127.0.0.1:4310`，进入前应先运行 `../../changfu-backend/scripts/run-local.sh`。
左上角关闭按钮会清理 Debug 会话并切回云端登录页；Debug 状态不会跨重启保存。

## Futu SDK 接入

1. 从 Futu 官方渠道获取与目标架构匹配的 C++ SDK。
2. 将 SDK 保存在仓库外的受控目录，不提交二进制和凭据。
3. 在正式 Xcode 工程中为 `FutuCppBridge` 配置头文件和动态库搜索路径。
4. 定义 `CHANGFU_FUTU_SDK_AVAILABLE`，在 `ChangFuFutuBridge.mm` 内完成官方上下文、回调和线程切换。
5. SDK 事件只发送给 BrokerHost；SwiftUI 进程不得直接持有 SDK 回调对象。

当前机器只有 Command Line Tools，可构建内部 ad-hoc DMG，但无法完成 Developer ID
签名、公证和正式 Xcode Archive。这些公开发行步骤需要安装完整 Xcode 后执行。
