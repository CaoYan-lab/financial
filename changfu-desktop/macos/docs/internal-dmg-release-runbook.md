# 长富 macOS 内部 DMG 发布手册

## 发布边界

- 仅支持 Apple Silicon（arm64）与 macOS 14 及以上。
- 使用 ad-hoc 临时签名，不做 Apple 公证，仅限内部灰度。
- 首次启动通常需要 Finder 右键“打开”或在“隐私与安全性”中放行。
- Futu OpenD 由用户独立安装、登录和启动，不包含在 DMG 中。
- 升级方式为退出 App 后拖入 `/Applications` 覆盖旧版本。

## 发布输入

准备透明背景的 1024×1024 PNG，不得使用截图或放大低分辨率图片。每次发布使用新的
语义版本和单调递增构建号。

```bash
cd changfu-desktop/macos

export CHANGFU_RELEASE_VERSION=0.1.0
export CHANGFU_RELEASE_BUILD=2026092901
export CHANGFU_RELEASE_CHANNEL=internal
export CHANGFU_PUBLIC_API_ORIGIN=https://s1t8is7jgm85sfs523g5l.apigateway-cn-beijing.volceapi.com
export CHANGFU_APP_ICON_SOURCE=/absolute/path/to/changfu-app-icon-1024.png

./scripts/build-internal-dmg.sh
```

脚本依次执行 UI 契约、生产配置校验、arm64 Release 构建、依赖闭包修正、逐组件
ad-hoc 签名、DMG 创建和挂载验收。输出目录：

```text
dist/<version>-<build>/
├── 长富.app
├── ChangFu-<version>-<build>-macOS-arm64-internal.dmg
├── ChangFu-<version>-<build>-macOS-arm64-internal.dmg.sha256
└── release-manifest.json
```

需要重新验证已有候选包时：

```bash
./scripts/verify-internal-dmg.sh \
  dist/0.1.0-2026092901/ChangFu-0.1.0-2026092901-macOS-arm64-internal.dmg
```

## 干净机器验收

候选版本必须在至少一台未安装开发工具、未检出本仓库的 Apple Silicon Mac 上完成：

1. 运行 `shasum -a 256 -c <dmg>.sha256`。
2. 挂载 DMG，将“长富.app”拖入“Applications”。
3. 在 Finder 中右键“长富”并选择“打开”；若仍被阻止，在“系统设置 → 隐私与安全性”
   选择“仍要打开”。
4. 检查应用图标、版本、云端登录、首次改密、退出与重启。
5. 验证 refresh token 和券商凭据只保存在 Keychain，登录状态符合产品设计。
6. 分别验证 OpenD 未安装、未启动、未登录和已登录四种状态。
7. OpenD 可用后验证账户、持仓、行情、只读订单和 SELL PUT 研究。
8. 验证 Longbridge 未授权提示、授权保存、重启恢复和快照加载。
9. 验证 Futu 与 Longbridge 的缓存、报告和状态完全隔离。
10. 验证断网、云端 401/503 和 OpenD 中断时 App 不崩溃且提示明确。
11. 退出 App，确认无 ChangFu Host 或 longbridge 子进程残留。

自动验证与上述人工矩阵均通过后，候选包才可标记为 `internal-approved`。

## 升级与回滚

- 不覆盖已发布 DMG；文件名必须包含版本和构建号。
- 先投放 1 台测试机，再扩大到 3 至 5 名内部用户。
- 分发 DMG、SHA-256、发布说明和已知问题。
- 保留至少一个上一版 `internal-approved` DMG。
- 回滚时退出 App，再用上一版 App 覆盖 `/Applications/长富.app`。
- Bundle ID 固定为 `com.changfu.desktop`，不得通过删除 Keychain 或本地数据完成升级。

## 公开发行门禁

面向普通用户公开分发前，必须切换为 Developer ID Application 签名、Hardened
Runtime、Apple notarization 与 stapling；此时 `spctl --assess` 必须通过，不得继续
依赖右键打开流程。
