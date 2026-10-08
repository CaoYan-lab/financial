# 长富 macOS 内部灰度 DMG 发布方案

## Summary

本方案用于把现有长富 macOS SwiftUI 客户端制作成可交付朋友、同事测试的
Apple Silicon 内部灰度 DMG。首发边界已经确定：

- 发行方式：DMG 手工分发，不上架 Mac App Store。
- CPU：仅支持 Apple Silicon（arm64）。
- 系统：macOS 14 及以上。
- 签名：无 Apple Developer 证书，采用逐组件 ad-hoc 临时签名。
- 公证：不做 Apple notarization。
- 升级：手工下载并替换 App，不集成 Sparkle。
- 图标：发布前由用户提供透明背景的 1024×1024 PNG 源图。
- OpenD：不打入安装包，由用户独立安装、登录和启动。

无 Developer ID 签名和 Apple 公证时，无法保证用户双击 App 就能通过
Gatekeeper。内部灰度的“可用”定义是：DMG 可校验、可挂载、可拖入
`/Applications`，用户按文档首次右键打开后，App 能启动并完成云端登录、Keychain、
Futu OpenD 和 Longbridge 核心流程。未来面向普通用户公开分发前，Developer ID
签名与公证仍是强制门禁。

## Current State Analysis

### 已有能力

- macOS 工程位于 `changfu-desktop/macos/`，使用 Swift Package Manager 和 Swift 6。
- App 由四个 arm64 可执行文件组成：
  - `ChangFu`
  - `ChangFuBrokerHost`
  - `ChangFuLongbridgeHost`
  - 内置 `longbridge` CLI
- App 已自包含 `libprotobuf.32.dylib`、`libssl.3.dylib`、`libcrypto.3.dylib`。
- Futu、OpenSSL、protobuf 和 Longbridge CLI 当前均只有 arm64 产物，因此首发限定
  Apple Silicon 是与现有依赖一致的最小风险选择。
- `BackendEnvironment.swift` 和 `validate-production-config.sh` 已支持正式包固定连接
  HTTPS 云端 API，并拒绝 localhost、HTTP 和占位域名。
- 当前本地 `.app` 可通过 `codesign --verify --deep --strict` 的包完整性检查。

### 当前不能直接发布的原因

- `scripts/run-local.sh` 使用 `debug` 编译，并在完成后直接启动 App，不是可复现的
  Release 打包入口。
- 当前 App 是 ad-hoc 签名，`spctl --assess` 明确拒绝；互联网下载后会触发
  Gatekeeper。
- 当前 App 是 thin arm64，不支持 Intel Mac。
- 当前 BrokerHost 仍带有仓库相对路径和 Command Line Tools 路径的开发期 RPath。
  即使已有 `@executable_path/../Frameworks`，正式包仍应清除所有构建机路径。
- 当前使用 `codesign --deep --sign -` 一次性签名。正式打包应按“动态库 → CLI/Host
  → 主程序 → App”顺序逐个签名，避免嵌套代码签名不可审计。
- `Info.plist` 的版本固定为 `0.1.0 / 1`，没有发布参数化机制。
- 仓库没有 `.icns` 或 AppIcon 源资源，Finder 和 Dock 会显示默认图标。
- 没有 DMG 生成、SHA-256、发布清单、挂载验收、干净机器冒烟和回滚脚本。
- 当前机器只安装 Command Line Tools，没有完整 Xcode，也没有有效签名身份。无证书
  内部包可以继续使用 Swift CLI 构建；正式签名公证前必须迁移到完整 Xcode 发布机。

## Proposed Changes

### 1. 建立独立的 Release App 构建入口

新增 `changfu-desktop/macos/scripts/build-release-app.sh`，与开发用
`scripts/run-local.sh` 分离，禁止启动后台或自动打开 App。

脚本输入：

- `CHANGFU_RELEASE_VERSION`：语义版本，例如 `0.1.0`。
- `CHANGFU_RELEASE_BUILD`：单调递增整数，例如 `2026092901`。
- `CHANGFU_PUBLIC_API_ORIGIN`：正式 HTTPS 根 Origin。
- `CHANGFU_APP_ICON_SOURCE`：用户提供的 1024×1024 PNG。
- 可选 `CHANGFU_RELEASE_CHANNEL=internal`，首发只允许 `internal`。

脚本行为：

1. 调用 `scripts/check-ui-contract.sh` 和 `scripts/validate-production-config.sh`。
2. 使用 `swift build --configuration release --arch arm64` 分别构建主程序和两个 Host。
3. 从固定、受控路径复制 Longbridge CLI 和 Futu 依赖；任何文件缺失立即失败。
4. 重新组装标准 App Bundle：
   `Contents/MacOS`、`Contents/Frameworks`、`Contents/Resources`。
5. 使用 `PlistBuddy` 写入版本、构建号、云端 Origin 和 `CFBundleIconFile`。
6. 禁止从 shell 环境、`.env` 或本机 Keychain 向 App Bundle 复制任何凭据。
7. 输出到独立、可清理的
   `changfu-desktop/macos/dist/<version>-<build>/长富.app`，不覆盖开发包。

### 2. 固化 Release RPath 与依赖闭包

调整 `changfu-desktop/macos/Package.swift`：

- Debug 构建可继续使用仓库内 SDK RPath。
- Release 的 `ChangFuBrokerHost` 只保留
  `@executable_path/../Frameworks`。
- 不把 `.data/`、Command Line Tools、用户 Home 或仓库绝对路径写入正式二进制。

Release 脚本继续使用 `install_name_tool` 固化：

- `libssl.3.dylib` ID 为 `@rpath/libssl.3.dylib`。
- `libcrypto.3.dylib` ID 为 `@rpath/libcrypto.3.dylib`。
- `libssl.3.dylib` 对 crypto 的依赖改为 `@rpath/libcrypto.3.dylib`。
- BrokerHost 对 protobuf、ssl、crypto 的依赖全部解析到 App 内部。

新增依赖审计：遍历主程序、Host、CLI 和 dylib 的 `otool -L/-l` 结果，发现
`/Users/`、仓库路径、`.data/`、`CommandLineTools` 或缺失的非系统依赖即失败。

### 3. 生成并校验正式 App 图标

新增 `changfu-desktop/macos/scripts/build-app-icon.sh`：

- 输入必须是 1024×1024 PNG。
- 使用 `sips` 生成 Apple 要求的 16、32、128、256、512 及 `@2x` iconset。
- 使用 `iconutil` 生成 `Packaging/AppIcon.icns`。
- 将图标复制到 `Contents/Resources/AppIcon.icns`。
- 校验 `Info.plist` 的 `CFBundleIconFile`、输出尺寸和文件存在性。

源 PNG 属于发布输入，不从截图或低分辨率资源放大。没有合格源图时，打包脚本直接
失败，避免发布默认图标包。

### 4. 使用可审计的 ad-hoc 签名顺序

新增 `changfu-desktop/macos/scripts/sign-internal-app.sh`，不再使用
`codesign --deep` 作为签名动作：

1. 分别签名三个内置 dylib。
2. 签名内置 Longbridge CLI。
3. 签名 `ChangFuBrokerHost` 和 `ChangFuLongbridgeHost`。
4. 签名主程序 `ChangFu`。
5. 最后签名 `.app` Bundle。
6. 使用 `codesign --verify --deep --strict --verbose=2` 做只读验证。

首发不启用 App Sandbox。当前 App 需要启动内置 Host/CLI、访问网络、连接本机
`127.0.0.1:11111` 并写入 Keychain，仓促开启 Sandbox 会改变运行边界。Hardened
Runtime、Developer ID 和 notarization 留到正式公开发行阶段统一启用和验收。

`spctl --assess` 在本发行档位下预期为 rejected；验证脚本必须明确输出
`INTERNAL_UNSIGNED_EXPECTED`，不能把它伪装成已通过 Gatekeeper。

### 5. 生成 DMG、校验和与发布清单

新增 `changfu-desktop/macos/scripts/build-internal-dmg.sh`：

1. 调用 Release App 构建和内部签名脚本。
2. 创建临时 DMG 根目录，包含：
   - `长富.app`
   - 指向 `/Applications` 的符号链接
   - `首次安装说明.txt`
3. 使用 `hdiutil create` 生成只读压缩 UDZO DMG。
4. 文件名固定为
   `ChangFu-<version>-<build>-macOS-arm64-internal.dmg`。
5. 生成同名 `.sha256`。
6. 生成 `release-manifest.json`，记录：
   - 版本、构建号、Git commit
   - 目标系统和架构
   - Bundle ID
   - API Origin
   - App 与 DMG SHA-256
   - 内置可执行文件和动态库清单
   - 签名档位 `ad-hoc-internal`
   - 是否公证 `false`
7. DMG 只包含运行时文件，不包含源码、`.env`、测试数据、日志、数据库或证书材料。

### 6. 增加发布前自动验证

新增 `changfu-desktop/macos/scripts/verify-internal-dmg.sh`，以 DMG 为唯一输入：

- 使用 `hdiutil verify` 校验镜像结构。
- 校验外部 `.sha256` 与实际 DMG 一致。
- 只读挂载 DMG，验证 App Bundle 路径、Applications 链接和安装说明。
- 校验 Bundle ID、版本号、构建号、最低系统版本、图标和云端 Origin。
- 遍历所有 Mach-O，要求架构严格为 arm64。
- 对所有嵌套代码和 App 执行 `codesign --verify --strict`。
- 用 `otool` 验证依赖闭包和 RPath，不允许构建机路径。
- 扫描包内文件名和 plist，禁止 `.env`、password、secret、token、私钥等发布禁项。
- 从挂载镜像复制 App 到临时目录启动，确认主程序、BrokerHost 和 LongbridgeHost
  都能从 App 内部定位，不依赖仓库当前目录。
- 验证正式包默认连接云端，且不会因为 Debug 编译条件默认进入本地模式。

验证脚本只负责机器可判定项。Gatekeeper 首次放行、Keychain 授权、OpenD 和券商
授权必须进入干净机器人工验收。

### 7. 建立干净 Apple Silicon Mac 验收矩阵

新增 `changfu-desktop/macos/docs/internal-dmg-release-runbook.md`，规定每个候选版本
必须在至少一台未安装开发工具、未检出仓库的 Apple Silicon Mac 上验收：

1. 校验 DMG SHA-256。
2. 挂载 DMG，并把 `长富.app` 拖入 `/Applications`。
3. 首次启动使用 Finder 右键“打开”；若系统仍阻止，文档提供
   “系统设置 → 隐私与安全性 → 仍要打开”路径。
4. 不把 `xattr -dr` 作为普通用户默认步骤；仅作为内部诊断兜底并说明风险。
5. 验证应用启动、图标、版本信息、云端登录和首次改密。
6. 验证 refresh token 与券商凭据只进入 Keychain，退出和重启后状态符合设计。
7. 在未安装、未启动、未登录和已登录 OpenD 四种状态下检查明确提示。
8. 安装并启动受支持版本 OpenD 后，验证 `127.0.0.1:11111`、账户、持仓、行情、
   订单只读和 SELL PUT 研究。
9. 验证 Longbridge 未授权提示、授权保存、重启恢复和快照加载。
10. 验证 Futu/Longbridge 切换隔离、报告生成、策略中心报告查看。
11. 断网、云端 401/503、OpenD 中断后应显示可理解状态，App 不崩溃。
12. 关闭 App 后确认没有遗留 Host/CLI 子进程。

候选包只有在自动验证和干净机器矩阵全部通过后才能标记为 `internal-approved`。

### 8. 手工升级、灰度与回滚

内部灰度采用不可变版本文件：

- 每次发布使用新的版本/构建号和 DMG 文件名，不覆盖旧文件。
- 先给 1 台测试机，再扩到 3–5 名内部用户。
- 每个包同时分发 DMG、SHA-256、发布说明和已知问题。
- 升级时退出 App，将新 App 拖入 `/Applications` 覆盖旧版本。
- Bundle ID 保持 `com.changfu.desktop`，确保 Keychain 与 Application Support
  数据连续；验证脚本禁止无意修改 Bundle ID。
- 至少保留上一个 `internal-approved` DMG。回滚时退出 App 后覆盖安装旧 App。
- 若新版本引入不可逆本地数据格式，必须先实现向前/向后兼容或备份恢复；当前阶段
  不允许靠删除用户 Keychain 或本地缓存完成升级。

### 9. 第三方组件和公开发行边界

在扩大到朋友同事以外前，确认 Futu SDK 与内置 Longbridge CLI 的再分发条款，并在
发布清单中记录版本与许可证。OpenD 继续由用户从 Futu 官方渠道安装，不打入 DMG。

未来公开发行必须新增另一档 `developer-id` 流程：

- Apple Developer Program。
- `Developer ID Application` 证书。
- Hardened Runtime 与最小 entitlement。
- `xcrun notarytool submit --wait`。
- `xcrun stapler staple/validate`。
- `spctl --assess` 必须通过。

公开发行档不得复用“右键打开”作为安装方案。

## Files To Add Or Update

- `changfu-desktop/macos/Package.swift`
  - 区分 Debug/Release RPath，Release 禁止开发机路径。
- `changfu-desktop/macos/Packaging/Info.plist`
  - 增加图标键；版本、构建号和 API Origin 由发布脚本写入。
- `changfu-desktop/macos/Packaging/AppIcon.icns`
  - 由用户提供的 1024 PNG 生成，不手工维护派生尺寸。
- `changfu-desktop/macos/scripts/build-app-icon.sh`
  - 生成并验证 iconset/icns。
- `changfu-desktop/macos/scripts/build-release-app.sh`
  - 构建自包含 arm64 Release App。
- `changfu-desktop/macos/scripts/sign-internal-app.sh`
  - 按嵌套顺序执行 ad-hoc 签名。
- `changfu-desktop/macos/scripts/build-internal-dmg.sh`
  - 生成 DMG、SHA-256 和 manifest。
- `changfu-desktop/macos/scripts/verify-internal-dmg.sh`
  - 验证镜像、签名、架构、RPath、依赖和敏感文件边界。
- `changfu-desktop/macos/docs/internal-dmg-release-runbook.md`
  - 发布命令、首次安装、干净机器验收、升级与回滚。
- `changfu-desktop/macos/README.md`
  - 区分开发 `.app`、内部 DMG 与未来正式公证包。
- `.trae/documents/changfu_desktop_architecture_plan.md`
  - 同步内部灰度发行现状、无证书限制与正式发行门禁。

## Assumptions & Decisions

- 本轮只规划和实现 arm64，不生成无法运行的伪 Universal 包。
- 最低系统继续使用 macOS 14，不在本轮扩大系统兼容面。
- 无 Apple 证书是用户明确选择，因此接受 Gatekeeper 首次人工放行。
- “保证可用”通过可复现构建、自动包体检查和干净机器 E2E 验收实现，不宣称
  Gatekeeper 无提示。
- App 不携带 OpenD，不自动安装或修改 OpenD。
- 不在 App 或 DMG 中注入任何 API Key、券商凭据、数据库地址或后台 Secret。
- 正式包固定连接经过验证的 HTTPS 云端 Origin；Debug 模式仍按既有隐藏入口进入。
- 首发手工升级，不引入 Sparkle、Appcast 或增量更新。
- 正式图标源 PNG 是执行前置输入；没有该文件不得生成候选 DMG。
- Coze CLI 当前未安装，本方案基于仓库和本机工具链直接盘点，不创建或修改 Coze
  项目。

## Verification

### 自动门禁

1. 现有 Swift 桌面测试全部通过，`ChangFuDomain` 行覆盖率保持 100%。
2. UI contract 检查通过。
3. 主程序、BrokerHost、LongbridgeHost 均以 Release/arm64 成功构建。
4. 后端发布门禁继续通过，云端 `/v1/health` 与 `/v1/ready` 正常。
5. DMG 的 `hdiutil verify`、SHA-256、manifest 一致。
6. App 内所有 Mach-O 均为 arm64。
7. 所有嵌套代码和 App 的 `codesign --verify --strict` 通过。
8. `otool` 审计无仓库、用户目录、`.data` 或 Command Line Tools RPath。
9. 包内无密钥、`.env`、数据库、测试夹具和日志。
10. App 从 DMG 复制到仓库外临时目录后可以启动并定位两个 Host 与 CLI。

### 人工验收

1. 在干净 Apple Silicon、macOS 14+ 机器完成安装。
2. 按内部说明首次右键打开成功；明确记录 Gatekeeper 提示。
3. 云端账号登录、首次改密、退出和重启通过。
4. Keychain 保存与恢复通过。
5. OpenD 四类状态提示和真实只读链路通过。
6. Longbridge 未授权、授权及重启恢复通过。
7. Futu/Longbridge 数据、缓存和报告互不串扰。
8. SELL PUT 报告可以完成或对缺失数据给出明确失败结果，不永久卡住。
9. 手工覆盖升级后登录态与本地数据连续。
10. 使用上一 approved DMG 回滚后 App 可启动且数据仍可读。

### 发布结论

只有同时满足自动门禁与干净机器人工验收的 DMG 才能交付内部用户。若希望用户直接
双击打开、不出现未知开发者提示，则必须停止使用本方案的 ad-hoc 档位，转为
Developer ID 签名与 Apple 公证流程。
