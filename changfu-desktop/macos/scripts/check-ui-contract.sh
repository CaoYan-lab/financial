#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
THEME="$ROOT/App/FutuTheme.swift"
WORKSPACES="$ROOT/App/FutuWorkspaces.swift"
ROOT_VIEW="$ROOT/App/RootView.swift"
AUTH_GATE="$ROOT/App/AuthenticationGateView.swift"
APP_STATE="$ROOT/App/AppState.swift"
BACKEND_ENVIRONMENT="$ROOT/Infrastructure/BackendEnvironment.swift"
SECURE_CREDENTIALS="$ROOT/Infrastructure/SecureCredentialStore.swift"
SUBSCRIPTION="$ROOT/App/SubscriptionWorkspace.swift"
PROVIDER_POOL="$ROOT/App/ProviderPoolManagerView.swift"
SETTINGS="$ROOT/App/SettingsView.swift"
GLOBAL_MODEL="$ROOT/App/GlobalModelConfigurationView.swift"
DECISION_CONTEXT="$ROOT/App/DecisionContextBuilder.swift"
MARKET_INSIGHT="$ROOT/App/MarketEventInsight.swift"
FUTU_BRIDGE="$ROOT/FutuCppBridge/ChangFuFutuBridge.mm"

required_tokens=(
  pageTitle
  pageSubtitle
  panelTitle
  panelSubtitle
  body
  metricLabel
  metricValue
  tableHeader
  tableCell
)

for token in "${required_tokens[@]}"; do
  if ! rg -q "static let ${token}" "$THEME"; then
    printf '%s\n' "UI 契约失败：缺少设计令牌 ${token}" >&2
    exit 1
  fi
done

if rg -n '\.font\(\.(caption|caption2|callout|body|headline)' \
  "$WORKSPACES" "$ROOT_VIEW" "$SUBSCRIPTION" "$PROVIDER_POOL" "$SETTINGS"; then
  printf '%s\n' "UI 契约失败：业务模块不得直接使用系统语义字号" >&2
  exit 1
fi

if rg -n 'cornerRadius: 24|\.padding\(8\)' "$ROOT_VIEW"; then
  printf '%s\n' "UI 契约失败：桌面主内容不得恢复外层圆角或四周留白" >&2
  exit 1
fi

for height in 230 250 390 490; do
  if ! rg -q "minimumHeight: ${height}" "$WORKSPACES" "$SUBSCRIPTION" "$PROVIDER_POOL"; then
    printf '%s\n' "UI 契约失败：缺少 ${height}px 等高模块约束" >&2
    exit 1
  fi
done

if ! rg -U -q \
  'GridItem\(\n[[:space:]]+\.flexible\(\),\n[[:space:]]+spacing: FutuTheme\.sectionSpacing,\n[[:space:]]+alignment: \.topLeading\n[[:space:]]+\)' \
  "$WORKSPACES"; then
  printf '%s\n' "UI 契约失败：研究技能双列必须顶部对齐" >&2
  exit 1
fi

for contract in \
  '"Futu 与 Longbridge 代码、容量和替换额度分别管理"' \
  'DiscoveryMode.allCases' \
  '"CALL / PUT"' \
  'providerPoolOnlineValidated'
do
  if ! rg -q "$contract" "$PROVIDER_POOL"; then
    printf '%s\n' "UI 契约失败：Provider 标的池缺少 ${contract}" >&2
    exit 1
  fi
done

for contract in \
  'case strategyCenter' \
  '"策略中心"' \
  '"昨收"' \
  '"当前时段价"' \
  '"全部收起"' \
  '"模型置信度"' \
  '"数据时效"' \
  '"未提供"' \
  '"开始时间"' \
  '"结束时间"' \
  '"上一页"' \
  '"下一页"' \
  '"平仓卖出"' \
  '"卖空"' \
  '"单标的评估"' \
  'StrategyCenterAnchor.reports'
do
  if ! rg -q "$contract" "$WORKSPACES" "$ROOT/Domain/WorkspaceModels.swift"; then
    printf '%s\n' "UI 契约失败：缺少 ${contract}" >&2
    exit 1
  fi
done

for contract in \
  '"直推模式不使用候选池"' \
  'candidateRow\(' \
  '"生成时间"' \
  '"数据时效"' \
  '"已过期"'
do
  if ! rg -q "$contract" "$WORKSPACES"; then
    printf '%s\n' "UI 契约失败：候选池模式或表格展示缺少 ${contract}" >&2
    exit 1
  fi
done

for contract in \
  '"策略与标的详情"' \
  '"全部标的状态"' \
  '"评估说明"' \
  '"暂不评估"' \
  'shadowEvaluationItems' \
  'isShadowEvaluationInFlight'
do
  if ! rg -q "$contract" "$WORKSPACES" "$APP_STATE"; then
    printf '%s\n' "UI 契约失败：量化评估状态详情缺少 ${contract}" >&2
    exit 1
  fi
done

for contract in \
  '"交易设置"' \
  '"自动提交真实订单"' \
  '"待确认订单"' \
  '"系统挂单监管"' \
  '"确认真实订单"' \
  '"撤销剩余订单"' \
  'currentLiveTradingModeLabel'
do
  if ! rg -q "$contract" "$WORKSPACES" "$APP_STATE"; then
    printf '%s\n' "UI 契约失败：真实交易工作台缺少 ${contract}" >&2
    exit 1
  fi
done

if rg -q '"真实下单关闭"' "$WORKSPACES"; then
  printf '%s\n' "UI 契约失败：交易页不得继续显示固定真实下单关闭状态" >&2
  exit 1
fi

if rg -q 'kind: "POLICY"|kind: event\.group\.rawValue' "$DECISION_CONTEXT"; then
  printf '%s\n' "UI 契约失败：市场情报证据类型必须映射到后端注册类型" >&2
  exit 1
fi

for contract in \
  'shadowRuntimeByConnection' \
  'shadowTradingTasks: \[String: Task<Void, Never>\]' \
  'runShadowTradingOnce\(connectionId: String, provider: String\)' \
  'tradingConfigurations\[connectionId\]' \
  'provider == "LONGBRIDGE"'
do
  if ! rg -q "$contract" "$APP_STATE"; then
    printf '%s\n' "UI 契约失败：量化运行态未按券商连接隔离 ${contract}" >&2
    exit 1
  fi
done

for contract in \
  '"摘要"' \
  '"科技影响"' \
  '"数据对比"' \
  '"市场预期"' \
  '"实际值"' \
  '"预期差"' \
  '"风险与边界"' \
  '"来源追溯"' \
  'expandedEventID'
do
  if ! rg -q "$contract" "$WORKSPACES"; then
    printf '%s\n' "UI 契约失败：市场事件详情缺少 ${contract}" >&2
    exit 1
  fi
done

for contract in \
  '"偏利好"' \
  '"偏利空"' \
  '"双向影响"' \
  '"待观察"' \
  '"科技股影响为规则推导，不是券商原始结论或交易建议。"' \
  '"实际值尚未公布，当前影响仅为情景预案。"'
do
  if ! rg -q "$contract" "$MARKET_INSIGHT"; then
    printf '%s\n' "UI 契约失败：市场影响解释器缺少 ${contract}" >&2
    exit 1
  fi
done

for contract in \
  '"drilling rig"' \
  '"three-month treasury"' \
  '"red book"' \
  'case \.usMacro: limit = 6' \
  'case \.watchlist: limit = 8' \
  'case \.breakingRisk: limit = 6' \
  'isModelEligible'
do
  if ! rg -q "$contract" "$MARKET_INSIGHT"; then
    printf '%s\n' "UI 契约失败：科技股事件筛选缺少 ${contract}" >&2
    exit 1
  fi
done

for contract in \
  '"当前没有通过科技相关性筛选的关键事件"' \
  'MarketEventRelevance\.displayEvents'
do
  if ! rg -q "$contract" "$WORKSPACES"; then
    printf '%s\n' "UI 契约失败：市场页科技事件收敛缺少 ${contract}" >&2
    exit 1
  fi
done

for contract in \
  'var remaining = 10' \
  '\(\.breakingRisk, 4\)' \
  '\(\.watchlist, 3\)' \
  '\(\.usMacro, 3\)' \
  '"MARKET_INTELLIGENCE_SCOPE"' \
  '"事实边界：按来源标题筛选，未独立核实全文"'
do
  if ! rg -q "$contract" "$DECISION_CONTEXT"; then
    printf '%s\n' "UI 契约失败：模型市场情报配额缺少 ${contract}" >&2
    exit 1
  fi
done

for contract in \
  '"semiconductor export control"' \
  '"AI chip export ban"' \
  '"Taiwan semiconductor disruption"' \
  '"data center cloud cyberattack outage"' \
  'isTechnologyMacroEvent'
do
  if ! rg -q "$contract" "$FUTU_BRIDGE"; then
    printf '%s\n' "UI 契约失败：Futu 科技信源查询缺少 ${contract}" >&2
    exit 1
  fi
done

for contract in '"App Key"' '"App Secret"' '"Access Token"' '"保存并连接"'; do
  if ! rg -q "$contract" "$SETTINGS"; then
    printf '%s\n' "UI 契约失败：Longbridge 配置缺少 ${contract}" >&2
    exit 1
  fi
done

for contract in '"第三方模型"' '"OPENAI_RESPONSES"' '"OPENAI_CHAT_COMPLETIONS"' '"仅旗舰版可用"' '"保存配置"'; do
  if ! rg -q "$contract" "$GLOBAL_MODEL" "$ROOT/Domain/ModelProviderModels.swift"; then
    printf '%s\n' "UI 契约失败：第三方模型配置缺少 ${contract}" >&2
    exit 1
  fi
done

if rg -q '"第三方模型"|ModelProviderProtocol' "$SETTINGS"; then
  printf '%s\n' "UI 契约失败：第三方模型不得出现在 Longbridge 配置中" >&2
  exit 1
fi

for contract in 'selectedConversationModelRoute' 'conversationModelOptions' '"长富Pro"'; do
  if ! rg -q "$contract" "$ROOT_VIEW" "$GLOBAL_MODEL" "$ROOT/App/AppState.swift"; then
    printf '%s\n' "UI 契约失败：对话模型选择缺少 ${contract}" >&2
    exit 1
  fi
done

for contract in 'isModelCenterOpen' 'Label\("模型", systemImage: "cpu"\)' 'GlobalModelWorkspace'; do
  if ! rg -q "$contract" "$ROOT_VIEW" "$ROOT/App/AppState.swift" "$GLOBAL_MODEL"; then
    printf '%s\n' "UI 契约失败：左下角模型入口缺少 ${contract}" >&2
    exit 1
  fi
done

if rg -q 'GlobalModelConfigurationView|第三方模型' "$SUBSCRIPTION"; then
  printf '%s\n' "UI 契约失败：套餐页不得承载第三方模型配置" >&2
  exit 1
fi

for contract in \
  '"evidenceCatalog"' \
  '"trendContext"' \
  '"positionExposure"' \
  '"accountRisk"' \
  '"ordersKnowledge"' \
  '"gapCatalog"' \
  '"temporalBoundary"' \
  '"outputContract"' \
  '"strength": .string' \
  'sourceAt\.addingTimeInterval\(300\)'
do
  if ! rg -q "$contract" "$DECISION_CONTEXT"; then
    printf '%s\n' "UI 契约失败：决策上下文缺少 ${contract}" >&2
    exit 1
  fi
done

for contract in \
  'onTapGesture(count: 5)' \
  'state.enableDebugMode()'
do
  if ! rg -Fq "$contract" "$ROOT_VIEW"; then
    printf '%s\n' "UI 契约失败：Debug 入口缺少 ${contract}" >&2
    exit 1
  fi
done

for contract in \
  'Debug 模式开启中' \
  'xmark.circle.fill' \
  'state.disableDebugMode()'
do
  if ! rg -Fq "$contract" "$AUTH_GATE"; then
    printf '%s\n' "UI 契约失败：Debug 状态条缺少 ${contract}" >&2
    exit 1
  fi
done

for contract in \
  'case debugLocal' \
  'http://127.0.0.1:4310' \
  'refresh-token.cloud' \
  'refresh-token.debug-local'
do
  if ! rg -Fq "$contract" "$BACKEND_ENVIRONMENT"; then
    printf '%s\n' "UI 契约失败：后台环境定义缺少 ${contract}" >&2
    exit 1
  fi
done

if ! rg -Fq 'refreshToken(for environment: BackendEnvironment)' "$SECURE_CREDENTIALS" \
  || ! rg -Fq 'switchBackendEnvironment' "$APP_STATE"; then
  printf '%s\n' "UI 契约失败：环境凭据隔离或切换逻辑缺失" >&2
  exit 1
fi

for contract in \
  '#if DEBUG' \
  '? .debugLocal' \
  'cloudEnvironment = configuredCloud'
do
  if ! rg -Fq "$contract" "$APP_STATE"; then
    printf '%s\n' "UI 契约失败：Debug 构建未默认连接本地 Gateway ${contract}" >&2
    exit 1
  fi
done

printf '%s\n' "UI 契约通过：字体、间距与等高约束完整"
