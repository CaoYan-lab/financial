# 本地全量单元测试与集成测试发布前方案

## Summary

目标是在正式对外发布前，为当前云端生产形态建立一套可重复、默认零真实交易风险的本地测试门禁，并按固定顺序执行：

1. 静态检查与构建。
2. 全量单元测试。
3. 独立临时 PostgreSQL 上的数据库集成测试。
4. 云 Web、Worker、任务队列和全部对外 API 的本地集成测试。
5. Futu、Longbridge 真实只读连通性与 LLM/资讯真实冒烟。
6. Playwright 双浏览器端到端测试。
7. 生成机器可读结果、覆盖率报告和人工发布检查单。

本方案覆盖正式云端实际暴露的全部接口。券商查询使用真实只读凭据做独立冒烟；下单、撤单、启动自动交易等写操作只连接测试替身，任何测试失败都不得回落到真实写接口。

发布门禁：

- 所有既有测试与新增测试必须通过。
- `api/cloud/multiuser/**` 行覆盖率不低于 85%，分支覆盖率不低于 80%；认证、Futu 门禁、租户归属和真实交易门禁等核心安全模块以关键分支 100% 覆盖为目标。
- 云端 API 清单中的每个方法和路径至少有一个正常用例，并覆盖其关键鉴权、权限、参数、上游失败和数据隔离分支。
- 浏览器关键流程通过，响应、日志、任务载荷和测试报告中不得泄漏 App Secret、Access Token、完整账户号或其他用户数据。
- 测试过程不得产生真实订单、真实撤单或开启真实自动交易。

## Current State Analysis

### 工程与测试现状

- 项目为 React 18、Express、TypeScript、Vite、Vitest，测试命令目前是 `vitest run --pool=threads --maxWorkers=4`。
- 仓库现有 52 个 `*.test.ts` 文件，静态统计约 208 个测试声明；其中 `tests/multiuser/` 有 7 个文件，已覆盖密码、凭据加密、请求安全上下文、Futu 路由门禁、Longbridge Context、任务 SQL 和订单归属 SQL。
- 当前没有统一的 Vitest 配置、覆盖率门禁、Playwright、API 合约清单或一键发布前测试脚本。
- 现有 PostgreSQL 集成测试依赖 `.data/cloud-pg/database_url`，部分用例默认跳过，且复用开发数据库；这不满足正式发布前的强隔离要求。
- 本机已有 `.venv-cloud`、本地 PostgreSQL 数据目录、数据库连接文件和云端 secrets 文件。Node/npm 不在默认 PATH，现有本地启动脚本已固定使用 `/Users/bytedance/.nvm/versions/node/v24.16.0/bin`。
- `scripts/run-multiuser-local.sh` 可以构建并启动 Web/Worker，但会使用当前 `financial` 开发库，也没有测试替身、健康等待、测试执行、结果归档和自动清理阶段。

### 生产请求链路

- `api/cloud/http/cloudWebApp.ts` 的顺序是：公开认证路由、旧认证回退、`requireAuth`、多用户安全上下文、多用户私有路由、Futu 门禁、云端覆盖路由、旧 Express 路由。
- `api/cloud/worker/workerServer.ts` 同时消费旧 `cloud_jobs` 和新增 `multiuser.longbridge_jobs`，并负责 leader、心跳、策略和订单监管。
- 新增多用户代码位于 `api/cloud/multiuser/**` 与 `src/multiuser/**`；现有核心业务目录保持不变，只通过云 Web、Worker 和 CloudApp 三个入口挂载。
- Longbridge 租户接口中，账户/持仓直接使用独立 SDK Context，订单读取、详情、提交、撤单通过子进程；真实交易受 `shadow_verified_at + mode=live + live_trading_enabled` 三重门禁。
- Futu 数据由共享 OpenD 提供，必须验证 member 始终 403、owner 未解锁 423、未设置二次密码 428、有效浏览器解锁后才可读取。

### 当前主要缺口

- 多用户公开认证、用户管理、Futu 二次密码服务、连接保存/替换/禁用、租户数据服务、策略服务和 Worker runtime 缺少完整单元测试。
- 尚无真实 PostgreSQL 下的 owner 初始化、唯一约束、会话撤销、滑动解锁、任务竞争认领、租户数据隔离和幂等交易测试。
- 尚无完整 Cloud App HTTP 测试，无法证明多层 Router 的优先级、旧路由回落和 Futu 门禁不会泄漏数据。
- 尚无 Worker 与 Web 串联测试，40 秒同步等待类接口缺少成功、失败和超时验证。
- 尚无双浏览器 Cookie 隔离、401 自动跳转、首次改密、Futu 解锁和 Longbridge 绑定状态的自动化验收。
- 现有 `src/multiuser/api/multiUserApi.ts` 对 401 只抛普通错误，`src/multiuser/fetchGuard.ts` 又跳过 `/api/multiuser/`；测试应明确暴露并验证这类跨层问题，发现缺陷后再做最小修复。

## Proposed Changes

### 1. 建立测试分层与统一命令

修改 `package.json`：

- 增加 `test:unit`，只运行单元测试并生成覆盖率。
- 增加 `test:integration:db`，仅运行独立测试库用例。
- 增加 `test:integration:http`，运行 Cloud App 与 Worker HTTP/任务链路。
- 增加 `test:smoke:external`，仅在显式开关下运行 Futu、Longbridge、LLM/资讯真实只读冒烟。
- 增加 `test:e2e`，运行 Playwright 关键流程。
- 增加 `test:release:local`，严格按“检查 → 单元 → 数据库集成 → HTTP/Worker 集成 → 外部只读冒烟 → E2E → 汇总”串行执行。
- 保留现有 `npm test` 兼容行为。

新增开发依赖：

- `@vitest/coverage-v8`：覆盖率采集与门禁。
- `@playwright/test`：浏览器端到端测试。

新增 `vitest.config.ts`：

- 将单元测试、数据库集成测试、HTTP 集成测试拆成明确 include/exclude。
- 对 `api/cloud/multiuser/**` 设置 85% 行覆盖率、80% 分支覆盖率。
- 排除类型文件、纯入口启动文件、构建产物、第三方目录与测试替身。
- 保持现有最多 4 worker；数据库集成项目使用单 worker，避免共享测试库竞争。

新增 `playwright.config.ts`：

- 使用本地 Cloud Web 地址，固定 Chromium。
- 测试失败保留截图、页面快照、控制台错误和网络失败信息。
- 默认单 worker，避免多浏览器用例争用同一测试用户。

### 2. 独立临时 PostgreSQL 测试基础设施

新增 `tests/multiuser/support/testDatabase.ts`：

- 复用 `deploy/volcano/pg/local_pg.py` 启动的本地 PostgreSQL 实例，但创建固定专用数据库 `financial_test`，不使用开发库 `financial`。
- 测试开始前强制重建测试数据库，依次应用 `deploy/volcano/pg/schema.sql` 和 `deploy/volcano/pg/multiuser_schema.sql`。
- 播种 owner、member A、member B、绑定、引擎状态和最小历史数据。
- 每个测试文件使用事务或唯一测试前缀；全套结束后删除测试数据库。
- 删除前校验数据库名必须是 `financial_test`，防止误删开发库或远程 AIDAP。

新增 `tests/multiuser/support/globalSetup.ts`：

- 校验 `DATABASE_URL` 指向本机 socket/localhost。
- 设置测试专用 JWT、凭据主密钥、owner 用户名和短轮询间隔。
- 禁止接受远程主机连接串作为自动重建目标。
- 在 teardown 中关闭连接池、停止进程并清理测试库。

修改 `deploy/volcano/pg/local_pg.py`：

- 仅增加可复用的本地服务 URI/数据库创建能力，保留现有 `financial` 开发库行为。
- 不在普通 `start` 中自动处理测试库，测试库生命周期只由测试入口控制。

新增 `tests/multiuser/schema.integration.test.ts`：

- 验证两份 schema 可重复应用。
- 验证单 owner、单活动 Longbridge 绑定、租户外键、任务状态、订单事件幂等键等约束。
- 验证 owner 不存在、多个 owner、重复绑定等场景 fail closed。

### 3. 补齐多用户单元测试

新增或扩展以下文件：

- `tests/multiuser/authService.test.ts`
  - 正确/错误密码、禁用用户、owner 初始化失败、审计写入、JWT 用户键。
- `tests/multiuser/profileStore.test.ts`
  - owner 幂等初始化、用户创建、禁用、重置密码、首次改密、会话撤销时间。
- `tests/multiuser/futuStepUpService.test.ts`
  - 主密码校验、二次密码不同性、独立 salt、令牌哈希、过期、滑动续期、撤销和错误令牌。
- `tests/multiuser/futuAccessPolicy.test.ts`
  - 扩充全部 Futu 路由族、Cookie 属性、异常 fail closed，证明 member 在任何数据库读取前被拒绝。
- `tests/multiuser/connectionStore.test.ts`
  - 加密绑定、pending/verified/invalid/disabled 生命周期、替换绑定、owner legacy_env、跨用户读取拒绝。
- `tests/multiuser/tenantDataService.test.ts`
  - 账户映射、持仓估值、历史去重/筛选/分页、子进程环境变量隔离、代理与错误归一化。
- `tests/multiuser/tenantStrategyService.test.ts`
  - 租户策略数据源、候选池、信号、待确认订单、行情异常和用户/绑定键贯穿。
- `tests/multiuser/tenantWorkerRuntime.test.ts`
  - 所有 job type、重试策略、禁用用户、错误绑定、影子门禁、提交幂等、监管更新和自动撤单决策。
- `tests/multiuser/privateRouter.test.ts`
  - Router 参数校验、角色校验、状态码、错误码和响应脱敏。
- `tests/multiuser/publicAuthRouter.test.ts`
  - 开关回落、登录限流、Cookie 属性、登录失败、依赖异常、退出同时撤销两个 Cookie。
- `tests/multiuser/frontendApi.test.ts` 与 `tests/multiuser/fetchGuard.test.ts`
  - 请求凭据、401 跳转、403/409/423/428 事件映射以及 `/api/multiuser/*` 错误处理。

保留并扩展现有测试：

- `credentialVault.test.ts`
- `longbridgeContextRegistry.test.ts`
- `passwordService.test.ts`
- `securityContext.test.ts`
- `tenantJobStore.test.ts`
- `tenantOrderStore.test.ts`
- `privateRouterFeatureFlag.test.ts`

所有数据库和 SDK 在单元层使用严格替身；测试必须断言未发生额外调用，尤其是权限失败后不得继续访问存储或券商。

### 4. 建立安全的券商与外部服务测试替身

新增 `tests/multiuser/fixtures/brokerStubServer.ts`：

- 提供 Futu/Longbridge 的固定账户、持仓、订单、成交与错误响应。
- 记录所有写请求，供测试断言租户键、幂等键和参数。
- 对提交、撤单、启动自动交易只返回测试回执，绝不连接真实券商。
- 支持成功、超时、拒绝、重复请求、部分成交和上游不可用场景。

新增 `tests/multiuser/fixtures/externalServiceStubs.ts`：

- 为 LLM、行情补充、新闻和报告生成提供确定性响应。
- 覆盖正常、限流、超时、非法 JSON 和部分数据缺失。

在 `api/cloud/multiuser/longbridge/tenantDataService.ts` 和必要的云端任务适配点增加最小测试注入边界：

- 默认生产行为不变。
- 仅当 `NODE_ENV=test` 且测试专用变量同时存在时，写操作指向本地替身。
- 真实凭据永不发送给替身；替身只接收测试凭据。
- 若测试模式配置不完整，写操作直接失败，不允许回落到真实 SDK/子进程。

### 5. PostgreSQL 与 Worker 集成测试

新增：

- `tests/multiuser/tenantPersistence.integration.test.ts`
- `tests/multiuser/tenantJobs.integration.test.ts`
- `tests/multiuser/futuSessions.integration.test.ts`
- `tests/multiuser/workerRuntime.integration.test.ts`

覆盖：

- owner/member 建立、改密、禁用、重置与 JWT 会话撤销。
- Futu 二次密码设置、双令牌隔离、滑动续期、主动锁定、退出撤销、过期清理。
- A/B 两个用户的连接、事件、订单、任务和快照行严格隔离。
- 两个 Worker 并发认领时 `SKIP LOCKED` 不重复消费。
- 任务成功、三次重试、不可重试失败、用户禁用后取消、凭据替换后旧任务失效。
- 待确认订单确认/拒绝/批量过期和重复确认幂等。
- 影子模式、未验收、未开启实盘任一条件不满足时，写替身调用次数必须为零。
- 监管对部分成交、终态、超时和自动撤单生成正确状态与事件。

同时调整现有 `tests/cloud/*.integration.test.ts`：

- 统一使用显式 `RUN_PG_INTEGRATION=1` 与测试库 URL。
- 不再因开发库文件存在与否产生静默跳过。
- 所有测试数据使用唯一前缀并在结束时验证清理结果。

### 6. 云端全量 API 合约与隔离矩阵

新增 `tests/cloud/cloudApiContract.integration.test.ts`，通过真实 `createCloudApp()`、临时 HTTP 端口和独立测试库执行；以一份表驱动清单覆盖以下生产接口族：

- 公共接口：`GET /api/health`、`GET /api/auth/config`、`POST /api/auth/login`、`POST /api/auth/logout`。
- 登录态：`GET /api/auth/me`、`GET /api/multiuser/session`、`POST /api/multiuser/password/change`。
- 用户管理：用户列表、创建、启停、重置密码。
- Futu 二次验证：访问状态、设置密码、解锁、锁定。
- Longbridge 连接：查询、预验证、保存、替换、断开。
- 云基础设施：Worker 全量状态、指定平台状态。
- Futu 生产接口：账户、数据源、实盘看板/设置/历史/待确认订单/券商订单/订单详情/托管订单/启动/停止/单次运行/撤单，以及 A 股、报告、模拟盘中会读取 Futu 数据的路径。
- Longbridge 租户接口：工作台、数据源、订阅状态、账户、看板、配置、设置、历史、托管订单、订单列表/详情、启动/停止/单次运行、确认/拒绝/批量过期/撤单。
- 其他云端接口：报告读取与生成、模拟盘、实时行情、交易预览，以及最终 404。
- Worker HTTP：`/`、`/health`、`/status` 和未知路径。

每条接口至少验证：

- 未登录为 401，公开接口除外。
- 首次改密用户访问非白名单接口为 428。
- owner/member 角色边界。
- Futu member 为 403，owner 未配置为 428，未解锁为 423，解锁后才到达业务处理。
- Longbridge member 无绑定为 428、无效绑定为 409、有效绑定只读取自己的数据。
- 正常输入、边界输入、非法参数、资源不存在、数据库异常、Worker/上游失败与超时。
- 响应 Content-Type、Cookie 安全属性、中文错误、分页字段和约定状态码。
- 对 A/B 互换 orderId、bindingId、jobId、pendingOrderId 的越权请求统一返回 403/404，正文不得透露资源是否属于他人。
- member 未被新 Router 显式允许的 `/api/longbridge/*` 必须 404，不得回落到 owner 旧路由。

新增 `tests/cloud/apiInventory.test.ts`：

- 维护显式 API 清单并扫描 `api/routes/**`、`api/cloud/http/**`、`api/cloud/multiuser/http/**` 的路由声明。
- 新增或删除生产路由而未同步测试矩阵时直接失败，防止“每个接口”随代码演进失真。

### 7. 真实只读外部冒烟

新增 `scripts/test-external-readonly.sh` 与 `tests/smoke/externalReadonly.smoke.test.ts`：

- 必须显式设置 `RUN_EXTERNAL_READONLY_SMOKE=1` 才运行。
- 使用现有 secrets，但只调用 Futu 状态/账户/持仓/订单查询、Longbridge 账户/持仓/订单查询。
- LLM/资讯仅发起一组最小、固定输入的真实请求，校验授权、网络、响应结构和超时，不评价模型内容。
- 所有请求设置硬超时和有限重试，结果只记录脱敏字段。
- 进程启动前删除或覆盖所有真实交易开关；脚本检测到 live/auto-submit/auto-cancel 为 true 时拒绝执行。
- 测试结束扫描日志，确认无 App Secret、Access Token、完整账户号和 Cookie。

真实冒烟失败单独标记为“环境/上游失败”或“代码契约失败”，但正式发布前两类都必须处置并重新运行。

### 8. Playwright 双浏览器端到端验收

新增：

- `tests/e2e/multiuser-auth.spec.ts`
- `tests/e2e/futu-isolation.spec.ts`
- `tests/e2e/longbridge-tenant.spec.ts`
- `tests/e2e/cloud-navigation.spec.ts`
- `tests/e2e/support/seed.ts`

覆盖：

- owner 与 member 使用两个独立 BrowserContext 登录，`fa_session` 互不复用。
- 首次登录 member 被强制要求改密，完成后旧 Cookie 失效并重新登录。
- member 无法进入任何 Futu 页面或通过直接 URL/API 获取数据。
- owner 新登录默认锁定；在浏览器 A 解锁后浏览器 B 仍锁定；主动锁定和退出立即失效。
- Longbridge 未绑定、验证失败、绑定成功、失效重连和断开状态。
- A/B 页面只能看到各自账户、持仓、订单、策略和历史夹具。
- 任意 API 返回 401 时自动回到登录页；403/409/423/428 显示对应全中文操作界面。
- 云端主要导航页面无阻断性控制台错误、无请求死循环、无英文错误残留。

E2E 启动完整的测试 Web、Worker、临时数据库和替身服务；使用固定测试账号，不读取或修改开发账号。

### 9. 一键发布前执行器与报告

新增 `scripts/run-local-release-tests.sh`：

- 固定使用仓库现有 Node 路径并校验 Python、PostgreSQL、Playwright 浏览器和必需环境变量。
- 使用 `set -euo pipefail`，每一阶段带时间戳输出并写入 `.data/test-results/`。
- 顺序执行 `npm run check`、`npm run lint`、`npm run build`、单元测试、数据库集成、HTTP/Worker 集成、外部只读冒烟和 E2E。
- 任一阶段失败立即停止后续发布流程，但始终执行进程、端口和临时数据库清理。
- 支持 `RUN_EXTERNAL_READONLY_SMOKE=0` 的开发快速模式；正式发布模式必须为 1。
- 输出 `summary.json` 和中文 `summary.md`，列出通过数、失败数、跳过数、覆盖率、耗时、外部依赖状态和日志脱敏扫描结果。

新增 `docs/local-release-test-runbook.md`：

- 记录依赖安装、测试命令、只读凭据要求、端口、报告位置、失败分类和重跑方式。
- 明确禁止把测试输出、数据库连接串和密钥提交 Git。
- 提供发布前人工检查清单；执行完测试后先由用户检查 diff、报告和日志，再允许提交或部署。

修改 `.gitignore`：

- 忽略 `coverage/`、`playwright-report/`、`test-results/` 和 `.data/test-results/`。

### 10. 缺陷修复与回归闭环

测试执行不是只出报告。任何失败按以下规则处理：

- 先保留最小复现用例，再修改对应实现；不得通过放宽断言、跳过用例或降低覆盖率掩盖问题。
- 鉴权、权限、租户隔离、凭据泄漏、真实交易门禁问题按阻断发布处理，修复后重跑单元、数据库、HTTP、E2E 和安全扫描全链路。
- 普通接口契约问题至少重跑所属测试层和全部既有测试；共享中间件、数据库模型或 Worker 修改则升级为全链路重跑。
- 外部服务瞬时失败先用固定输入重试一次；仍失败时区分网络/凭据/上游契约，但在正式发布报告中不得记为通过。
- 每个修复都保留对应回归测试，并同步 API inventory 或测试夹具。
- 已知重点检查 `src/multiuser/api/multiUserApi.ts`、`src/multiuser/fetchGuard.ts` 与 `src/cloud/cloudFetch.ts` 的 401 协作，确保多用户 API 返回 401 时同样清理登录态并跳转登录页。
- 修复范围遵守既定目录隔离约束；若测试证明必须修改现有核心模块，先记录证据和最小改动理由，提交前单独列入人工检查清单。

## Assumptions & Decisions

- 范围采用“云端全量接口”，不要求为仅本地开发模式才存在且生产 Cloud App 不暴露的内部路径另建端到端用例；其底层逻辑仍由既有单元测试覆盖。
- PostgreSQL 使用本机服务中的独立 `financial_test` 数据库，测试执行器有权创建和删除该数据库，但绝不改动 `financial`。
- 券商真实调用仅限只读；所有写操作走本地替身。
- LLM/资讯采用替身作为主集成测试，另执行显式开启的最小真实冒烟。
- 浏览器端到端测试纳入正式发布门禁。
- 不修改现有 Futu/Longbridge 核心业务目录；需要的测试注入点优先放在新增多用户模块、测试支持代码或云端入口。
- 不在本轮测试中开启任何用户的 `shadow_verified_at` 或真实交易开关到可连接真实券商的状态。
- 不自动提交 Git、不部署；测试全绿后先提供报告和变更供人工检查。

## Verification Steps

执行阶段严格按以下顺序，前一步失败则停止：

1. 环境预检
   - Node/npm 使用已存在的固定路径。
   - `.venv-cloud`、本地 PostgreSQL、测试端口和必要 secrets 可用。
   - 确认测试数据库目标为本机 `financial_test`。
   - 确认所有真实交易开关关闭。
2. 静态门禁
   - `npm run check`
   - `npm run lint`
   - `npm run build`
3. 单元测试
   - `npm run test:unit`
   - 检查新增多用户模块覆盖率达到行 85%、分支 80%，核心安全分支无遗漏。
4. 数据库集成
   - 创建并迁移 `financial_test`。
   - `npm run test:integration:db`
   - 确认无跳过、无残留测试数据。
5. HTTP 与 Worker 集成
   - 启动替身、Cloud Web 和 Worker。
   - `npm run test:integration:http`
   - 核对 API inventory 100% 命中，A/B 租户交叉矩阵全部拒绝。
6. 真实只读冒烟
   - `RUN_EXTERNAL_READONLY_SMOKE=1 npm run test:smoke:external`
   - 核对 Futu、Longbridge、LLM/资讯授权、网络和响应契约。
7. 浏览器验收
   - `npm run test:e2e`
   - 检查双 BrowserContext、401 跳转、Futu 解锁隔离和 Longbridge 状态流程。
8. 安全与结果审计
   - 扫描响应、数据库 job payload、Web/Worker 日志和测试报告中的凭据/账户泄漏。
   - 检查没有真实订单、撤单或自动交易调用记录。
   - 检查临时进程、端口和 `financial_test` 已清理。
9. 最终发布门禁
   - 执行 `npm run test:release:local` 完整复跑。
   - 人工审阅 Git diff、`summary.md`、覆盖率报告和失败为零的接口矩阵。
   - 只有人工确认后再提交 Git 或进入部署步骤。
