import ChangFuDomain
import ChangFuInfrastructure
import CryptoKit
import Foundation
import Observation

enum AuthenticationPhase: Equatable {
    case checking
    case signedOut(message: String?)
    case passwordChangeRequired(message: String?)
    case signedIn
}

private enum AppInteractionError: LocalizedError {
    case longbridgeContextUnavailable
    case longbridgeSellPutDataUnavailable(String)
    case providerPoolNotVerified
    case providerReportMismatch
    case liveOrderValidationFailed(String)

    var errorDescription: String? {
        switch self {
        case .longbridgeContextUnavailable:
            "Longbridge 金融上下文尚未接入后台，当前不会改用 Futu 数据"
        case .longbridgeSellPutDataUnavailable(let reason):
            "Longbridge SELL PUT 前置检查失败：\(reason)"
        case .providerPoolNotVerified:
            "标的池仅来自本地缓存，联网校验权益后才能发起研究"
        case .providerReportMismatch:
            "报告所属券商与当前平台不一致，已拒绝展示"
        case .liveOrderValidationFailed(let reason):
            "本地订单复核失败：\(reason)"
        }
    }
}

private struct SellPutRunState {
    var isLoading = false
    var isRunning = false
    var completedSymbols = 0
    var totalSymbols = 0
    var statusMessage: String?
}

struct ConversationMessage: Identifiable, Equatable {
    enum Role {
        case user
        case assistant
    }

    let id = UUID()
    let role: Role
    let content: String
    let evidence: [ModelResult.Evidence]
    let risks: [String]
    let exitCondition: String?
}

private struct ShadowHistoryState {
    var modelRuns: [ModelRunSummary] = []
    var modelRunPage = 1
    var modelRunTotal = 0
    var signals: [TradingSignal] = []
    var candidates: [TradingCandidate] = []
}

enum ShadowEvaluationItemState: Equatable {
    case active
    case waiting
    case error
}

struct ShadowEvaluationItem: Identifiable, Equatable {
    var id: String { symbol }
    let symbol: String
    let market: String
    let marketState: String
    let state: ShadowEvaluationItemState
    let reason: String
}

private struct ShadowEvaluationTaskResult: Sendable {
    let symbol: String
    let errorCode: String?
    let reason: String?
}

private struct ShadowRuntimeState {
    var status = "已停止"
    var lastRunAt: Date?
    var isRunning = false
    var isEvaluating = false
    var evaluationItems: [ShadowEvaluationItem] = []
    var evaluationUpdatedAt: Date?
}

private struct LiveTradingRuntimeState {
    var pendingOrders: [PendingLiveOrder] = []
    var orderActions: [PendingOrderAction] = []
    var lease: TradingLease?
    var session: LiveTradingSession?
    var statusMessage: String?
    var lastReconciledAt: Date?
    var isRefreshing = false
}

@MainActor
@Observable
final class AppState {
    private(set) var authenticationPhase: AuthenticationPhase = .checking
    private(set) var isAuthenticating = false
    private(set) var isChangingPassword = false
    private(set) var backendEnvironment: BackendEnvironment
    private(set) var isSwitchingBackendEnvironment = false
    var isDebugMode: Bool { backendEnvironment.isDebug }
    var platform: TradingPlatform = .futu {
        didSet {
            defaults.set(platform.rawValue, forKey: Keys.platform)
            syncActiveResearchPool()
        }
    }
    var workspace: FutuWorkspace = .overview {
        didSet { defaults.set(workspace.rawValue, forKey: Keys.workspace) }
    }
    var isSubscriptionCenterOpen = false
    var isModelCenterOpen = false
    var isResearchPoolManagerOpen = false
    private(set) var subscriptionCatalog: SubscriptionCatalog?
    private(set) var currentSubscription: UserSubscription?
    private(set) var currentSubscriptionOrder: SubscriptionOrder?
    private(set) var isSubscriptionLoading = false
    private(set) var subscriptionStatusMessage: String?
    private(set) var thirdPartyModelConfiguration: ThirdPartyModelConfigurationEnvelope?
    private(set) var isThirdPartyModelLoading = false
    private(set) var thirdPartyModelStatusMessage: String?
    private(set) var providerPoolSummaries: [ProviderPoolSummary] = []
    private(set) var providerPools: [String: ProviderPool] = [:]
    private(set) var providerPoolOnlineValidated = false
    private(set) var isProviderPoolLoading = false
    private(set) var providerPoolStatusMessage: String?
    private(set) var instrumentSearchResults: [BrokerInstrument] = []
    private(set) var instrumentSearchFetchedAt: String?
    private(set) var optionExpiries: [BrokerOptionExpiry] = []
    private(set) var optionContracts: [BrokerOptionContract] = []
    private(set) var optionChainFetchedAt: String?
    private(set) var isInstrumentDiscoveryLoading = false
    private var sellPutReports: [String: SellPutReport] = [:]
    private var sellPutReportHistories: [String: [SellPutReportHistoryItem]] = [:]
    private(set) var sellPutPools: [String: SellPutPool] = [:]
    private var sellPutRunStates: [String: SellPutRunState] = [:]
    var isSettingsOpen = false
    var conversationWidth: Double = 360 {
        didSet { defaults.set(conversationWidth, forKey: Keys.conversationWidth) }
    }
    var isConversationCollapsed = false
    private(set) var researchModels: [ResearchSkill: ResearchModelProfile] = [
        .quantitative: .deep,
        .sellPut: .risk
    ]
    private(set) var researchPoolEntitlement: ResearchPoolEntitlement = .unavailable
    private(set) var researchPool: [ResearchPoolItem] = []
    private(set) var conversationResearchSymbols: Set<String> = []
    private(set) var serverResearchPool: ServerResearchPool?
    private(set) var tradingCatalogs: [String: TradingCatalog] = [:]
    private(set) var tradingConfigurations: [String: TradingConfiguration] = [:]
    private(set) var liveExecutionSettings: [String: LiveExecutionSetting] = [:]
    private var liveTradingRuntimeByConnection: [String: LiveTradingRuntimeState] = [:]
    private var shadowHistoryByConnection: [String: ShadowHistoryState] = [:]
    private var shadowRuntimeByConnection: [String: ShadowRuntimeState] = [:]
    private var shadowRuntimeFallbackStatus = "已停止"
    let shadowModelRunPageSize = 10
    var startupAd: AdConfiguration?
    var startupAdRemainingSeconds = 0
    var isTradingCriticalFlowActive = false
    var account: AccountSummary?
    var positions: [PositionSummary] = []
    var market: MarketSummary?
    var quotes: [QuoteSummary] = []
    var minuteBars: [CandlestickSummary] = []
    var tickerPoints: [TickerSummary] = []
    var orderBooks: [OrderBookSummary] = []
    var openOrders: [BrokerOrderSummary] = []
    var recentDeals: [BrokerFillSummary] = []
    var historicalOrders: [BrokerOrderSummary] = []
    var historicalDeals: [BrokerFillSummary] = []
    var brokerDataGaps: [String] = []
    var isRefreshingBroker = false
    var brokerLastUpdatedAt: Date?
    var statusMessage: String?
    private(set) var marketIntelligence: MarketIntelligenceSnapshot?
    private(set) var isRefreshingMarketIntelligence = false
    private(set) var marketIntelligenceStatusMessage: String?
    var longbridgeAccount: AccountSummary?
    var longbridgePositions: [PositionSummary] = []
    var longbridgeMarket: MarketSummary?
    var longbridgeQuotes: [QuoteSummary] = []
    var longbridgeMinuteBars: [CandlestickSummary] = []
    var longbridgeTickerPoints: [TickerSummary] = []
    var longbridgeOrderBooks: [OrderBookSummary] = []
    var longbridgeOpenOrders: [BrokerOrderSummary] = []
    var longbridgeRecentDeals: [BrokerFillSummary] = []
    var longbridgeHistoricalOrders: [BrokerOrderSummary] = []
    var longbridgeHistoricalDeals: [BrokerFillSummary] = []
    var longbridgeDataGaps: [String] = []
    var isRefreshingLongbridge = false
    var longbridgeLastUpdatedAt: Date?
    var longbridgeStatusMessage: String?
    private(set) var hasLongbridgeCredentials = false
    var conversationMessages: [ConversationMessage] = []
    var isSendingMessage = false
    var selectedConversationModelRoute = ModelRoute.official

    var conversationModelOptions: [ConversationModelOption] {
        var options = [
            ConversationModelOption(
                id: ModelRoute.official,
                displayName: "长富Pro",
                detail: "由长富服务端选择适配模型"
            )
        ]
        if thirdPartyModelConfiguration?.eligible == true,
           let config = thirdPartyModelConfiguration?.config,
           config.enabled {
            options.append(ConversationModelOption(
                id: config.configId,
                displayName: config.displayName,
                detail: config.model
            ))
        }
        return options
    }

    let broker: FutuBrokerClient
    let longbridgeBroker: LongbridgeBrokerClient
    private var backend: BackendClient
    private let cloudEnvironment: BackendEnvironment
    private let credentials: SecureCredentialStore
    private let providerPoolCache: ProviderPoolCache
    private let defaults: UserDefaults
    private let autoSubmitPreferences: AutoSubmitPreferenceStore
    private var authenticationSession: AuthenticationSession?
    private var authenticationRefreshTask: Task<Void, Never>?
    private var startupTask: Task<Void, Never>?
    private var brokerRefreshTask: Task<Void, Never>?
    private var shadowTradingTasks: [String: Task<Void, Never>] = [:]
    private var liveTradingTasks: [String: Task<Void, Never>] = [:]
    private var startupAdServerTime: Date?
    private var brokerConnectionId: String?
    private var longbridgeBrokerConnectionId: String?
    private var activeProviderPoolCacheNamespace: String?
    private var contextSequence = 0
    private var futuSnapshotBlockedUntil: Date?
    private var liveOrderCoordinator: LiveOrderCoordinator
    private var managedOrderSupervisor: ManagedOrderSupervisor

    init(
        broker: FutuBrokerClient = FutuBrokerClient(),
        longbridgeBroker: LongbridgeBrokerClient? = nil,
        defaults: UserDefaults = .standard,
        credentials: SecureCredentialStore = SecureCredentialStore(),
        providerPoolCache: ProviderPoolCache = ProviderPoolCache(),
        cloudBaseURL: URL? = nil
    ) {
        let configuredCloud = cloudBaseURL.map {
            BackendEnvironment.cloud(baseURL: $0)
        } ?? BackendEnvironment.configuredCloud()
        #if DEBUG
        let initialEnvironment: BackendEnvironment = cloudBaseURL == nil
            ? .debugLocal
            : configuredCloud
        #else
        let initialEnvironment = configuredCloud
        #endif
        self.broker = broker
        self.longbridgeBroker = longbridgeBroker
            ?? LongbridgeBrokerClient(credentialStore: credentials)
        self.defaults = defaults
        autoSubmitPreferences = AutoSubmitPreferenceStore(defaults: defaults)
        self.credentials = credentials
        self.providerPoolCache = providerPoolCache
        cloudEnvironment = configuredCloud
        backendEnvironment = initialEnvironment
        let backendClient = BackendClient(baseURL: initialEnvironment.baseURL)
        backend = backendClient
        liveOrderCoordinator = LiveOrderCoordinator(backend: backendClient)
        managedOrderSupervisor = ManagedOrderSupervisor(backend: backendClient)

        if let raw = defaults.string(forKey: Keys.platform),
           let restored = TradingPlatform(rawValue: raw) {
            platform = restored
        }
        if let raw = defaults.string(forKey: Keys.workspace) {
            if raw == "history" {
                workspace = .strategyCenter
            } else if raw == "sellPutResearch" {
                workspace = .research
            } else if let restored = FutuWorkspace(rawValue: raw) {
                workspace = restored
            }
        }
        let width = defaults.double(forKey: Keys.conversationWidth)
        if width >= 300, width <= 560 {
            conversationWidth = width
        }
        restoreResearchModels()
        hasLongbridgeCredentials = ((try? credentials.longbridgeCredentials()) ?? nil) != nil
    }

    var currentAccount: AccountSummary? {
        platform == .longbridge ? longbridgeAccount : account
    }

    var currentPositions: [PositionSummary] {
        platform == .longbridge ? longbridgePositions : positions
    }

    var currentPositionsAvailable: Bool {
        BrokerSnapshotAvailability.positionsAvailable(
            lastUpdatedAt: currentBrokerLastUpdatedAt,
            dataGaps: currentBrokerDataGaps
        )
    }

    var currentMarket: MarketSummary? {
        platform == .longbridge ? longbridgeMarket : market
    }

    var currentQuotes: [QuoteSummary] {
        platform == .longbridge ? longbridgeQuotes : quotes
    }

    var currentMinuteBars: [CandlestickSummary] {
        platform == .longbridge ? longbridgeMinuteBars : minuteBars
    }

    var currentTickerPoints: [TickerSummary] {
        platform == .longbridge ? longbridgeTickerPoints : tickerPoints
    }

    var currentOrderBooks: [OrderBookSummary] {
        platform == .longbridge ? longbridgeOrderBooks : orderBooks
    }

    var currentOpenOrders: [BrokerOrderSummary] {
        platform == .longbridge ? longbridgeOpenOrders : openOrders
    }

    var currentRecentDeals: [BrokerFillSummary] {
        platform == .longbridge ? longbridgeRecentDeals : recentDeals
    }

    var currentHistoricalOrders: [BrokerOrderSummary] {
        platform == .longbridge ? longbridgeHistoricalOrders : historicalOrders
    }

    var currentHistoricalDeals: [BrokerFillSummary] {
        platform == .longbridge ? longbridgeHistoricalDeals : historicalDeals
    }

    var currentBrokerDataGaps: [String] {
        platform == .longbridge ? longbridgeDataGaps : brokerDataGaps
    }

    var currentBrokerLastUpdatedAt: Date? {
        platform == .longbridge ? longbridgeLastUpdatedAt : brokerLastUpdatedAt
    }

    var currentMarketIntelligence: MarketIntelligenceSnapshot? {
        platform == .futu ? marketIntelligence : MarketIntelligenceSnapshot(
            providerId: "LONGBRIDGE",
            fetchedAt: ISO8601DateFormatter().string(from: Date()),
            sections: MarketEventGroup.allCases.map {
                MarketIntelligenceSection(
                    group: $0,
                    availability: .providerUnsupported,
                    message: "Longbridge 市场情报接口尚未接入"
                )
            }
        )
    }

    var isRefreshingCurrentBroker: Bool {
        platform == .longbridge ? isRefreshingLongbridge : isRefreshingBroker
    }

    var currentConnectionLabel: String {
        platform == .longbridge
            ? longbridgeBroker.connectionState.label
            : broker.connectionState.label
    }

    var isCurrentBrokerConnected: Bool {
        if platform == .longbridge {
            return longbridgeBroker.connectionState == .connected
        }
        return broker.connectionState == .connected
    }

    var currentStatusMessage: String? {
        platform == .longbridge ? longbridgeStatusMessage : statusMessage
    }

    var currentTradingCatalog: TradingCatalog? {
        guard let connectionId = currentBrokerConnectionId else { return nil }
        return tradingCatalogs[connectionId]
    }

    var currentTradingConfiguration: TradingConfiguration? {
        guard let connectionId = currentBrokerConnectionId else { return nil }
        return tradingConfigurations[connectionId]
    }

    var currentLiveExecutionSetting: LiveExecutionSetting? {
        liveExecutionSettings[currentProviderId]
    }

    var currentPendingLiveOrders: [PendingLiveOrder] {
        guard let connectionId = currentBrokerConnectionId else { return [] }
        return liveTradingRuntimeByConnection[connectionId]?.pendingOrders ?? []
    }

    var currentPendingOrderActions: [PendingOrderAction] {
        guard let connectionId = currentBrokerConnectionId else { return [] }
        return liveTradingRuntimeByConnection[connectionId]?.orderActions ?? []
    }

    var currentLiveTradingSession: LiveTradingSession? {
        guard let connectionId = currentBrokerConnectionId else { return nil }
        return liveTradingRuntimeByConnection[connectionId]?.session
    }

    var currentTradingLease: TradingLease? {
        guard let connectionId = currentBrokerConnectionId else { return nil }
        return liveTradingRuntimeByConnection[connectionId]?.lease
    }

    var currentTradingLeaseLabel: String {
        guard let lease = currentTradingLease,
              Self.secondsRemaining(lease.expiresAt) > 0 else {
            return "未持有"
        }
        return "已持有"
    }

    var currentLiveTradingStatusMessage: String? {
        guard let connectionId = currentBrokerConnectionId else { return nil }
        return liveTradingRuntimeByConnection[connectionId]?.statusMessage
    }

    var currentLiveTradingModeLabel: String {
        guard let setting = currentLiveExecutionSetting else {
            return "真实交易状态未知"
        }
        guard setting.hardGateEnabled else { return "真实交易后台关闭" }
        if setting.autoSubmitEnabled {
            return currentLiveTradingSession == nil ? "交易会话已失效" : "实盘自动提交"
        }
        return "实盘人工确认"
    }

    var isCurrentAutoSubmitEnabled: Bool {
        if let setting = currentLiveExecutionSetting {
            return setting.autoSubmitEnabled
        }
        guard let accessToken = authenticationSession?.accessToken else {
            return false
        }
        return autoSubmitPreferences.value(
            for: autoSubmitPreferenceScope(
                accessToken: accessToken,
                provider: currentProviderId
            )
        ) ?? false
    }

    var shadowModelRuns: [ModelRunSummary] {
        currentShadowHistory.modelRuns
    }

    var shadowModelRunPage: Int {
        currentShadowHistory.modelRunPage
    }

    var shadowModelRunTotal: Int {
        currentShadowHistory.modelRunTotal
    }

    var shadowSignals: [TradingSignal] {
        currentShadowHistory.signals
    }

    var shadowCandidates: [TradingCandidate] {
        currentShadowHistory.candidates
    }

    var shadowRuntimeStatus: String {
        guard let connectionId = currentBrokerConnectionId else {
            return shadowRuntimeFallbackStatus
        }
        return shadowRuntimeByConnection[connectionId]?.status ?? "已停止"
    }

    var shadowLastRunAt: Date? {
        guard let connectionId = currentBrokerConnectionId else { return nil }
        return shadowRuntimeByConnection[connectionId]?.lastRunAt
    }

    var isShadowTradingRunning: Bool {
        guard let connectionId = currentBrokerConnectionId else { return false }
        return shadowRuntimeByConnection[connectionId]?.isRunning ?? false
    }

    var isShadowEvaluationInFlight: Bool {
        guard let connectionId = currentBrokerConnectionId else { return false }
        return shadowRuntimeByConnection[connectionId]?.isEvaluating ?? false
    }

    var shadowEvaluationItems: [ShadowEvaluationItem] {
        guard let connectionId = currentBrokerConnectionId else { return [] }
        let runtimeItems = shadowRuntimeByConnection[connectionId]?.evaluationItems ?? []
        if !runtimeItems.isEmpty { return runtimeItems }
        let provider = currentProviderId
        guard let pool = providerPools[provider],
              let market = provider == "LONGBRIDGE" ? longbridgeMarket : self.market else {
            return []
        }
        return pool.items.map { item in
            let readiness = shadowEvaluationItem(
                for: item,
                fallback: market,
                provider: provider
            )
            return ShadowEvaluationItem(
                symbol: readiness.symbol,
                market: readiness.market,
                marketState: readiness.marketState,
                state: .waiting,
                reason: "量化评估尚未启动"
            )
        }
    }

    var shadowEvaluationUpdatedAt: Date? {
        guard let connectionId = currentBrokerConnectionId else { return nil }
        return shadowRuntimeByConnection[connectionId]?.evaluationUpdatedAt
    }

    var shadowModelRunPageCount: Int {
        max(1, (shadowModelRunTotal + shadowModelRunPageSize - 1) / shadowModelRunPageSize)
    }

    var currentProviderId: String {
        platform == .longbridge ? "LONGBRIDGE" : "FUTU"
    }

    var currentSellPutResearchItems: [SellPutPoolItem] {
        sellPutPools[currentProviderId]?.items ?? []
    }

    var sellPutReport: SellPutReport? {
        sellPutReports[currentProviderId]
    }

    var sellPutReportHistory: [SellPutReportHistoryItem] {
        sellPutReportHistories[currentProviderId] ?? []
    }

    var isSellPutLoading: Bool {
        sellPutRunState(for: currentProviderId).isLoading
    }

    var isSellPutRunning: Bool {
        sellPutRunState(for: currentProviderId).isRunning
    }

    var sellPutCompletedSymbols: Int {
        sellPutRunState(for: currentProviderId).completedSymbols
    }

    var sellPutTotalSymbols: Int {
        sellPutRunState(for: currentProviderId).totalSymbols
    }

    var sellPutStatusMessage: String? {
        sellPutRunState(for: currentProviderId).statusMessage
    }

    var canStartSellPutReport: Bool {
        sellPutAccessMessage == nil && !isSellPutRunning
    }

    var sellPutAccessMessage: String? {
        if isSubscriptionLoading {
            return "正在验证套餐权益"
        }
        if currentSubscription == nil, subscriptionStatusMessage != nil {
            return "套餐权益暂不可验证，请刷新后重试"
        }
        guard let subscription = currentSubscription else {
            return "请先在套餐中心配置有效套餐"
        }
        guard subscription.isActive() else {
            return "当前套餐已失效，请先在套餐中心续费"
        }
        guard subscription.hasActiveSlot(for: currentProviderId) else {
            return "当前套餐未绑定\(platform.title)，请先在套餐中心配置"
        }
        return nil
    }

    private var currentBrokerConnectionId: String? {
        platform == .longbridge ? longbridgeBrokerConnectionId : brokerConnectionId
    }

    func start() async {
        authenticationPhase = .checking
        let environment = backendEnvironment
        let client = backend
        let storedRefreshToken: String?
        do {
            storedRefreshToken = try credentials.refreshToken(for: environment)
        } catch {
            authenticationPhase = .signedOut(message: error.localizedDescription)
            return
        }
        guard let refreshToken = storedRefreshToken, !refreshToken.isEmpty else {
            authenticationPhase = .signedOut(message: nil)
            return
        }
        do {
            let tokens = try await client.refresh(refreshToken: refreshToken)
            guard environment == backendEnvironment else { return }
            try credentials.saveRefreshToken(tokens.refreshToken, for: environment)
            await acceptAuthenticatedSession(tokens, environment: environment)
        } catch {
            guard environment == backendEnvironment else { return }
            invalidateAuthentication(message: "登录状态已失效，请重新登录")
        }
    }

    func login(username: String, password: String) async {
        let normalizedUsername = username.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedUsername.isEmpty,
              !password.isEmpty else {
            authenticationPhase = .signedOut(message: "请输入用户名和密码")
            return
        }
        isAuthenticating = true
        defer { isAuthenticating = false }
        let environment = backendEnvironment
        let client = backend
        do {
            let identity = try credentials.deviceIdentity(
                for: environment,
                username: normalizedUsername
            )
            let tokens = try await client.login(DesktopLoginRequest(
                username: normalizedUsername,
                password: password,
                deviceId: identity.deviceId,
                deviceFingerprint: identity.fingerprint,
                displayName: identity.displayName,
                platform: "MACOS",
                appVersion: "0.1.0",
                publicKey: identity.publicKeyPEM
            ))
            guard environment == backendEnvironment else { return }
            try credentials.activateDeviceIdentity(
                tokens.deviceId ?? identity.deviceId,
                for: environment
            )
            try credentials.saveRefreshToken(tokens.refreshToken, for: environment)
            await acceptAuthenticatedSession(tokens, environment: environment)
        } catch {
            guard environment == backendEnvironment else { return }
            invalidateAuthentication(message: error.localizedDescription)
        }
    }

    func logout() async {
        let environment = backendEnvironment
        let client = backend
        await shutdownLiveTradingRuntime(reason: "用户已退出登录")
        let refreshToken = try? credentials.refreshToken(for: environment)
        if let refreshToken, !refreshToken.isEmpty {
            await client.logout(refreshToken: refreshToken)
        }
        invalidateAuthentication(message: nil)
    }

    func changePassword(nextPassword: String) async {
        guard let accessToken = authenticationSession?.accessToken else {
            invalidateAuthentication(message: "登录状态已失效，请重新登录")
            return
        }
        guard nextPassword.count >= 12,
              nextPassword.rangeOfCharacter(from: .letters) != nil,
              nextPassword.rangeOfCharacter(from: .decimalDigits) != nil else {
            authenticationPhase = .passwordChangeRequired(
                message: "新密码至少 12 位，并同时包含字母和数字"
            )
            return
        }
        isChangingPassword = true
        defer { isChangingPassword = false }
        do {
            try await backend.changePassword(
                nextPassword: nextPassword,
                accessToken: accessToken
            )
            invalidateAuthentication(message: "密码修改成功，请使用新密码重新登录")
        } catch {
            authenticationPhase = .passwordChangeRequired(message: error.localizedDescription)
        }
    }

    func enableDebugMode() async {
        await switchBackendEnvironment(to: .debugLocal)
    }

    func disableDebugMode() async {
        guard case .cloud = backendEnvironment else {
            await switchBackendEnvironment(to: cloudEnvironment)
            return
        }
    }

    private func switchBackendEnvironment(to environment: BackendEnvironment) async {
        guard environment != backendEnvironment, !isSwitchingBackendEnvironment else { return }
        isSwitchingBackendEnvironment = true
        defer { isSwitchingBackendEnvironment = false }

        let sourceEnvironment = backendEnvironment
        let sourceBackend = backend
        await shutdownLiveTradingRuntime(reason: "后台环境已切换")
        cancelRuntimeTasks()
        let sourceRefreshToken = (try? credentials.refreshToken(for: sourceEnvironment)) ?? nil
        if let refreshToken = sourceRefreshToken, !refreshToken.isEmpty {
            await sourceBackend.logout(refreshToken: refreshToken)
        }
        await sourceBackend.cancelAllRequests()
        invalidateAuthentication(message: nil)

        backendEnvironment = environment
        let backendClient = BackendClient(baseURL: environment.baseURL)
        backend = backendClient
        liveOrderCoordinator = LiveOrderCoordinator(backend: backendClient)
        managedOrderSupervisor = ManagedOrderSupervisor(backend: backendClient)
        guard environment.isDebug else {
            authenticationPhase = .signedOut(message: nil)
            return
        }
        do {
            _ = try await backend.readiness()
            authenticationPhase = .signedOut(message: nil)
        } catch {
            authenticationPhase = .signedOut(
                message: "本地后台未就绪，请启动 Gateway、Worker 与 PostgreSQL"
            )
        }
    }

    func shutdownLiveTradingRuntime(reason: String) async {
        liveTradingTasks.values.forEach { $0.cancel() }
        liveTradingTasks = [:]
        guard let accessToken = authenticationSession?.accessToken else { return }
        for (connectionId, runtime) in liveTradingRuntimeByConnection {
            if let session = runtime.session {
                _ = try? await backend.deactivateLiveTradingSession(
                    sessionId: session.sessionId,
                    accessToken: accessToken
                )
            }
            var updated = runtime
            updated.session = nil
            updated.statusMessage = reason
            liveTradingRuntimeByConnection[connectionId] = updated
        }
    }

    func resumeLiveTradingRuntime() async {
        guard authenticationPhase == .signedIn,
              let accessToken = authenticationSession?.accessToken else { return }
        if let brokerConnectionId {
            await refreshLiveTradingState(
                connectionId: brokerConnectionId,
                provider: "FUTU",
                accessToken: accessToken
            )
            startLiveTradingSupervisor(connectionId: brokerConnectionId, provider: "FUTU")
        }
        if let longbridgeBrokerConnectionId {
            await refreshLiveTradingState(
                connectionId: longbridgeBrokerConnectionId,
                provider: "LONGBRIDGE",
                accessToken: accessToken
            )
            startLiveTradingSupervisor(
                connectionId: longbridgeBrokerConnectionId,
                provider: "LONGBRIDGE"
            )
        }
    }

    private func acceptAuthenticatedSession(
        _ tokens: TokenPair,
        environment: BackendEnvironment
    ) async {
        guard environment == backendEnvironment else { return }
        authenticationSession = tokens.session
        if tokens.mustChangePassword == true {
            authenticationPhase = .passwordChangeRequired(message: nil)
            scheduleAuthenticationRefresh()
            return
        }
        authenticationPhase = .signedIn
        scheduleAuthenticationRefresh()
        await startAuthenticatedServices()
    }

    private func scheduleAuthenticationRefresh() {
        authenticationRefreshTask?.cancel()
        guard let session = authenticationSession else { return }
        let delay = max(1, session.accessExpiresAt.timeIntervalSinceNow - 60)
        authenticationRefreshTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self else { return }
            await self.refreshAuthentication()
        }
    }

    private func refreshAuthentication() async {
        let environment = backendEnvironment
        let client = backend
        do {
            guard let refreshToken = try credentials.refreshToken(for: environment),
                  !refreshToken.isEmpty else {
                invalidateAuthentication(message: "登录状态已失效，请重新登录")
                return
            }
            let tokens = try await client.refresh(refreshToken: refreshToken)
            guard environment == backendEnvironment else { return }
            try credentials.saveRefreshToken(tokens.refreshToken, for: environment)
            authenticationSession = tokens.session
            scheduleAuthenticationRefresh()
        } catch {
            guard environment == backendEnvironment else { return }
            invalidateAuthentication(message: "登录状态已失效，请重新登录")
        }
    }

    private func cancelRuntimeTasks() {
        authenticationRefreshTask?.cancel()
        authenticationRefreshTask = nil
        startupTask?.cancel()
        startupTask = nil
        brokerRefreshTask?.cancel()
        brokerRefreshTask = nil
        shadowTradingTasks.values.forEach { $0.cancel() }
        shadowTradingTasks = [:]
        liveTradingTasks.values.forEach { $0.cancel() }
        liveTradingTasks = [:]
    }

    private func invalidateAuthentication(message: String?) {
        cancelRuntimeTasks()
        try? credentials.clearRefreshToken(for: backendEnvironment)
        startupAd = nil
        authenticationSession = nil
        isAuthenticating = false
        isChangingPassword = false
        isTradingCriticalFlowActive = false
        isSendingMessage = false
        statusMessage = nil
        if let namespace = activeProviderPoolCacheNamespace {
            Task { await providerPoolCache.remove(namespace: namespace) }
        }
        activeProviderPoolCacheNamespace = nil
        account = nil
        positions = []
        market = nil
        quotes = []
        minuteBars = []
        tickerPoints = []
        orderBooks = []
        openOrders = []
        recentDeals = []
        historicalOrders = []
        historicalDeals = []
        brokerDataGaps = []
        isRefreshingBroker = false
        brokerLastUpdatedAt = nil
        futuSnapshotBlockedUntil = nil
        marketIntelligence = nil
        isRefreshingMarketIntelligence = false
        marketIntelligenceStatusMessage = nil
        longbridgeAccount = nil
        longbridgePositions = []
        longbridgeMarket = nil
        longbridgeQuotes = []
        longbridgeMinuteBars = []
        longbridgeTickerPoints = []
        longbridgeOrderBooks = []
        longbridgeOpenOrders = []
        longbridgeRecentDeals = []
        longbridgeHistoricalOrders = []
        longbridgeHistoricalDeals = []
        longbridgeDataGaps = []
        isRefreshingLongbridge = false
        longbridgeLastUpdatedAt = nil
        longbridgeStatusMessage = nil
        subscriptionCatalog = nil
        currentSubscription = nil
        currentSubscriptionOrder = nil
        isSubscriptionLoading = false
        subscriptionStatusMessage = nil
        thirdPartyModelConfiguration = nil
        isThirdPartyModelLoading = false
        thirdPartyModelStatusMessage = nil
        selectedConversationModelRoute = ModelRoute.official
        providerPoolSummaries = []
        providerPools = [:]
        providerPoolOnlineValidated = false
        isProviderPoolLoading = false
        providerPoolStatusMessage = nil
        instrumentSearchResults = []
        instrumentSearchFetchedAt = nil
        optionExpiries = []
        optionContracts = []
        optionChainFetchedAt = nil
        isInstrumentDiscoveryLoading = false
        sellPutReports = [:]
        sellPutReportHistories = [:]
        sellPutPools = [:]
        sellPutRunStates = [:]
        brokerConnectionId = nil
        longbridgeBrokerConnectionId = nil
        serverResearchPool = nil
        tradingCatalogs = [:]
        tradingConfigurations = [:]
        liveExecutionSettings = [:]
        liveTradingRuntimeByConnection = [:]
        shadowHistoryByConnection = [:]
        shadowRuntimeByConnection = [:]
        shadowRuntimeFallbackStatus = "已停止"
        conversationMessages = []
        researchPoolEntitlement = .unavailable
        researchPool = []
        conversationResearchSymbols = []
        broker.disconnect()
        longbridgeBroker.disconnect()
        authenticationPhase = .signedOut(message: message)
    }

    private func startAuthenticatedServices() async {
        await refreshSubscriptionCenter()
        await refreshLiveExecutionSettings()
        async let pools: Void = refreshProviderPools()
        if sellPutAccessMessage == nil {
            async let sellPut: Void = refreshSellPutResearch()
            _ = await (pools, sellPut)
        } else {
            await pools
        }
        await refreshCurrentBrokerData()
        scheduleBrokerRefresh()
        await loadStartupAdIfNeeded()
    }

    func refreshSubscriptionCenter() async {
        guard let accessToken = authenticationSession?.accessToken,
              !isSubscriptionLoading else { return }
        isSubscriptionLoading = true
        defer { isSubscriptionLoading = false }
        do {
            async let catalog = backend.subscriptionCatalog(accessToken: accessToken)
            async let subscription = backend.currentSubscription(accessToken: accessToken)
            subscriptionCatalog = try await catalog
            currentSubscription = try await subscription
            syncActiveResearchPool()
            subscriptionStatusMessage = nil
        } catch {
            currentSubscription = nil
            subscriptionStatusMessage = error.localizedDescription
        }
        await refreshThirdPartyModelConfiguration()
    }

    func refreshThirdPartyModelConfiguration() async {
        guard let accessToken = authenticationSession?.accessToken,
              !isThirdPartyModelLoading else { return }
        isThirdPartyModelLoading = true
        defer { isThirdPartyModelLoading = false }
        do {
            thirdPartyModelConfiguration = try await backend.thirdPartyModelConfiguration(
                accessToken: accessToken
            )
            synchronizeConversationModelRoute()
            thirdPartyModelStatusMessage = nil
        } catch {
            thirdPartyModelStatusMessage = error.localizedDescription
        }
    }

    private func synchronizeConversationModelRoute() {
        guard conversationModelOptions.contains(where: {
            $0.id == selectedConversationModelRoute
        }) else {
            selectedConversationModelRoute = ModelRoute.official
            return
        }
    }

    func saveThirdPartyModelConfiguration(
        displayName: String,
        protocol: ModelProviderProtocol,
        endpoint: String,
        model: String,
        apiKey: String?,
        enabled: Bool
    ) async -> Bool {
        guard let accessToken = authenticationSession?.accessToken,
              !isThirdPartyModelLoading else { return false }
        isThirdPartyModelLoading = true
        defer { isThirdPartyModelLoading = false }
        do {
            thirdPartyModelConfiguration = try await backend.saveThirdPartyModelConfiguration(
                SaveThirdPartyModelConfigurationRequest(
                    displayName: displayName,
                    protocol: `protocol`,
                    endpoint: endpoint,
                    model: model,
                    apiKey: apiKey,
                    enabled: enabled
                ),
                accessToken: accessToken
            )
            synchronizeConversationModelRoute()
            thirdPartyModelStatusMessage = "第三方模型配置已保存"
            return true
        } catch {
            thirdPartyModelStatusMessage = error.localizedDescription
            return false
        }
    }

    func deleteThirdPartyModelConfiguration() async -> Bool {
        guard let accessToken = authenticationSession?.accessToken,
              !isThirdPartyModelLoading else { return false }
        isThirdPartyModelLoading = true
        defer { isThirdPartyModelLoading = false }
        do {
            thirdPartyModelConfiguration = try await backend
                .deleteThirdPartyModelConfiguration(accessToken: accessToken)
            synchronizeConversationModelRoute()
            thirdPartyModelStatusMessage = "第三方模型配置已删除"
            return true
        } catch {
            thirdPartyModelStatusMessage = error.localizedDescription
            return false
        }
    }

    func submitSubscriptionPlan(
        plan: SubscriptionPlan,
        billingPeriod: SubscriptionBillingPeriod,
        providerIds: [String]
    ) async {
        guard let accessToken = authenticationSession?.accessToken,
              !isSubscriptionLoading else { return }
        guard !providerIds.isEmpty, providerIds.count <= plan.brokerSlotLimit else {
            subscriptionStatusMessage = "请选择 1 至 \(plan.brokerSlotLimit) 个券商"
            return
        }
        guard let orderType = subscriptionOrderType(for: plan, billingPeriod: billingPeriod) else {
            subscriptionStatusMessage = "该变更需预约在当前周期结束时生效"
            return
        }
        isSubscriptionLoading = true
        defer { isSubscriptionLoading = false }
        do {
            currentSubscriptionOrder = try await backend.createSubscriptionOrder(
                CreateSubscriptionOrderRequest(
                    orderType: orderType,
                    planVersionId: plan.planVersionId,
                    billingPeriod: billingPeriod,
                    providerSelections: providerIds.enumerated().map {
                        SubscriptionProviderSelection(
                            slotOrdinal: $0.offset + 1,
                            providerId: $0.element
                        )
                    }
                ),
                accessToken: accessToken
            )
            subscriptionStatusMessage = "订单已创建，请选择可用支付方式"
        } catch {
            subscriptionStatusMessage = error.localizedDescription
        }
    }

    func startSubscriptionPayment(channel: SubscriptionPaymentChannel) async {
        guard let accessToken = authenticationSession?.accessToken,
              let orderId = currentSubscriptionOrder?.orderId,
              !isSubscriptionLoading else { return }
        isSubscriptionLoading = true
        defer { isSubscriptionLoading = false }
        do {
            currentSubscriptionOrder = try await backend.startSubscriptionPayment(
                orderId: orderId,
                channel: channel,
                accessToken: accessToken
            )
            subscriptionStatusMessage = "支付请求已创建，权益以服务端支付回调为准"
        } catch {
            subscriptionStatusMessage = error.localizedDescription
        }
    }

    func refreshSubscriptionOrder() async {
        guard let accessToken = authenticationSession?.accessToken,
              let orderId = currentSubscriptionOrder?.orderId,
              !isSubscriptionLoading else { return }
        isSubscriptionLoading = true
        var shouldRefreshPools = false
        do {
            let order = try await backend.subscriptionOrder(
                orderId: orderId,
                accessToken: accessToken
            )
            currentSubscriptionOrder = order
            if order.status == "PAID" {
                currentSubscription = try await backend.currentSubscription(
                    accessToken: accessToken
                )
                syncActiveResearchPool()
                subscriptionStatusMessage = "支付已确认，套餐权益已更新"
                shouldRefreshPools = true
            } else {
                subscriptionStatusMessage = "订单状态：\(order.status)"
            }
        } catch {
            subscriptionStatusMessage = error.localizedDescription
        }
        isSubscriptionLoading = false
        if shouldRefreshPools {
            await refreshThirdPartyModelConfiguration()
            await refreshProviderPools(force: true)
        }
    }

    func scheduleSubscriptionChange(
        plan: SubscriptionPlan,
        billingPeriod: SubscriptionBillingPeriod,
        retainedProviderIds: [String]
    ) async {
        guard let accessToken = authenticationSession?.accessToken,
              let subscription = currentSubscription,
              !isSubscriptionLoading else { return }
        guard !retainedProviderIds.isEmpty,
              retainedProviderIds.count <= plan.brokerSlotLimit else {
            subscriptionStatusMessage = "请选择 1 至 \(plan.brokerSlotLimit) 个保留券商"
            return
        }
        isSubscriptionLoading = true
        defer { isSubscriptionLoading = false }
        do {
            currentSubscription = try await backend.scheduleSubscriptionChange(
                ScheduleSubscriptionChangeRequest(
                    planVersionId: plan.planVersionId,
                    billingPeriod: billingPeriod,
                    retainedProviderIds: retainedProviderIds,
                    expectedVersion: subscription.version
                ),
                accessToken: accessToken
            )
            subscriptionStatusMessage = "套餐变更已预约，将在当前周期结束时生效"
        } catch {
            subscriptionStatusMessage = error.localizedDescription
        }
    }

    func bindSubscriptionBrokerSlot(
        slot: SubscriptionBrokerSlot,
        providerId: String
    ) async {
        guard let accessToken = authenticationSession?.accessToken,
              !isSubscriptionLoading else { return }
        isSubscriptionLoading = true
        var didBind = false
        do {
            currentSubscription = try await backend.bindSubscriptionBrokerSlot(
                slotId: slot.slotId,
                providerId: providerId,
                expectedVersion: slot.version,
                accessToken: accessToken
            )
            subscriptionStatusMessage = "券商槽位已更新；原券商标的池按规则冻结"
            didBind = true
        } catch {
            subscriptionStatusMessage = error.localizedDescription
        }
        isSubscriptionLoading = false
        if didBind {
            await refreshProviderPools(force: true)
        }
    }

    func subscriptionOrderType(
        for plan: SubscriptionPlan,
        billingPeriod: SubscriptionBillingPeriod
    ) -> SubscriptionOrderType? {
        guard let subscription = currentSubscription,
              subscription.status == "ACTIVE" else {
            return .new
        }
        let currentRank = subscriptionPlanRank(subscription.planCode)
        let targetRank = subscriptionPlanRank(plan.planCode)
        if targetRank > currentRank {
            return .upgrade
        }
        if targetRank == currentRank, billingPeriod == subscription.billingPeriod {
            return .renew
        }
        return nil
    }

    private func subscriptionPlanRank(_ code: SubscriptionPlanCode) -> Int {
        switch code {
        case .lite: 1
        case .pro: 2
        case .flagship: 3
        }
    }

    func refreshProviderPools(force: Bool = false) async {
        guard let accessToken = authenticationSession?.accessToken,
              !isProviderPoolLoading else { return }
        isProviderPoolLoading = true
        defer { isProviderPoolLoading = false }

        let namespace = providerPoolCacheNamespace(accessToken: accessToken)
        activeProviderPoolCacheNamespace = namespace
        let cached = await providerPoolCache.load(namespace: namespace)
        if let cached, providerPools.isEmpty {
            providerPoolOnlineValidated = false
            providerPoolSummaries = cached.summaries
            providerPools = cached.pools
            syncActiveResearchPool()
        }

        do {
            let listResult = try await backend.providerPoolSummaries(
                ifNoneMatch: force ? nil : cached?.listETag,
                accessToken: accessToken
            )
            if listResult.notModified, let cached {
                providerPoolOnlineValidated = true
                providerPoolSummaries = cached.summaries
                providerPools = cached.pools
                providerPoolStatusMessage = nil
                syncActiveResearchPool()
                return
            }

            let summaries = listResult.items ?? []
            var pools: [String: ProviderPool] = [:]
            var etags: [String: String] = [:]
            for summary in summaries {
                let previousETag = force ? nil : cached?.poolETags[summary.providerId]
                let firstPage = try await backend.providerPoolPage(
                    providerId: summary.providerId,
                    cursor: nil,
                    ifNoneMatch: previousETag,
                    accessToken: accessToken
                )
                if firstPage.notModified,
                   let cachedPool = cached?.pools[summary.providerId] {
                    pools[summary.providerId] = cachedPool
                    if let etag = firstPage.etag {
                        etags[summary.providerId] = etag
                    }
                    continue
                }
                guard var pool = firstPage.pool else { continue }
                if let etag = firstPage.etag {
                    etags[summary.providerId] = etag
                }
                while let cursor = pool.nextCursor {
                    let next = try await backend.providerPoolPage(
                        providerId: summary.providerId,
                        cursor: cursor,
                        ifNoneMatch: nil,
                        accessToken: accessToken
                    )
                    guard let page = next.pool else { break }
                    pool = pool.appending(page)
                }
                pools[summary.providerId] = pool
            }

            providerPoolSummaries = summaries
            providerPools = pools
            providerPoolOnlineValidated = true
            providerPoolStatusMessage = nil
            syncActiveResearchPool()
            try await providerPoolCache.save(
                ProviderPoolCacheSnapshot(
                    listETag: listResult.etag,
                    summaries: summaries,
                    poolETags: etags,
                    pools: pools
                ),
                namespace: namespace
            )
        } catch {
            providerPoolOnlineValidated = false
            syncActiveResearchPool()
            providerPoolStatusMessage = error.localizedDescription
        }
    }

    func searchProviderInstruments(
        providerId: String,
        query: String,
        markets: [BrokerMarket],
        instrumentTypes: [BrokerInstrumentType]
    ) async {
        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty, !isInstrumentDiscoveryLoading else { return }
        instrumentSearchResults = []
        instrumentSearchFetchedAt = nil
        optionExpiries = []
        optionContracts = []
        providerPoolStatusMessage = nil
        isInstrumentDiscoveryLoading = true
        defer { isInstrumentDiscoveryLoading = false }
        do {
            let response = try await discoveryClient(providerId: providerId).searchInstruments(
                BrokerInstrumentSearchRequest(
                    query: normalized,
                    markets: markets,
                    instrumentTypes: instrumentTypes
                )
            )
            instrumentSearchResults = response.results
            instrumentSearchFetchedAt = response.fetchedAt
            providerPoolStatusMessage = response.results.isEmpty ? "未找到匹配标的" : nil
        } catch {
            instrumentSearchResults = []
            instrumentSearchFetchedAt = nil
            providerPoolStatusMessage = error.localizedDescription
        }
    }

    func loadProviderOptionExpiries(
        providerId: String,
        underlyingSymbol: String
    ) async {
        guard !isInstrumentDiscoveryLoading else { return }
        isInstrumentDiscoveryLoading = true
        defer { isInstrumentDiscoveryLoading = false }
        do {
            let response = try await discoveryClient(providerId: providerId)
                .optionExpiries(for: underlyingSymbol)
            optionExpiries = response.expiries
            optionContracts = []
            providerPoolStatusMessage = response.expiries.isEmpty ? "没有可用期权到期日" : nil
        } catch {
            providerPoolStatusMessage = error.localizedDescription
        }
    }

    func loadProviderOptionChain(
        providerId: String,
        underlyingSymbol: String,
        expiryDate: String
    ) async {
        guard !isInstrumentDiscoveryLoading else { return }
        isInstrumentDiscoveryLoading = true
        defer { isInstrumentDiscoveryLoading = false }
        do {
            let response = try await discoveryClient(providerId: providerId)
                .optionChain(for: underlyingSymbol, expiryDate: expiryDate)
            optionContracts = response.contracts
            optionChainFetchedAt = response.fetchedAt
            providerPoolStatusMessage = response.contracts.isEmpty ? "该到期日没有期权合约" : nil
        } catch {
            providerPoolStatusMessage = error.localizedDescription
        }
    }

    func addProviderPoolInstrument(
        providerId: String,
        instrument: BrokerInstrument
    ) async {
        guard let fetchedAt = instrumentSearchFetchedAt else {
            providerPoolStatusMessage = "搜索结果缺少来源校验时间，请重新搜索"
            return
        }
        await addProviderPoolItem(
            providerId: providerId,
            request: AddProviderPoolItemRequest(
                instrument: instrument,
                sourceVerifiedAt: fetchedAt
            )
        )
    }

    func addProviderPoolOption(
        providerId: String,
        contract: BrokerOptionContract
    ) async {
        guard let fetchedAt = optionChainFetchedAt else {
            providerPoolStatusMessage = "期权链缺少来源校验时间，请重新加载"
            return
        }
        await addProviderPoolItem(
            providerId: providerId,
            request: AddProviderPoolItemRequest(
                contract: contract,
                sourceVerifiedAt: fetchedAt
            )
        )
    }

    func removeProviderPoolItem(providerId: String, itemId: String) async {
        guard let accessToken = authenticationSession?.accessToken,
              providerPoolOnlineValidated,
              !isProviderPoolLoading else { return }
        isProviderPoolLoading = true
        do {
            _ = try await backend.removeProviderPoolItem(
                providerId: providerId,
                itemId: itemId,
                accessToken: accessToken
            )
            providerPoolStatusMessage = "标的已移除，已计入本期替换额度"
        } catch {
            isProviderPoolLoading = false
            providerPoolStatusMessage = error.localizedDescription
            return
        }
        isProviderPoolLoading = false
        await refreshProviderPools(force: true)
    }

    func refreshSellPutResearch() async {
        guard let accessToken = authenticationSession?.accessToken else { return }
        let providerId = currentProviderId
        guard sellPutAccessMessage == nil else {
            updateSellPutRunState(providerId) { $0.statusMessage = nil }
            return
        }
        guard !sellPutRunState(for: providerId).isLoading else { return }
        updateSellPutRunState(providerId) { $0.isLoading = true }
        defer {
            updateSellPutRunState(providerId) { $0.isLoading = false }
        }
        do {
            async let pool = backend.sellPutPool(
                providerId: providerId,
                accessToken: accessToken
            )
            async let latest = backend.latestSellPutReport(
                providerId: providerId,
                accessToken: accessToken
            )
            async let history = backend.sellPutReportHistory(
                providerId: providerId,
                accessToken: accessToken
            )
            let (loadedPool, loadedLatest, loadedHistory) = try await (pool, latest, history)
            sellPutPools[providerId] = loadedPool
            sellPutReports[providerId] = loadedLatest
            sellPutReportHistories[providerId] = loadedHistory.items
            if !sellPutRunState(for: providerId).isRunning {
                updateSellPutRunState(providerId) { $0.statusMessage = nil }
            }
        } catch {
            if !sellPutRunState(for: providerId).isRunning {
                updateSellPutRunState(providerId) {
                    $0.statusMessage = error.localizedDescription
                }
            }
        }
    }

    func startSellPutReport() async -> Bool {
        let providerId = currentProviderId
        guard let accessToken = authenticationSession?.accessToken,
              !sellPutRunState(for: providerId).isRunning else { return false }
        guard let subscription = currentSubscription,
              subscription.grantsResearchAccess(to: providerId) else {
            updateSellPutRunState(providerId) {
                $0.statusMessage = sellPutAccessMessage
                    ?? "请先在套餐中心配置有效套餐"
            }
            return false
        }
        updateSellPutRunState(providerId) {
            $0.isRunning = true
            $0.completedSymbols = 0
            $0.totalSymbols = 0
            $0.statusMessage = "正在同步当日全球市值 Top30 专属标的池"
        }
        defer {
            updateSellPutRunState(providerId) { $0.isRunning = false }
        }
        let pool: SellPutPool
        do {
            pool = try await backend.syncSellPutTopThirtyPool(
                providerId: providerId,
                accessToken: accessToken
            )
            sellPutPools[providerId] = pool
            if pool.universe?.fallback == true {
                updateSellPutRunState(providerId) {
                    $0.statusMessage = "当日 Top30 排名源不可用，已停止报告，避免使用过期标的池"
                }
                return false
            }
        } catch {
            updateSellPutRunState(providerId) {
                $0.statusMessage = error.localizedDescription
            }
            return false
        }
        let items = pool.items
        if providerId == "LONGBRIDGE" {
            updateSellPutRunState(providerId) {
                $0.statusMessage = "正在检查 Longbridge 美股与期权行情权限"
            }
            do {
                try await validateLongbridgeSellPutAccess(items)
            } catch {
                updateSellPutRunState(providerId) {
                    $0.statusMessage = Self.longbridgeSellPutPreflightMessage(for: error)
                }
                return false
            }
        }
        updateSellPutRunState(providerId) {
            $0.completedSymbols = 0
            $0.totalSymbols = items.count
            $0.statusMessage = providerId == "FUTU"
                ? "正在按 OpenD 频率限制并发采集 \(items.count) 个独立标的"
                : "正在按 Longbridge 频率限制分批采集 \(items.count) 个独立标的"
        }
        var observations: [SellPutObservation] = []
        let batchSize = providerId == "FUTU" ? 8 : 5
        for batchStart in stride(from: 0, to: items.count, by: batchSize) {
            let batchEnd = min(batchStart + batchSize, items.count)
            let batch = Array(items[batchStart..<batchEnd])
            updateSellPutRunState(providerId) {
                $0.statusMessage =
                    "正在采集 \(batchStart + 1)-\(batchEnd)/\(items.count)"
            }
            let batchObservations = await withTaskGroup(
                of: SellPutObservation.self,
                returning: [SellPutObservation].self
            ) { group in
                for item in batch {
                    group.addTask { [self] in
                        await self.collectSellPutObservation(
                            item,
                            providerId: providerId
                        )
                    }
                }
                var collected: [SellPutObservation] = []
                for await observation in group {
                    collected.append(observation)
                    updateSellPutRunState(providerId) {
                        $0.completedSymbols = observations.count + collected.count
                    }
                }
                return collected
            }
            observations.append(contentsOf: batchObservations)
            if batchEnd < items.count {
                let source = providerId == "FUTU" ? "OpenD" : "Longbridge"
                updateSellPutRunState(providerId) {
                    $0.statusMessage =
                        "已采集 \(observations.count)/\(items.count)，等待 \(source) 频率窗口"
                }
                do {
                    try await Task.sleep(for: .seconds(31))
                } catch {
                    updateSellPutRunState(providerId) {
                        $0.statusMessage = "SELL PUT 研究已取消"
                    }
                    return false
                }
            }
        }
        observations.sort { $0.symbol < $1.symbol }
        updateSellPutRunState(providerId) {
            $0.completedSymbols = observations.count
            $0.statusMessage =
                "已采集 \(observations.count)/\(items.count)，正在生成报告"
        }

        do {
            let report = try await backend.createSellPutReport(
                CreateSellPutReportRequest(
                    providerId: providerId,
                    poolVersion: pool.version,
                    observations: observations
                ),
                accessToken: accessToken
            )
            guard report.providerId == providerId else {
                throw AppInteractionError.providerReportMismatch
            }
            sellPutReports[providerId] = report
            if let history = try? await backend.sellPutReportHistory(
                providerId: providerId,
                accessToken: accessToken
            ) {
                sellPutReportHistories[providerId] = history.items
            }
            updateSellPutRunState(providerId) {
                $0.statusMessage = report.dataQuality.isUsableForAnalysis
                    ? "30 日报告已完成并落库"
                    : "报告已落库，但完整期权数据不足，未生成候选"
            }
            return true
        } catch {
            updateSellPutRunState(providerId) {
                $0.statusMessage = error.localizedDescription
            }
            return false
        }
    }

    func loadSellPutReport(_ runId: String) async {
        guard let accessToken = authenticationSession?.accessToken else { return }
        let providerId = currentProviderId
        guard !sellPutRunState(for: providerId).isLoading else { return }
        updateSellPutRunState(providerId) { $0.isLoading = true }
        defer {
            updateSellPutRunState(providerId) { $0.isLoading = false }
        }
        do {
            let report = try await backend.sellPutReport(
                runId: runId,
                providerId: providerId,
                accessToken: accessToken
            )
            guard report.providerId == providerId else {
                throw AppInteractionError.providerReportMismatch
            }
            sellPutReports[providerId] = report
            updateSellPutRunState(providerId) { $0.statusMessage = nil }
        } catch {
            updateSellPutRunState(providerId) {
                $0.statusMessage = error.localizedDescription
            }
        }
    }

    private func sellPutRunState(for providerId: String) -> SellPutRunState {
        sellPutRunStates[providerId] ?? SellPutRunState()
    }

    private func updateSellPutRunState(
        _ providerId: String,
        _ update: (inout SellPutRunState) -> Void
    ) {
        var state = sellPutRunState(for: providerId)
        update(&state)
        sellPutRunStates[providerId] = state
    }

    private func validateLongbridgeSellPutAccess(
        _ items: [SellPutPoolItem]
    ) async throws {
        guard !items.isEmpty else {
            throw AppInteractionError.longbridgeSellPutDataUnavailable("Top30 标的池为空")
        }
        var lastError: Error?
        for item in items.prefix(3) {
            let client = LongbridgeBrokerClient(credentialStore: credentials)
            for attempt in 0..<3 {
                do {
                    try await validateLongbridgeSellPutAccess(item, client: client)
                    return
                } catch {
                    lastError = error
                    if Self.isLongbridgeQuotePermissionError(error) {
                        throw error
                    }
                    guard attempt < 2, Self.isTransientBrokerError(error) else { break }
                    try? await Task.sleep(for: .seconds(2 * (attempt + 1)))
                }
            }
        }
        throw lastError
            ?? AppInteractionError.longbridgeSellPutDataUnavailable("未知行情错误")
    }

    private func validateLongbridgeSellPutAccess(
        _ item: SellPutPoolItem,
        client: LongbridgeBrokerClient
    ) async throws {
        let underlying = try await client.sellPutUnderlyingSnapshot(symbol: item.symbol)
        guard underlying.currentPrice != nil else {
            throw AppInteractionError.longbridgeSellPutDataUnavailable(
                "当前账号无法取得美股正股现价"
            )
        }
        let expiries = try await client.optionExpiries(for: item.symbol)
        guard let expiry = preferredSellPutExpiry(expiries.expiries) else {
            throw AppInteractionError.longbridgeSellPutDataUnavailable(
                "当前账号无法取得 20 至 45 天美股期权到期日"
            )
        }
        let chain = try await client.optionChain(
            for: item.symbol,
            expiryDate: expiry.expiryDate
        )
        let puts = chain.contracts.filter { $0.optionType == .put && $0.addable }
        guard !puts.isEmpty else {
            throw AppInteractionError.longbridgeSellPutDataUnavailable(
                "当前账号无法取得目标到期日 PUT 期权链"
            )
        }
        let quotes = try await client.sellPutOptionQuotes(
            symbols: puts.prefix(5).map(\.providerSymbol)
        )
        guard !quotes.quotes.isEmpty else {
            throw AppInteractionError.longbridgeSellPutDataUnavailable(
                "当前账号无法取得美股期权实时快照"
            )
        }
    }

    private static func longbridgeSellPutPreflightMessage(for error: Error) -> String {
        let message = error.localizedDescription
        if isLongbridgeQuotePermissionError(error) {
            return "Longbridge SELL PUT 已停止：当前 OpenAPI 账号缺少美股或美股期权行情权限"
                + "（301604），本次未创建报告。请为当前 App Key 开通对应行情权限后重试。"
        }
        if message.contains("301607")
            || message.lowercased().contains("request too many symbols") {
            return "Longbridge SELL PUT 已停止：期权链请求代码数超限（301607），"
                + "本次未创建报告。"
        }
        if isTransientBrokerError(error) {
            return "Longbridge SELL PUT 已停止：OpenAPI 连续返回 HTTP 500，"
                + "重试后仍不可用，本次未创建报告，请稍后重试。"
        }
        return "\(message)，本次未创建报告。"
    }

    private static func isLongbridgeQuotePermissionError(_ error: Error) -> Bool {
        let message = error.localizedDescription.lowercased()
        return message.contains("301604") || message.contains("no quote access")
    }

    private func collectSellPutObservation(
        _ item: SellPutPoolItem,
        providerId: String,
        requestId: String = UUID().uuidString.lowercased(),
        rateLimitRetry: Int = 0,
        deadline: Date? = nil
    ) async -> SellPutObservation {
        let capturedAt = ISO8601DateFormatter().string(from: Date())
        let collectionDeadline = deadline ?? Date().addingTimeInterval(180)
        guard !Task.isCancelled, Date() < collectionDeadline else {
            return Self.unavailableSellPutObservation(
                item,
                requestId: requestId,
                capturedAt: capturedAt,
                reason: Task.isCancelled ? "采集任务已取消" : "单标的采集超过 180 秒"
            )
        }
        do {
            let client: BrokerInstrumentDiscoveryClient
            if providerId == "LONGBRIDGE" {
                let broker = LongbridgeBrokerClient(credentialStore: credentials)
                client = broker
            } else {
                let broker = FutuBrokerClient()
                await broker.connect()
                client = broker
            }
            let underlying = try await client.sellPutUnderlyingSnapshot(
                symbol: item.symbol
            )
            guard Date() < collectionDeadline else {
                return Self.unavailableSellPutObservation(
                    item,
                    requestId: requestId,
                    capturedAt: capturedAt,
                    reason: "单标的采集超过 180 秒"
                )
            }
            let currentPrice = underlying.currentPrice
            let expiries = try await client.optionExpiries(for: item.symbol)
            guard let expiry = preferredSellPutExpiry(expiries.expiries) else {
                return SellPutObservation(
                    requestId: requestId,
                    symbol: item.symbol,
                    displayName: item.displayName,
                    capturedAt: capturedAt,
                    currentPrice: currentPrice,
                    change30dPercent: underlying.change30dPercent,
                    option: nil,
                    dataGaps: underlying.dataGaps + ["20 至 45 天内无可用 PUT 到期日"],
                    rank: item.rank,
                    marketCap: underlying.marketCap,
                    peRatio: underlying.peRatio,
                    rsi14: underlying.rsi14,
                    ma50: underlying.ma50,
                    ma200: underlying.ma200,
                    trend20d: underlying.trend20d,
                    trend60d: underlying.trend60d,
                    trend120d: underlying.trend120d,
                    distanceTo52wHigh: underlying.distanceTo52wHigh,
                    distanceTo52wLow: underlying.distanceTo52wLow,
                    realizedVol30d: underlying.realizedVol30d
                )
            }
            let chain = try await client.optionChain(
                for: item.symbol,
                expiryDate: expiry.expiryDate
            )
            guard Date() < collectionDeadline else {
                return Self.unavailableSellPutObservation(
                    item,
                    requestId: requestId,
                    capturedAt: capturedAt,
                    reason: "单标的采集超过 180 秒"
                )
            }
            let puts = chain.contracts
                .filter { $0.optionType == .put && $0.addable }
                .sorted {
                    strikeDistance($0.strikePrice, currentPrice: currentPrice)
                        < strikeDistance($1.strikePrice, currentPrice: currentPrice)
                }
            guard !puts.isEmpty else {
                return SellPutObservation(
                    requestId: requestId,
                    symbol: item.symbol,
                    displayName: item.displayName,
                    capturedAt: capturedAt,
                    currentPrice: currentPrice,
                    change30dPercent: underlying.change30dPercent,
                    option: nil,
                    dataGaps: underlying.dataGaps + ["目标到期日无 PUT 合约"],
                    rank: item.rank,
                    marketCap: underlying.marketCap,
                    peRatio: underlying.peRatio,
                    rsi14: underlying.rsi14,
                    ma50: underlying.ma50,
                    ma200: underlying.ma200,
                    trend20d: underlying.trend20d,
                    trend60d: underlying.trend60d,
                    trend120d: underlying.trend120d,
                    distanceTo52wHigh: underlying.distanceTo52wHigh,
                    distanceTo52wLow: underlying.distanceTo52wLow,
                    realizedVol30d: underlying.realizedVol30d
                )
            }
            let quoteResponse = try await client.sellPutOptionQuotes(
                symbols: puts.prefix(30).map(\.providerSymbol)
            )
            let selected = preferredSellPutContract(
                contracts: puts,
                quotes: quoteResponse.quotes,
                currentPrice: currentPrice
            )
            return SellPutObservation(
                requestId: requestId,
                symbol: item.symbol,
                displayName: item.displayName,
                capturedAt: capturedAt,
                currentPrice: currentPrice,
                change30dPercent: underlying.change30dPercent,
                option: selected,
                dataGaps: underlying.dataGaps + quoteResponse.dataGaps,
                rank: item.rank,
                marketCap: underlying.marketCap,
                peRatio: underlying.peRatio,
                rsi14: underlying.rsi14,
                ma50: underlying.ma50,
                ma200: underlying.ma200,
                iv30: selected?.impliedVolatility,
                trend20d: underlying.trend20d,
                trend60d: underlying.trend60d,
                trend120d: underlying.trend120d,
                distanceTo52wHigh: underlying.distanceTo52wHigh,
                distanceTo52wLow: underlying.distanceTo52wLow,
                realizedVol30d: underlying.realizedVol30d
            )
        } catch {
            if !Task.isCancelled,
               Date() < collectionDeadline,
               rateLimitRetry < 2
                && (Self.isBrokerRateLimit(error) || Self.isTransientBrokerError(error)) {
                let delay = Self.isBrokerRateLimit(error) ? 31 : 2 * (rateLimitRetry + 1)
                do {
                    try await Task.sleep(for: .seconds(delay))
                } catch {
                    return Self.unavailableSellPutObservation(
                        item,
                        requestId: requestId,
                        capturedAt: capturedAt,
                        reason: "采集任务已取消"
                    )
                }
                return await collectSellPutObservation(
                    item,
                    providerId: providerId,
                    requestId: requestId,
                    rateLimitRetry: rateLimitRetry + 1,
                    deadline: collectionDeadline
                )
            }
            return Self.unavailableSellPutObservation(
                item,
                requestId: requestId,
                capturedAt: capturedAt,
                reason: error.localizedDescription
            )
        }
    }

    private static func isBrokerRateLimit(_ error: Error) -> Bool {
        let message = error.localizedDescription.lowercased()
        return message.contains("high frequency")
            || message.contains("maximum 10 times per 30 seconds")
            || message.contains("429002")
            || message.contains("30s 区间调用上限")
            || message.contains("请求过于频繁")
    }

    private static func isTransientBrokerError(_ error: Error) -> Bool {
        let message = error.localizedDescription.lowercased()
        return message.contains("500 internal server error")
            || message.contains("http error: 500")
    }

    private func preferredSellPutExpiry(
        _ expiries: [BrokerOptionExpiry]
    ) -> BrokerOptionExpiry? {
        let calendar = Calendar(identifier: .gregorian)
        let today = calendar.startOfDay(for: Date())
        return expiries.compactMap { expiry -> (BrokerOptionExpiry, Int)? in
            guard let date = Self.dayFormatter.date(from: expiry.expiryDate) else { return nil }
            let days = calendar.dateComponents([.day], from: today, to: date).day ?? 0
            return (20...45).contains(days) ? (expiry, days) : nil
        }
        .min { abs($0.1 - 30) < abs($1.1 - 30) }?.0
    }

    private func preferredSellPutContract(
        contracts: [BrokerOptionContract],
        quotes: [SellPutOptionQuote],
        currentPrice: Double?
    ) -> SellPutOptionSnapshot? {
        let quoteByCode = Dictionary(uniqueKeysWithValues: quotes.map {
            (normalizedSymbol($0.code), $0)
        })
        return contracts.compactMap { contract -> (Double, SellPutOptionSnapshot)? in
            guard let strike = Double(contract.strikePrice),
                  let multiplier = Double(contract.contractMultiplier),
                  let quote = quoteByCode[normalizedSymbol(contract.providerSymbol)] else {
                return nil
            }
            let deltaDistance = quote.delta.map { abs(abs($0) - 0.25) } ?? 10
            let priceDistance = currentPrice.map { abs(strike - $0 * 0.85) / $0 } ?? 1
            return (
                deltaDistance * 10 + priceDistance,
                SellPutOptionSnapshot(
                    code: contract.providerSymbol,
                    expiryDate: contract.expiryDate,
                    strikePrice: strike,
                    bid: quote.bid,
                    ask: quote.ask,
                    lastPrice: quote.lastPrice,
                    delta: quote.delta,
                    impliedVolatility: quote.impliedVolatility,
                    volume: quote.volume,
                    openInterest: quote.openInterest,
                    contractMultiplier: multiplier
                )
            )
        }
        .min { $0.0 < $1.0 }?.1
    }

    private func strikeDistance(_ strike: String, currentPrice: Double?) -> Double {
        guard let currentPrice, currentPrice > 0, let strike = Double(strike) else {
            return .greatestFiniteMagnitude
        }
        return abs(strike - currentPrice * 0.85)
    }

    private func normalizedSymbol(_ symbol: String) -> String {
        let parts = symbol.uppercased().split(separator: ".", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { return symbol.uppercased() }
        if ["US", "HK"].contains(parts[0]) { return "\(parts[0]).\(parts[1])" }
        if ["US", "HK"].contains(parts[1]) { return "\(parts[1]).\(parts[0])" }
        return symbol.uppercased()
    }

    private static func unavailableSellPutObservation(
        _ item: SellPutPoolItem,
        requestId: String = UUID().uuidString.lowercased(),
        capturedAt: String = ISO8601DateFormatter().string(from: Date()),
        reason: String
    ) -> SellPutObservation {
        SellPutObservation(
            requestId: requestId,
            symbol: item.symbol,
            displayName: item.displayName,
            capturedAt: capturedAt,
            currentPrice: nil,
            change30dPercent: nil,
            option: nil,
            dataGaps: [reason],
            rank: item.rank
        )
    }

    private static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    private func addProviderPoolItem(
        providerId: String,
        request: AddProviderPoolItemRequest
    ) async {
        guard let accessToken = authenticationSession?.accessToken,
              providerPoolOnlineValidated,
              !isProviderPoolLoading else { return }
        isProviderPoolLoading = true
        do {
            _ = try await backend.addProviderPoolItem(
                providerId: providerId,
                item: request,
                accessToken: accessToken
            )
            providerPoolStatusMessage = "标的已加入 \(providerId) 独立标的池"
        } catch {
            isProviderPoolLoading = false
            providerPoolStatusMessage = error.localizedDescription
            return
        }
        isProviderPoolLoading = false
        await refreshProviderPools(force: true)
    }

    private func discoveryClient(providerId: String) -> BrokerInstrumentDiscoveryClient {
        providerId == "LONGBRIDGE" ? longbridgeBroker : broker
    }

    private func syncActiveResearchPool() {
        let providerId = platform == .longbridge ? "LONGBRIDGE" : "FUTU"
        guard let pool = providerPools[providerId] else {
            researchPool = []
            researchPoolEntitlement = .unavailable
            conversationResearchSymbols = []
            return
        }
        researchPool = pool.items.map {
            ResearchPoolItem(
                symbol: $0.canonicalSymbol,
                displayName: $0.displayName,
                lockedUntil: nil
            )
        }
        let isActive = providerPoolOnlineValidated && pool.entitlement.active
        let status: ResearchEntitlementStatus = isActive ? .active : .expired
        researchPoolEntitlement = ResearchPoolEntitlement(
            status: status,
            planName: currentSubscription?.planName,
            poolLimit: pool.entitlement.capacity ?? 10_000,
            replacementIntervalDays: 30,
            nextReplacementAt: pool.entitlement.replacementWindowEnd.flatMap {
                ISO8601DateFormatter().date(from: $0)
            }
        )
        conversationResearchSymbols = conversationResearchSymbols.intersection(
            Set(researchPool.map(\.symbol))
        )
    }

    private func providerPoolCacheNamespace(accessToken: String) -> String {
        let parts = accessToken.split(separator: ".")
        if parts.count > 1 {
            var encoded = String(parts[1])
                .replacingOccurrences(of: "-", with: "+")
                .replacingOccurrences(of: "_", with: "/")
            encoded += String(repeating: "=", count: (4 - encoded.count % 4) % 4)
            if let data = Data(base64Encoded: encoded),
               let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let subject = object["sub"] as? String {
                let digest = SHA256.hash(data: Data(subject.utf8))
                return digest.map { String(format: "%02x", $0) }.joined()
            }
        }
        let digest = SHA256.hash(data: Data(accessToken.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    func refreshCurrentBrokerData() async {
        switch platform {
        case .futu:
            await refreshBrokerData()
        case .longbridge:
            await refreshLongbridgeData()
        case .aShare:
            return
        }
        if let connectionId = currentBrokerConnectionId,
           let accessToken = authenticationSession?.accessToken {
            await refreshShadowHistory(connectionId: connectionId, accessToken: accessToken)
        }
    }

    func refreshBrokerData(force: Bool = false) async {
        let now = Date()
        guard !isRefreshingBroker,
              !sellPutRunState(for: "FUTU").isRunning,
              LiveTradingBrokerRefreshPolicy.shouldRefreshSnapshot(
                  lastUpdatedAt: brokerLastUpdatedAt,
                  blockedUntil: futuSnapshotBlockedUntil,
                  now: now,
                  force: force
              ) else { return }
        isRefreshingBroker = true
        defer { isRefreshingBroker = false }
        do {
            if broker.connectionState != .connected {
                await broker.connect()
            }
            let researchSymbols = providerPools["FUTU"]?.items
                .filter {
                    $0.status == "ACTIVE"
                        && ($0.instrumentType == .stock || $0.instrumentType == .etf)
                }
                .map(\.providerSymbol)
                .sorted() ?? []
            let snapshot = try await broker.loadSnapshot(
                additionalSymbols: researchSymbols
            )
            account = snapshot.account
            positions = snapshot.positions
            market = snapshot.market
            quotes = snapshot.quotes
            minuteBars = snapshot.minuteBars
            tickerPoints = snapshot.tickerPoints
            orderBooks = snapshot.orderBooks
            openOrders = snapshot.openOrders
            recentDeals = snapshot.recentDeals
            historicalOrders = snapshot.historicalOrders
            historicalDeals = snapshot.historicalDeals
            brokerDataGaps = snapshot.dataGaps
            brokerLastUpdatedAt = Date()
            futuSnapshotBlockedUntil = nil
            try await registerBrokerConnectionIfNeeded(snapshot.account)
            statusMessage = nil
        } catch {
            if Self.isFutuRateLimitError(error) {
                futuSnapshotBlockedUntil = Date().addingTimeInterval(
                    LiveTradingBrokerRefreshPolicy.rateLimitBackoff
                )
            }
            statusMessage = error.localizedDescription
        }
    }

    func refreshMarketIntelligence() async {
        guard !isRefreshingMarketIntelligence else { return }
        guard platform == .futu else {
            marketIntelligenceStatusMessage = nil
            return
        }
        isRefreshingMarketIntelligence = true
        defer { isRefreshingMarketIntelligence = false }
        let symbols = providerPools["FUTU"]?.items
            .filter {
                $0.status == "ACTIVE"
                    && ($0.instrumentType == .stock || $0.instrumentType == .etf)
            }
            .map(\.providerSymbol)
            .sorted() ?? []
        do {
            marketIntelligence = try await broker.loadMarketIntelligence(symbols: symbols)
            marketIntelligenceStatusMessage = nil
        } catch {
            marketIntelligenceStatusMessage = error.localizedDescription
        }
    }

    func refreshLongbridgeData() async {
        guard !isRefreshingLongbridge,
              !sellPutRunState(for: "LONGBRIDGE").isRunning else { return }
        isRefreshingLongbridge = true
        defer { isRefreshingLongbridge = false }
        do {
            if longbridgeBroker.connectionState != .connected {
                await longbridgeBroker.connect()
            }
            let researchSymbols = providerPools["LONGBRIDGE"]?.items
                .filter {
                    $0.status == "ACTIVE"
                        && ($0.instrumentType == .stock || $0.instrumentType == .etf)
                }
                .map(\.providerSymbol)
                .sorted() ?? []
            let snapshot = try await longbridgeBroker.loadSnapshot(
                additionalSymbols: researchSymbols
            )
            longbridgeAccount = snapshot.account
            longbridgePositions = snapshot.positions
            longbridgeMarket = snapshot.market
            longbridgeQuotes = snapshot.quotes
            longbridgeMinuteBars = snapshot.minuteBars
            longbridgeTickerPoints = snapshot.tickerPoints
            longbridgeOrderBooks = snapshot.orderBooks
            longbridgeOpenOrders = snapshot.openOrders
            longbridgeRecentDeals = snapshot.recentDeals
            longbridgeHistoricalOrders = snapshot.historicalOrders
            longbridgeHistoricalDeals = snapshot.historicalDeals
            longbridgeDataGaps = snapshot.dataGaps
            longbridgeLastUpdatedAt = Date()
            try await registerLongbridgeConnectionIfNeeded(snapshot.account)
            longbridgeStatusMessage = nil
        } catch {
            longbridgeStatusMessage = error.localizedDescription
        }
    }

    func saveLongbridgeCredentials(
        appKey: String,
        appSecret: String,
        accessToken: String
    ) async -> Bool {
        do {
            let value = LongbridgeCredentials(
                appKey: appKey,
                appSecret: appSecret,
                accessToken: accessToken
            )
            try credentials.saveLongbridgeCredentials(value)
            hasLongbridgeCredentials = true
            longbridgeBroker.disconnect()
            longbridgeStatusMessage = nil
            await refreshLongbridgeData()
            return longbridgeBroker.connectionState == .connected
        } catch {
            longbridgeStatusMessage = error.localizedDescription
            return false
        }
    }

    func clearLongbridgeCredentials() {
        do {
            try credentials.clearLongbridgeCredentials()
            hasLongbridgeCredentials = false
            longbridgeBroker.disconnect()
            clearLongbridgeSnapshot()
            longbridgeStatusMessage = "Longbridge API 凭据已删除"
        } catch {
            longbridgeStatusMessage = error.localizedDescription
        }
    }

    private func clearLongbridgeSnapshot() {
        longbridgeAccount = nil
        longbridgePositions = []
        longbridgeMarket = nil
        longbridgeQuotes = []
        longbridgeMinuteBars = []
        longbridgeTickerPoints = []
        longbridgeOrderBooks = []
        longbridgeOpenOrders = []
        longbridgeRecentDeals = []
        longbridgeHistoricalOrders = []
        longbridgeHistoricalDeals = []
        longbridgeDataGaps = []
        longbridgeLastUpdatedAt = nil
    }

    var conversationCapabilities: [ConversationCapability] {
        ResearchSkill.allCases.map { skill in
            ConversationCapability(
                id: skill.rawValue,
                kind: .skill,
                title: skill.title,
                detail: skill.detail,
                systemImage: skill.systemImage,
                promptVersion: skill.promptVersion,
                modelProfile: researchModel(for: skill),
                toolPolicyVersion: "research-readonly-v1"
            )
        }
    }

    func sendMessage(_ text: String, capabilities: [ConversationCapability] = []) async {
        let message = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty, !isSendingMessage else { return }
        conversationMessages.append(ConversationMessage(
            role: .user,
            content: message,
            evidence: [],
            risks: [],
            exitCondition: nil
        ))
        isSendingMessage = true
        defer { isSendingMessage = false }

        do {
            guard platform != .longbridge else {
                throw AppInteractionError.longbridgeContextUnavailable
            }
            if account == nil || brokerConnectionId == nil {
                await refreshBrokerData()
            }
            guard let account,
                  let market,
                  let brokerConnectionId,
                  let accessToken = authenticationSession?.accessToken else {
                throw BackendClientError.serviceUnavailable
            }
            if !conversationResearchSymbols.isEmpty, !providerPoolOnlineValidated {
                throw AppInteractionError.providerPoolNotVerified
            }
            let identity = try credentials.deviceIdentity(for: backendEnvironment)
            let selected = conversationResearchSymbols.sorted()
            let batches = ResearchBatching.conversationBatches(selected)
            let modelRoute = selectedConversationModelRoute
            var results: [ModelResult] = []
            for batch in batches {
                contextSequence += 1
                let context = try ContextEnvelopeFactory.make(
                    deviceId: identity.deviceId,
                    brokerConnectionId: brokerConnectionId,
                    purpose: "CHAT",
                    sequence: contextSequence,
                    snapshot: contextSnapshot(
                        account: account,
                        market: market,
                        capabilities: capabilities,
                        requestedSymbols: batch,
                        provider: "FUTU",
                        config: tradingConfigurations[brokerConnectionId]
                    ),
                    strategyConfigVersion: "conversation-capabilities-v1",
                    clientPolicyVersion: "macos-v1",
                    devicePrivateKey: identity.privateKey
                )
                results.append(try await backend.runModel(
                    context: context,
                    userMessage: message,
                    modelRoute: modelRoute,
                    accessToken: accessToken
                ))
            }
            conversationMessages.append(ConversationMessage(
                role: .assistant,
                content: results.map(\.summary).joined(separator: "\n\n"),
                evidence: results.flatMap(\.evidence),
                risks: Array(Set(results.flatMap(\.risks))).sorted(),
                exitCondition: results.compactMap(\.exitCondition).joined(separator: "；")
            ))
        } catch {
            conversationMessages.append(ConversationMessage(
                role: .assistant,
                content: "请求失败：\(error.localizedDescription)",
                evidence: [],
                risks: [],
                exitCondition: nil
            ))
        }
    }

    func toggleConversationResearchSymbol(_ symbol: String) {
        guard researchPool.contains(where: { $0.symbol == symbol }) else { return }
        if conversationResearchSymbols.contains(symbol) {
            conversationResearchSymbols.remove(symbol)
        } else {
            conversationResearchSymbols.insert(symbol)
        }
    }

    func selectAllConversationResearchSymbols() {
        conversationResearchSymbols = Set(researchPool.map(\.symbol))
    }

    func researchModel(for skill: ResearchSkill) -> ResearchModelProfile {
        researchModels[skill] ?? .deep
    }

    func setResearchModel(_ model: ResearchModelProfile, for skill: ResearchSkill) {
        researchModels[skill] = model
        persistResearchPreferences()
    }

    private func registerBrokerConnectionIfNeeded(_ account: AccountSummary) async throws {
        guard brokerConnectionId == nil,
              let accessToken = authenticationSession?.accessToken else { return }
        let digest = SHA256.hash(data: Data(account.accountId.utf8))
        let accountIdHash = digest.map { String(format: "%02x", $0) }.joined()
        let connection = try await backend.registerFutuConnection(
            accountIdHash: accountIdHash,
            environment: account.environment,
            accessToken: accessToken
        )
        brokerConnectionId = connection.brokerConnectionId
        await loadTradingControlPlane(
            connection.brokerConnectionId,
            provider: "FUTU",
            accessToken: accessToken
        )
    }

    private func registerLongbridgeConnectionIfNeeded(_ account: AccountSummary) async throws {
        guard longbridgeBrokerConnectionId == nil,
              let accessToken = authenticationSession?.accessToken else { return }
        let digest = SHA256.hash(data: Data(account.accountId.utf8))
        let accountIdHash = digest.map { String(format: "%02x", $0) }.joined()
        let connection = try await backend.registerBrokerConnection(
            provider: "LONGBRIDGE",
            accountIdHash: accountIdHash,
            environment: account.environment,
            displayName: account.environment == "REAL"
                ? "Longbridge 实盘账户"
                : "Longbridge 模拟账户",
            accessToken: accessToken
        )
        longbridgeBrokerConnectionId = connection.brokerConnectionId
        await loadTradingControlPlane(
            connection.brokerConnectionId,
            provider: "LONGBRIDGE",
            accessToken: accessToken
        )
    }

    private func loadTradingControlPlane(
        _ connectionId: String,
        provider: String,
        accessToken: String
    ) async {
        do {
            async let catalog = backend.tradingCatalog(
                brokerConnectionId: connectionId,
                accessToken: accessToken
            )
            async let configuration = backend.tradingConfiguration(
                brokerConnectionId: connectionId,
                accessToken: accessToken
            )
            let catalogValue = try await catalog
            tradingCatalogs[connectionId] = catalogValue
            if let value = try await configuration {
                tradingConfigurations[connectionId] = value
            } else {
                let input = try SaveTradingConfigurationRequest.shadowDefault(
                    catalog: catalogValue,
                    provider: provider
                )
                tradingConfigurations[connectionId] = try await backend
                    .saveTradingConfiguration(
                        brokerConnectionId: connectionId,
                        input: input,
                        accessToken: accessToken
                    )
            }
            let setting = try await backend.liveExecutionSetting(
                provider: provider,
                accessToken: accessToken
            )
            liveExecutionSettings[provider] = setting
            saveAutoSubmitPreference(setting.autoSubmitEnabled, provider: provider)
            await refreshShadowHistory(connectionId: connectionId, accessToken: accessToken)
            await refreshLiveTradingState(
                connectionId: connectionId,
                provider: provider,
                accessToken: accessToken
            )
            startLiveTradingSupervisor(connectionId: connectionId, provider: provider)
        } catch {
            let message = "交易控制面加载失败：\(error.localizedDescription)"
            if connectionId == longbridgeBrokerConnectionId {
                longbridgeStatusMessage = message
            } else {
                statusMessage = message
            }
        }
    }

    func refreshLiveExecutionSettings() async {
        guard let accessToken = authenticationSession?.accessToken else { return }
        for provider in ["FUTU", "LONGBRIDGE"] {
            do {
                liveExecutionSettings[provider] = try await backend.liveExecutionSetting(
                    provider: provider,
                    accessToken: accessToken
                )
                if let setting = liveExecutionSettings[provider] {
                    saveAutoSubmitPreference(setting.autoSubmitEnabled, provider: provider)
                }
            } catch {
                continue
            }
        }
    }

    func setCurrentAutoSubmitEnabled(_ enabled: Bool) async -> Bool {
        guard let accessToken = authenticationSession?.accessToken,
              let connectionId = currentBrokerConnectionId,
              let account = currentAccount,
              let currentConfig = tradingConfigurations[connectionId] else {
            setLiveTradingStatus("真实交易控制面尚未就绪")
            return false
        }
        let provider = currentProviderId
        let currentSetting: LiveExecutionSetting
        do {
            currentSetting = try await backend.liveExecutionSetting(
                provider: provider,
                accessToken: accessToken
            )
            liveExecutionSettings[provider] = currentSetting
            saveAutoSubmitPreference(currentSetting.autoSubmitEnabled, provider: provider)
        } catch {
            setLiveTradingStatus("真实交易设置读取失败：\(error.localizedDescription)")
            return false
        }
        guard account.environment == "REAL" else {
            setLiveTradingStatus("仅 REAL 账户可启用真实交易")
            return false
        }
        if enabled {
            guard currentSetting.hardGateEnabled, currentSetting.blockers.isEmpty else {
                setLiveTradingStatus(
                    "真实交易门禁未满足：\(currentSetting.blockers.first ?? "后台门禁关闭")"
                )
                return false
            }
            guard isCurrentBrokerConnected else {
                setLiveTradingStatus("券商连接不可用")
                return false
            }
        }
        do {
            let identity = try credentials.deviceIdentity(for: backendEnvironment)
            let mode = enabled ? "AUTO_EXECUTE_PREFERENCE" : "MANUAL_CONFIRM"
            let savedConfig: TradingConfiguration
            if currentConfig.confirmationMode == mode {
                savedConfig = currentConfig
            } else {
                savedConfig = try await backend.saveTradingConfiguration(
                    brokerConnectionId: connectionId,
                    input: .updating(currentConfig, confirmationMode: mode),
                    accessToken: accessToken
                )
                tradingConfigurations[connectionId] = savedConfig
            }
            let setting = try await backend.updateLiveExecutionSetting(
                provider: provider,
                input: UpdateLiveExecutionSettingRequest(
                    autoSubmitEnabled: enabled,
                    expectedVersion: currentSetting.version
                ),
                accessToken: accessToken
            )
            liveExecutionSettings[provider] = setting
            saveAutoSubmitPreference(setting.autoSubmitEnabled, provider: provider)
            if enabled {
                do {
                    _ = try await ensureTradingLease(
                        connectionId: connectionId,
                        deviceId: identity.deviceId,
                        accessToken: accessToken
                    )
                    _ = try await activateLiveTradingSession(
                        connectionId: connectionId,
                        provider: provider,
                        account: account,
                        config: savedConfig,
                        deviceId: identity.deviceId,
                        accessToken: accessToken
                    )
                } catch {
                    setLiveTradingStatus(
                        "自动提交偏好已保存，会话启动失败：\(error.localizedDescription)"
                    )
                }
            } else {
                if let session = liveTradingRuntimeByConnection[connectionId]?.session {
                    _ = try? await backend.deactivateLiveTradingSession(
                        sessionId: session.sessionId,
                        accessToken: accessToken
                    )
                }
                var runtime = liveTradingRuntimeByConnection[connectionId]
                    ?? LiveTradingRuntimeState()
                runtime.session = nil
                runtime.statusMessage = "已切换为逐笔人工确认"
                liveTradingRuntimeByConnection[connectionId] = runtime
            }
            return true
        } catch {
            setLiveTradingStatus("真实交易设置失败：\(error.localizedDescription)")
            await refreshLiveExecutionSettings()
            return false
        }
    }

    func confirmPendingLiveOrder(_ intentId: String) async {
        guard let pending = currentPendingLiveOrders.first(where: { $0.intentId == intentId }) else {
            setLiveTradingStatus("待确认订单已失效")
            return
        }
        await executeLiveOrder(pending)
    }

    func rejectPendingLiveOrder(_ intentId: String) async {
        guard let accessToken = authenticationSession?.accessToken,
              let pending = currentPendingLiveOrders.first(where: { $0.intentId == intentId }) else {
            return
        }
        do {
            let identity = try credentials.deviceIdentity(for: backendEnvironment)
            try await liveOrderCoordinator.reject(
                pending: pending,
                deviceId: identity.deviceId,
                reasonCode: "USER_REJECTED",
                accessToken: accessToken
            )
            setLiveTradingStatus("已拒绝 \(pending.symbol) 系统订单")
            await refreshCurrentLiveTradingState()
        } catch {
            setLiveTradingStatus("拒绝订单失败：\(error.localizedDescription)")
        }
    }

    func requestCancelManagedOrder(_ intentId: String) async {
        guard let accessToken = authenticationSession?.accessToken,
              let pending = currentPendingLiveOrders.first(where: { $0.intentId == intentId })
        else { return }
        do {
            let identity = try credentials.deviceIdentity(for: backendEnvironment)
            _ = try await ensureTradingLease(
                connectionId: pending.brokerConnectionId,
                deviceId: identity.deviceId,
                accessToken: accessToken
            )
            _ = try await backend.requestPendingOrderCancel(
                intentId: intentId,
                input: PendingOrderDecisionRequest(
                    deviceId: identity.deviceId,
                    reasonCode: "USER_REQUESTED_CANCEL"
                ),
                accessToken: accessToken
            )
            await refreshCurrentLiveTradingState()
        } catch {
            setLiveTradingStatus("申请撤单失败：\(error.localizedDescription)")
        }
    }

    func refreshCurrentLiveTradingState() async {
        guard let connectionId = currentBrokerConnectionId,
              let accessToken = authenticationSession?.accessToken else { return }
        await refreshLiveTradingState(
            connectionId: connectionId,
            provider: currentProviderId,
            accessToken: accessToken
        )
    }

    private func startLiveTradingSupervisor(connectionId: String, provider: String) {
        liveTradingTasks[connectionId]?.cancel()
        liveTradingTasks[connectionId] = Task { [weak self] in
            while !Task.isCancelled {
                guard let self,
                      let accessToken = self.authenticationSession?.accessToken else { return }
                await self.refreshLiveTradingState(
                    connectionId: connectionId,
                    provider: provider,
                    accessToken: accessToken
                )
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }

    private func refreshLiveTradingState(
        connectionId: String,
        provider: String,
        accessToken: String
    ) async {
        var runtime = liveTradingRuntimeByConnection[connectionId] ?? LiveTradingRuntimeState()
        guard !runtime.isRefreshing else { return }
        runtime.isRefreshing = true
        liveTradingRuntimeByConnection[connectionId] = runtime
        defer {
            var latest = liveTradingRuntimeByConnection[connectionId] ?? LiveTradingRuntimeState()
            latest.isRefreshing = false
            liveTradingRuntimeByConnection[connectionId] = latest
        }
        do {
            async let pending = backend.pendingLiveOrders(
                brokerConnectionId: connectionId,
                accessToken: accessToken
            )
            async let actions = backend.pendingOrderActions(
                brokerConnectionId: connectionId,
                accessToken: accessToken
            )
            async let session = backend.currentLiveTradingSession(
                brokerConnectionId: connectionId,
                accessToken: accessToken
            )
            let values = try await (pending, actions, session)
            var latest = liveTradingRuntimeByConnection[connectionId]
                ?? LiveTradingRuntimeState()
            latest.pendingOrders = values.0
            latest.orderActions = values.1
            latest.session = values.2
            latest.lastReconciledAt = Date()
            latest.statusMessage = nil
            liveTradingRuntimeByConnection[connectionId] = latest


            let identity = try credentials.deviceIdentity(for: backendEnvironment)
            let account = accountForProvider(provider)
            let setting = liveExecutionSettings[provider]
            let hasManagedOrders = values.0.contains(where: Self.isManagedOrder)
            let requiresLease = LiveTradingLeasePolicy.shouldMaintainLease(
                accountEnvironment: account?.environment,
                brokerConnected: isBrokerConnected(provider),
                hardGateEnabled: setting?.hardGateEnabled == true,
                blockers: setting?.blockers ?? [],
                hasSession: values.2 != nil,
                hasPendingActions: !values.1.isEmpty,
                hasManagedOrders: hasManagedOrders
            )
            if requiresLease {
                _ = try await ensureTradingLease(
                    connectionId: connectionId,
                    deviceId: identity.deviceId,
                    accessToken: accessToken
                )
            }
            var activeSession = values.2
            if LiveTradingLeasePolicy.shouldActivateAutoSubmitSession(
                accountEnvironment: account?.environment,
                brokerConnected: isBrokerConnected(provider),
                hardGateEnabled: setting?.hardGateEnabled == true,
                autoSubmitEnabled: setting?.autoSubmitEnabled == true,
                blockers: setting?.blockers ?? [],
                hasSession: activeSession != nil
            ), let account, let config = tradingConfigurations[connectionId] {
                activeSession = try await activateLiveTradingSession(
                    connectionId: connectionId,
                    provider: provider,
                    account: account,
                    config: config,
                    deviceId: identity.deviceId,
                    accessToken: accessToken
                )
            }
            let requiresBrokerSnapshot =
                LiveTradingBrokerRefreshPolicy.supervisorNeedsSnapshot(
                    hasPendingActions: !values.1.isEmpty,
                    hasManagedOrders: hasManagedOrders
                )
            if requiresBrokerSnapshot {
                if provider == "LONGBRIDGE" {
                    await refreshLongbridgeData()
                } else {
                    await refreshBrokerData()
                }
            }
            guard let account else { return }
            if !values.1.isEmpty {
                await processManagedActions(
                    values.1,
                    orders: values.0,
                    provider: provider,
                    accountId: account.accountId,
                    deviceId: identity.deviceId,
                    accessToken: accessToken
                )
                return
            }
            let requestedSafetyCancel = await requestSafetyCancellations(
                orders: values.0,
                provider: provider,
                connectionId: connectionId,
                account: account,
                deviceId: identity.deviceId,
                accessToken: accessToken
            )
            if requestedSafetyCancel { return }
            for order in values.0 where order.state == "SUBMITTING" {
                await reconcileSubmittingOrder(order, accessToken: accessToken)
            }
            for order in values.0 where
                order.state == "CLAIMED"
                    && order.claimExpiresAt.map({ Self.secondsRemaining($0) <= 0 }) == true {
                try? await liveOrderCoordinator.reject(
                    pending: order,
                    deviceId: identity.deviceId,
                    reasonCode: "CLAIM_EXPIRED",
                    accessToken: accessToken
                )
            }
            if let session = activeSession,
               setting?.autoSubmitEnabled == true {
                try await renewTradingRuntimeIfNeeded(
                    session: session,
                    connectionId: connectionId,
                    deviceId: identity.deviceId,
                    accessToken: accessToken
                )
                for order in values.0 where
                    order.submissionMode == "AUTO_EXECUTE"
                        && order.state == "PENDING_CONFIRMATION" {
                    await executeLiveOrder(order)
                }
            }
        } catch {
            setLiveTradingStatus(
                "系统挂单监管异常：\(error.localizedDescription)",
                connectionId: connectionId
            )
        }
    }

    private func executeLiveOrder(_ pending: PendingLiveOrder) async {
        guard let accessToken = authenticationSession?.accessToken else {
            setLiveTradingStatus("订单执行上下文不完整")
            return
        }
        isTradingCriticalFlowActive = true
        defer { isTradingCriticalFlowActive = false }
        do {
            if pending.provider == "LONGBRIDGE" {
                await refreshLongbridgeData()
            } else {
                await refreshBrokerData(force: true)
            }
            guard let account = accountForProvider(pending.provider) else {
                throw AppInteractionError.liveOrderValidationFailed("账户快照不可用")
            }
            try revalidateLiveOrder(pending, account: account)
            let identity = try credentials.deviceIdentity(for: backendEnvironment)
            _ = try await ensureTradingLease(
                connectionId: pending.brokerConnectionId,
                deviceId: identity.deviceId,
                accessToken: accessToken
            )
            let outcome = try await liveOrderCoordinator.execute(
                pending: pending,
                context: try liveOrderContext(
                    for: pending,
                    account: account,
                    identity: identity,
                    accessToken: accessToken
                ),
                broker: brokerForProvider(pending.provider),
                accessToken: accessToken
            )
            setLiveTradingStatus(
                outcome.message,
                connectionId: pending.brokerConnectionId
            )
        } catch {
            setLiveTradingStatus(
                "订单未提交：\(error.localizedDescription)",
                connectionId: pending.brokerConnectionId
            )
        }
        await refreshLiveTradingState(
            connectionId: pending.brokerConnectionId,
            provider: pending.provider,
            accessToken: accessToken
        )
    }

    private func revalidateLiveOrder(
        _ pending: PendingLiveOrder,
        account: AccountSummary
    ) throws {
        guard account.environment == "REAL" else {
            throw AppInteractionError.liveOrderValidationFailed("当前不是 REAL 账户")
        }
        let sourceAt = pending.provider == "LONGBRIDGE"
            ? longbridgeLastUpdatedAt
            : brokerLastUpdatedAt
        let maxAge = Double(min(
            pending.clientRevalidation.quoteMaxAgeMs,
            pending.clientRevalidation.accountMaxAgeMs
        )) / 1_000
        guard let sourceAt, Date().timeIntervalSince(sourceAt) <= maxAge else {
            throw AppInteractionError.liveOrderValidationFailed("账户或行情快照已过期")
        }
        let quotes = pending.provider == "LONGBRIDGE" ? longbridgeQuotes : self.quotes
        let normalized = BrokerSymbolNormalizer.normalize(pending.order.symbol)
        guard let quote = quotes.first(where: {
            BrokerSymbolNormalizer.normalize($0.symbol) == normalized
        }) else {
            throw AppInteractionError.liveOrderValidationFailed("标的实时行情不可用")
        }
        guard quote.updateTime == nil
                || BrokerTimestampNormalizer.isFresh(
                    quote.updateTime,
                    symbol: quote.symbol,
                    maximumAge: maxAge
                ) else {
            throw AppInteractionError.liveOrderValidationFailed("标的行情时间已超过允许范围")
        }
        let orderBooks = pending.provider == "LONGBRIDGE"
            ? longbridgeOrderBooks
            : self.orderBooks
        let orderBook = orderBooks.first {
            BrokerSymbolNormalizer.normalize($0.symbol) == normalized
        }
        let reference = pending.order.side == "BUY"
            ? quote.askPrice ?? orderBook?.asks.first?.price
            : quote.bidPrice ?? orderBook?.bids.first?.price
        guard let reference, reference > 0,
              let limit = Decimal(string: pending.order.limitPrice),
              limit > 0 else {
            throw AppInteractionError.liveOrderValidationFailed("买卖盘或限价不可用")
        }
        let driftBps = abs(
            NSDecimalNumber(decimal: (limit - reference) / reference * 10_000).doubleValue
        )
        guard driftBps <= Double(pending.order.maxSlippageBps) else {
            throw AppInteractionError.liveOrderValidationFailed("限价偏离当前买卖盘超过允许滑点")
        }
        let openOrders = pending.provider == "LONGBRIDGE"
            ? longbridgeOpenOrders
            : self.openOrders
        let conflictingExternalOrder = openOrders.contains {
            BrokerSymbolNormalizer.normalize($0.symbol) == normalized
                && $0.orderId != pending.brokerOrderId
        }
        guard !conflictingExternalOrder else {
            throw AppInteractionError.liveOrderValidationFailed("存在同标的外部挂单，已阻断新订单")
        }
    }

    private func reconcileSubmittingOrder(
        _ pending: PendingLiveOrder,
        accessToken: String
    ) async {
        guard let account = accountForProvider(pending.provider) else { return }
        do {
            let identity = try credentials.deviceIdentity(for: backendEnvironment)
            let outcome = try await liveOrderCoordinator.reconcileSubmitting(
                pending: pending,
                context: try liveOrderContext(
                    for: pending,
                    account: account,
                    identity: identity,
                    accessToken: accessToken
                ),
                broker: brokerForProvider(pending.provider),
                accessToken: accessToken
            )
            setLiveTradingStatus(
                outcome.message,
                connectionId: pending.brokerConnectionId
            )
        } catch {
            setLiveTradingStatus(
                "提交中订单对账失败：\(error.localizedDescription)",
                connectionId: pending.brokerConnectionId
            )
        }
    }

    private func liveOrderContext(
        for pending: PendingLiveOrder,
        account: AccountSummary,
        identity: DeviceIdentity,
        accessToken: String
    ) throws -> LiveOrderExecutionContext {
        guard let pool = providerPools[pending.provider],
              let config = tradingConfigurations[pending.brokerConnectionId] else {
            throw LiveOrderCoordinatorError.submissionIntentMismatch
        }
        return LiveOrderExecutionContext(
            userId: try Self.accessTokenIdentity(accessToken).userId,
            deviceId: identity.deviceId,
            brokerConnectionId: pending.brokerConnectionId,
            provider: pending.provider,
            accountId: account.accountId,
            accountIdHash: Self.sha256(account.accountId),
            poolVersion: pool.version,
            configVersion: config.version,
            riskPolicyVersion: config.riskPolicyId,
            sessionId: pending.sessionId
        )
    }

    private func processManagedActions(
        _ actions: [PendingOrderAction],
        orders: [PendingLiveOrder],
        provider: String,
        accountId: String,
        deviceId: String,
        accessToken: String
    ) async {
        await managedOrderSupervisor.process(
            actions: actions,
            orders: orders,
            deviceId: deviceId,
            accountId: accountId,
            broker: brokerForProvider(provider),
            accessToken: accessToken
        )
    }

    private func requestSafetyCancellations(
        orders: [PendingLiveOrder],
        provider: String,
        connectionId: String,
        account: AccountSummary,
        deviceId: String,
        accessToken: String
    ) async -> Bool {
        let managed = orders.filter {
            ["SUBMITTED", "TRACKING", "PARTIALLY_FILLED"].contains($0.state)
        }
        guard !managed.isEmpty else { return false }
        let quotes = provider == "LONGBRIDGE" ? longbridgeQuotes : self.quotes
        let sourceAt = provider == "LONGBRIDGE" ? longbridgeLastUpdatedAt : brokerLastUpdatedAt
        let market = provider == "LONGBRIDGE" ? longbridgeMarket : self.market
        let leaseValid = liveTradingRuntimeByConnection[connectionId]?.lease.map {
            Self.secondsRemaining($0.expiresAt) > 0
        } ?? false
        var requested = false
        for order in managed {
            let normalized = BrokerSymbolNormalizer.normalize(order.order.symbol)
            let quote = quotes.first {
                BrokerSymbolNormalizer.normalize($0.symbol) == normalized
            }
            let reference = order.order.side == "BUY" ? quote?.askPrice : quote?.bidPrice
            let receipt = try? await brokerForProvider(provider).findOrder(
                BrokerFindOrderRequest(
                    intentId: order.intentId,
                    accountId: account.accountId,
                    symbol: order.order.symbol,
                    side: order.order.side,
                    quantity: order.order.quantity,
                    limitPrice: order.order.limitPrice,
                    submittedAfter: order.issuedAt
                )
            )
            guard let signalValidUntil = Self.isoDate(order.signalValidUntil),
                  let intentExpiresAt = Self.isoDate(order.expiresAt),
                  let submittedAt = order.submittedAt.flatMap(Self.isoDate),
                  let limitPrice = Decimal(string: order.order.limitPrice) else {
                continue
            }
            let marketState = (quote?.marketState ?? market?.state)?.uppercased() ?? ""
            let marketOpen = [
                "REGULAR", "RTH", "TRADING", "NORMAL", "MORNING", "AFTERNOON",
                "盘中", "交易中"
            ].contains(marketState)
            let reason = ManagedOrderSafetyPolicy.cancellationReason(
                ManagedOrderSafetyInput(
                    now: Date(),
                    signalValidUntil: signalValidUntil,
                    intentExpiresAt: intentExpiresAt,
                    submittedAt: submittedAt,
                    orderType: order.order.orderType,
                    limitPrice: limitPrice,
                    latestReferencePrice: reference,
                    marketDataFresh: sourceAt.map {
                        Date().timeIntervalSince($0)
                            <= Double(order.clientRevalidation.quoteMaxAgeMs) / 1_000
                    } ?? false,
                    marketSessionOpen: marketOpen,
                    securityHalted: false,
                    brokerMarketable: receipt != nil,
                    accountRiskValid: account.marginCallActive != true,
                    leaseValid: leaseValid,
                    connectionActive: isBrokerConnected(provider),
                    filledQuantity: receipt?.filledQuantity ?? 0,
                    lastFilledQuantity: receipt?.filledQuantity ?? 0,
                    lastFillProgressAt: receipt.flatMap { Self.isoDate($0.updatedAt) }
                )
            )
            guard let reason else { continue }
            do {
                _ = try await backend.requestPendingOrderCancel(
                    intentId: order.intentId,
                    input: PendingOrderDecisionRequest(
                        deviceId: deviceId,
                        reasonCode: reason
                    ),
                    accessToken: accessToken
                )
                requested = true
            } catch {
                setLiveTradingStatus(
                    "安全撤单请求失败：\(error.localizedDescription)",
                    connectionId: connectionId
                )
            }
        }
        return requested
    }

    private func ensureTradingLease(
        connectionId: String,
        deviceId: String,
        accessToken: String
    ) async throws -> TradingLease {
        let request = TradingLeaseRequest(
            deviceId: deviceId,
            brokerConnectionId: connectionId
        )
        let existing = liveTradingRuntimeByConnection[connectionId]?.lease
        let lease: TradingLease
        if let existing, Self.secondsRemaining(existing.expiresAt) > 35 {
            return existing
        } else if existing != nil {
            lease = try await backend.renewTradingLease(request, accessToken: accessToken)
        } else {
            lease = try await backend.acquireTradingLease(request, accessToken: accessToken)
        }
        var runtime = liveTradingRuntimeByConnection[connectionId] ?? LiveTradingRuntimeState()
        runtime.lease = lease
        liveTradingRuntimeByConnection[connectionId] = runtime
        return lease
    }

    private func activateLiveTradingSession(
        connectionId: String,
        provider: String,
        account: AccountSummary,
        config: TradingConfiguration,
        deviceId: String,
        accessToken: String
    ) async throws -> LiveTradingSession {
        let disclosure = [
            provider,
            account.accountId,
            String(config.version),
            config.riskPolicyId,
            "AUTO_EXECUTE",
            "60s-intent",
            "90s-session",
            "15bps"
        ].joined(separator: "|")
        let session = try await backend.activateLiveTradingSession(
            ActivateLiveTradingSessionRequest(
                brokerConnectionId: connectionId,
                provider: provider,
                deviceId: deviceId,
                configVersion: config.version,
                riskPolicyVersion: config.riskPolicyId,
                confirmationDigest: Self.sha256(disclosure),
                appSessionId: UUID().uuidString.lowercased()
            ),
            accessToken: accessToken
        )
        var runtime = liveTradingRuntimeByConnection[connectionId]
            ?? LiveTradingRuntimeState()
        runtime.session = session
        runtime.statusMessage = "自动提交会话已激活"
        liveTradingRuntimeByConnection[connectionId] = runtime
        return session
    }

    private func renewTradingRuntimeIfNeeded(
        session: LiveTradingSession,
        connectionId: String,
        deviceId: String,
        accessToken: String
    ) async throws {
        _ = try await ensureTradingLease(
            connectionId: connectionId,
            deviceId: deviceId,
            accessToken: accessToken
        )
        guard Self.secondsRemaining(session.expiresAt) <= 35 else { return }
        let renewed = try await backend.renewLiveTradingSession(
            sessionId: session.sessionId,
            accessToken: accessToken
        )
        var runtime = liveTradingRuntimeByConnection[connectionId] ?? LiveTradingRuntimeState()
        runtime.session = renewed
        liveTradingRuntimeByConnection[connectionId] = runtime
    }

    private func brokerForProvider(_ provider: String) -> any LiveOrderBrokerClient {
        provider == "LONGBRIDGE" ? longbridgeBroker : broker
    }

    private func accountForProvider(_ provider: String) -> AccountSummary? {
        provider == "LONGBRIDGE" ? longbridgeAccount : account
    }

    private func isBrokerConnected(_ provider: String) -> Bool {
        provider == "LONGBRIDGE"
            ? longbridgeBroker.connectionState == .connected
            : broker.connectionState == .connected
    }

    private func setLiveTradingStatus(_ message: String, connectionId: String? = nil) {
        guard let target = connectionId ?? currentBrokerConnectionId else { return }
        var runtime = liveTradingRuntimeByConnection[target] ?? LiveTradingRuntimeState()
        runtime.statusMessage = message
        liveTradingRuntimeByConnection[target] = runtime
    }

    private static func isManagedOrder(_ order: PendingLiveOrder) -> Bool {
        [
            "CLAIMED", "SUBMITTING", "SUBMITTED", "TRACKING", "PARTIALLY_FILLED",
            "CANCEL_REQUESTED", "CANCEL_PENDING", "CANCEL_UNCERTAIN", "UNKNOWN"
        ].contains(order.state)
    }

    private static func isFutuRateLimitError(_ error: Error) -> Bool {
        let message = error.localizedDescription.lowercased()
        return message.contains("high frequency")
            || message.contains("maximum 10 times per 30 seconds")
            || message.contains("限频")
    }

    private func autoSubmitPreferenceScope(
        accessToken: String,
        provider: String
    ) -> AutoSubmitPreferenceScope {
        AutoSubmitPreferenceScope(
            backend: Self.sha256(backendEnvironment.baseURL.absoluteString),
            user: providerPoolCacheNamespace(accessToken: accessToken),
            provider: provider
        )
    }

    private func saveAutoSubmitPreference(_ enabled: Bool, provider: String) {
        guard let accessToken = authenticationSession?.accessToken else { return }
        autoSubmitPreferences.set(
            enabled,
            for: autoSubmitPreferenceScope(
                accessToken: accessToken,
                provider: provider
            )
        )
    }

    private static func secondsRemaining(_ value: String) -> TimeInterval {
        isoDate(value)?.timeIntervalSinceNow ?? 0
    }

    private static func isoDate(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value)
            ?? ISO8601DateFormatter().date(from: value)
    }

    private static func sha256(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }

    private static func accessTokenIdentity(
        _ token: String
    ) throws -> (userId: String, deviceId: String) {
        let parts = token.split(separator: ".")
        guard parts.count == 3 else {
            throw LiveOrderCoordinatorError.tokenClaimsInvalid
        }
        var payload = String(parts[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        if payload.count % 4 != 0 {
            payload.append(String(repeating: "=", count: 4 - payload.count % 4))
        }
        guard let data = Data(base64Encoded: payload),
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let userId = object["sub"] as? String,
              let deviceId = object["device_id"] as? String else {
            throw LiveOrderCoordinatorError.tokenClaimsInvalid
        }
        return (userId, deviceId)
    }

    func enableShadowTrading() async {
        let provider = platform == .longbridge ? "LONGBRIDGE" : "FUTU"
        guard let connectionId = currentBrokerConnectionId,
              let accessToken = authenticationSession?.accessToken else {
            setShadowRuntimeStatus("\(provider == "FUTU" ? "Futu" : "Longbridge") 账户尚未接入")
            return
        }
        if tradingConfigurations[connectionId] == nil {
            guard let catalog = tradingCatalogs[connectionId] else {
                setShadowRuntimeStatus("交易目录尚未加载", for: connectionId)
                return
            }
            setShadowRuntimeStatus("初始化影子评估配置", for: connectionId)
            do {
                let input = try SaveTradingConfigurationRequest.shadowDefault(
                    catalog: catalog,
                    provider: provider
                )
                tradingConfigurations[connectionId] = try await backend
                    .saveTradingConfiguration(
                        brokerConnectionId: connectionId,
                        input: input,
                        accessToken: accessToken
                    )
            } catch {
                setShadowRuntimeStatus(
                    "配置初始化失败：\(error.localizedDescription)",
                    for: connectionId
                )
                return
            }
        }
        startShadowTrading(connectionId: connectionId, provider: provider)
    }

    func startShadowTrading() {
        guard let connectionId = currentBrokerConnectionId else { return }
        let provider = platform == .longbridge ? "LONGBRIDGE" : "FUTU"
        startShadowTrading(connectionId: connectionId, provider: provider)
    }

    private func startShadowTrading(connectionId: String, provider: String) {
        guard shadowTradingTasks[connectionId] == nil,
              tradingConfigurations[connectionId] != nil else { return }
        setShadowRuntimeRunning(true, for: connectionId)
        setShadowRuntimeStatus("等待运行", for: connectionId)
        shadowTradingTasks[connectionId] = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                await self.runShadowTradingOnce(
                    connectionId: connectionId,
                    provider: provider
                )
                guard !Task.isCancelled else { break }
                let interval = self.tradingConfigurations[connectionId]?
                    .scanIntervalSeconds ?? 60
                try? await Task.sleep(for: .seconds(interval))
            }
        }
    }

    func stopShadowTrading() {
        guard let connectionId = currentBrokerConnectionId else { return }
        stopShadowTrading(connectionId: connectionId, status: "已停止")
    }

    func runShadowTradingOnce() async {
        let provider = platform == .longbridge ? "LONGBRIDGE" : "FUTU"
        guard let connectionId = currentBrokerConnectionId else {
            setShadowRuntimeStatus("券商账户尚未接入")
            return
        }
        await runShadowTradingOnce(connectionId: connectionId, provider: provider)
    }

    private func runShadowTradingOnce(connectionId: String, provider: String) async {
        guard shadowRuntimeByConnection[connectionId]?.isEvaluating != true else {
            setShadowRuntimeStatus("上一轮仍在评估，请等待完成", for: connectionId)
            return
        }
        setShadowEvaluationInFlight(true, for: connectionId)
        defer { setShadowEvaluationInFlight(false, for: connectionId) }
        guard let config = tradingConfigurations[connectionId],
              providerPoolOnlineValidated,
              let pool = providerPools[provider],
              pool.entitlement.active,
              !pool.items.isEmpty,
              authenticationSession != nil else {
            setShadowRuntimeStatus("配置或研究池不可用", for: connectionId)
            return
        }
        setShadowRuntimeStatus("刷新券商快照", for: connectionId)
        guard await refreshSnapshotForShadowEvaluation(provider: provider) else {
            setShadowRuntimeStatus(
                "券商快照未刷新或已超过 5 秒，本轮未发送模型请求",
                for: connectionId
            )
            return
        }
        if let accessToken = authenticationSession?.accessToken {
            await refreshShadowHistory(connectionId: connectionId, accessToken: accessToken)
        }
        let accountSnapshot = provider == "LONGBRIDGE" ? longbridgeAccount : account
        let marketSnapshot = provider == "LONGBRIDGE" ? longbridgeMarket : market
        guard let account = accountSnapshot, let market = marketSnapshot else {
            setShadowRuntimeStatus("券商快照不可用", for: connectionId)
            return
        }
        let readinessItems = pool.items.map {
            shadowEvaluationItem(for: $0, fallback: market, provider: provider)
        }
        setShadowEvaluationItems(readinessItems, for: connectionId)
        let readySymbols = Set(
            readinessItems
                .filter { $0.state == .active }
                .map(\.symbol)
        )
        let evaluationItems = pool.items.filter {
            readySymbols.contains($0.canonicalSymbol)
        }
        guard !evaluationItems.isEmpty else {
            setShadowLastRunAt(Date(), for: connectionId)
            setShadowRuntimeStatus(
                "等待下一轮 · 可评估 0 个，等待 \(readinessItems.count) 个",
                for: connectionId
            )
            return
        }

        do {
            let identity = try credentials.deviceIdentity(for: backendEnvironment)
            let evaluationSymbols = evaluationItems.map(\.canonicalSymbol)
            guard let requestAccessToken = authenticationSession?.accessToken else {
                throw BackendClientError.authenticationRejected
            }
            let concurrency = evaluationSymbols.count
            setShadowRuntimeStatus(
                "并发分析 \(evaluationSymbols.count) 个标的 · 并发 \(concurrency)",
                for: connectionId
            )
            let backendClient = backend
            var taskResults: [ShadowEvaluationTaskResult] = []
            await withTaskGroup(of: ShadowEvaluationTaskResult.self) { group in
                var nextIndex = 0
                func addNext() {
                    guard nextIndex < evaluationSymbols.count else { return }
                    let symbol = evaluationSymbols[nextIndex]
                    nextIndex += 1
                    group.addTask {
                        do {
                            let context = try await self.makeSingleDecisionContext(
                                symbol: symbol,
                                identity: identity,
                                connectionId: connectionId,
                                provider: provider,
                                account: account,
                                market: market,
                                poolVersion: pool.version,
                                config: config
                            )
                            _ = try await backendClient.runModel(
                                context: context,
                                userMessage: nil,
                                modelRoute: "OFFICIAL",
                                accessToken: requestAccessToken
                            )
                            return ShadowEvaluationTaskResult(
                                symbol: symbol,
                                errorCode: nil,
                                reason: nil
                            )
                        } catch BackendClientError.authenticationRejected {
                            return ShadowEvaluationTaskResult(
                                symbol: symbol,
                                errorCode: "AUTHENTICATION_REJECTED",
                                reason: "登录状态已失效"
                            )
                        } catch BackendClientError.modelRunFailed(let code) {
                            return ShadowEvaluationTaskResult(
                                symbol: symbol,
                                errorCode: code,
                                reason: nil
                            )
                        } catch {
                            return ShadowEvaluationTaskResult(
                                symbol: symbol,
                                errorCode: "REQUEST_FAILED",
                                reason: error.localizedDescription
                            )
                        }
                    }
                }
                for _ in 0..<concurrency {
                    addNext()
                }
                while let result = await group.next() {
                    taskResults.append(result)
                    addNext()
                }
            }
            if taskResults.contains(where: { $0.errorCode == "AUTHENTICATION_REJECTED" }) {
                throw BackendClientError.authenticationRejected
            }
            applyShadowEvaluationResults(taskResults, for: connectionId)

            guard let historyAccessToken = authenticationSession?.accessToken else {
                throw BackendClientError.authenticationRejected
            }
            await refreshShadowHistory(connectionId: connectionId, accessToken: historyAccessToken)
            let activeCandidates = shadowHistory(for: connectionId).candidates.filter {
                ($0.status == "PENDING" || $0.status == "WATCH")
                    && ISO8601DateFormatter().date(from: $0.expiresAt).map { $0 > Date() } != false
            }
            let evaluableSymbols = Set(evaluationItems.map(\.canonicalSymbol))
            let evaluableCandidates = activeCandidates.filter {
                evaluableSymbols.contains($0.symbol)
            }
            if config.executionMode == "CANDIDATE_POOL", !evaluableCandidates.isEmpty {
                let symbols = Array(Set(evaluableCandidates.map(\.symbol))).sorted()
                contextSequence += 1
                setShadowRuntimeStatus("组合裁决", for: connectionId)
                let context = try ContextEnvelopeFactory.makeTrading(
                    deviceId: identity.deviceId,
                    brokerConnectionId: connectionId,
                    provider: provider,
                    purpose: "PORTFOLIO_REVIEW",
                    sequence: contextSequence,
                    snapshot: contextSnapshot(
                        account: account,
                        market: market,
                        capabilities: [],
                        requestedSymbols: symbols,
                        provider: provider,
                        config: config
                    ),
                    researchPoolVersion: pool.version,
                    tradingConfigVersion: config.version,
                    catalogVersion: config.catalogVersion,
                    requestedSymbols: symbols,
                    clientPolicyVersion: "macos-shadow-v2",
                    devicePrivateKey: identity.privateKey
                )
                guard let portfolioAccessToken = authenticationSession?.accessToken else {
                    throw BackendClientError.authenticationRejected
                }
                _ = try await backend.runModel(
                    context: context,
                    userMessage: nil,
                    modelRoute: "OFFICIAL",
                    accessToken: portfolioAccessToken
                )
                guard let refreshAccessToken = authenticationSession?.accessToken else {
                    throw BackendClientError.authenticationRejected
                }
                await refreshShadowHistory(
                    connectionId: connectionId,
                    accessToken: refreshAccessToken
                )
            }
            setShadowLastRunAt(Date(), for: connectionId)
            let skipped = pool.items.count - evaluationItems.count
            let succeeded = taskResults.filter { $0.errorCode == nil }.count
            let failed = taskResults.count - succeeded
            let summary = "已完成 \(succeeded) 个"
                + (skipped > 0 ? "，等待 \(skipped) 个" : "")
                + (failed > 0 ? "，\(failed) 个将在后续轮次重试" : "")
            let isRunning = shadowRuntimeByConnection[connectionId]?.isRunning ?? false
            setShadowRuntimeStatus(
                isRunning ? "等待下一轮 · \(summary)" : "单次运行完成 · \(summary)",
                for: connectionId
            )
        } catch is CancellationError {
            setShadowRuntimeStatus("已停止", for: connectionId)
        } catch BackendClientError.authenticationRejected {
            stopShadowTrading(
                connectionId: connectionId,
                status: "登录状态已失效，量化评估已停止"
            )
        } catch {
            setShadowRuntimeStatus(
                "运行失败：\(error.localizedDescription)",
                for: connectionId
            )
        }
    }

    private func refreshSnapshotForShadowEvaluation(provider: String) async -> Bool {
        if provider == "LONGBRIDGE" {
            await refreshLongbridgeData()
        } else {
            await refreshBrokerData(force: true)
        }

        let deadline = Date().addingTimeInterval(60)
        while (provider == "LONGBRIDGE" ? isRefreshingLongbridge : isRefreshingBroker) {
            guard Date() < deadline else { return false }
            do {
                try await Task.sleep(for: .milliseconds(100))
            } catch {
                return false
            }
        }
        let sourceAt = provider == "LONGBRIDGE"
            ? longbridgeLastUpdatedAt
            : brokerLastUpdatedAt
        return LiveTradingBrokerRefreshPolicy.isExecutableSnapshotFresh(
            updatedAt: sourceAt
        )
    }

    private func setShadowRuntimeStatus(_ status: String, for connectionId: String? = nil) {
        guard let connectionId else {
            shadowRuntimeFallbackStatus = status
            return
        }
        var runtime = shadowRuntimeByConnection[connectionId] ?? ShadowRuntimeState()
        runtime.status = status
        shadowRuntimeByConnection[connectionId] = runtime
    }

    private func setShadowRuntimeRunning(_ isRunning: Bool, for connectionId: String) {
        var runtime = shadowRuntimeByConnection[connectionId] ?? ShadowRuntimeState()
        runtime.isRunning = isRunning
        shadowRuntimeByConnection[connectionId] = runtime
    }

    private func setShadowLastRunAt(_ date: Date, for connectionId: String) {
        var runtime = shadowRuntimeByConnection[connectionId] ?? ShadowRuntimeState()
        runtime.lastRunAt = date
        shadowRuntimeByConnection[connectionId] = runtime
    }

    private func setShadowEvaluationInFlight(_ isEvaluating: Bool, for connectionId: String) {
        var runtime = shadowRuntimeByConnection[connectionId] ?? ShadowRuntimeState()
        runtime.isEvaluating = isEvaluating
        shadowRuntimeByConnection[connectionId] = runtime
    }

    private func stopShadowTrading(connectionId: String, status: String) {
        shadowTradingTasks[connectionId]?.cancel()
        shadowTradingTasks[connectionId] = nil
        setShadowRuntimeRunning(false, for: connectionId)
        setShadowRuntimeStatus(status, for: connectionId)
    }

    private func makeSingleDecisionContext(
        symbol: String,
        identity: DeviceIdentity,
        connectionId: String,
        provider: String,
        account: AccountSummary,
        market: MarketSummary,
        poolVersion: Int,
        config: TradingConfiguration
    ) throws -> ContextEnvelope {
        contextSequence += 1
        let context = try ContextEnvelopeFactory.makeTrading(
            deviceId: identity.deviceId,
            brokerConnectionId: connectionId,
            provider: provider,
            purpose: "SINGLE_DECISION",
            sequence: contextSequence,
            snapshot: contextSnapshot(
                account: account,
                market: market,
                capabilities: [],
                requestedSymbols: [symbol],
                provider: provider,
                config: config
            ),
            researchPoolVersion: poolVersion,
            tradingConfigVersion: config.version,
            catalogVersion: config.catalogVersion,
            requestedSymbols: [symbol],
            clientPolicyVersion: "macos-shadow-v5-just-in-time-context",
            devicePrivateKey: identity.privateKey
        )
        return context
    }

    private func marketEvaluationDecision(
        for item: ProviderPoolItem,
        fallback market: MarketSummary,
        provider: String
    ) -> QuantEvaluationMarketDecision {
        let providerQuotes = provider == "LONGBRIDGE" ? longbridgeQuotes : quotes
        let quoteState = providerQuotes.first {
            $0.symbol == item.canonicalSymbol || $0.symbol == item.providerSymbol
        }?.marketState
        let fallbackMatches: Bool
        switch item.market {
        case .us:
            fallbackMatches = market.name == "美股" || market.name.uppercased() == "US"
        case .hk:
            fallbackMatches = market.name == "港股" || market.name.uppercased() == "HK"
        case .cn:
            fallbackMatches = market.name == "A 股" || market.name.uppercased() == "CN"
        case .sg:
            fallbackMatches = market.name == "新加坡" || market.name.uppercased() == "SG"
        }
        return QuantEvaluationMarketGate.decide(
            market: item.market,
            marketState: quoteState ?? (fallbackMatches ? market.state : nil)
        )
    }

    private func shadowEvaluationItem(
        for item: ProviderPoolItem,
        fallback market: MarketSummary,
        provider: String
    ) -> ShadowEvaluationItem {
        let providerQuotes = provider == "LONGBRIDGE" ? longbridgeQuotes : quotes
        let providerBars = provider == "LONGBRIDGE" ? longbridgeMinuteBars : minuteBars
        let canonicalSymbol = BrokerSymbolNormalizer.normalize(item.canonicalSymbol)
        let providerSymbol = BrokerSymbolNormalizer.normalize(item.providerSymbol)
        let quote = providerQuotes.first {
            let symbol = BrokerSymbolNormalizer.normalize($0.symbol)
            return symbol == canonicalSymbol || symbol == providerSymbol
        }
        let barCount = providerBars.filter {
            let symbol = BrokerSymbolNormalizer.normalize($0.symbol)
            return symbol == canonicalSymbol || symbol == providerSymbol
        }.count
        let fallbackMatches: Bool
        switch item.market {
        case .us:
            fallbackMatches = market.name == "美股" || market.name.uppercased() == "US"
        case .hk:
            fallbackMatches = market.name == "港股" || market.name.uppercased() == "HK"
        case .cn:
            fallbackMatches = market.name == "A 股" || market.name.uppercased() == "CN"
        case .sg:
            fallbackMatches = market.name == "新加坡" || market.name.uppercased() == "SG"
        }
        let marketState = quote?.marketState ?? (fallbackMatches ? market.state : nil)
        let readiness = QuantEvaluationReadiness.decide(
            market: item.market,
            marketState: marketState,
            hasQuote: quote != nil,
            minuteBarCount: barCount
        )
        let marketLabel: String
        switch item.market {
        case .us: marketLabel = "美股"
        case .hk: marketLabel = "港股"
        case .cn: marketLabel = "A 股"
        case .sg: marketLabel = "新加坡"
        }
        let sourceAt = provider == "LONGBRIDGE"
            ? longbridgeLastUpdatedAt
            : brokerLastUpdatedAt
        let quoteIsFresh = quote.map {
            if let updateTime = $0.updateTime {
                return BrokerTimestampNormalizer.isFresh(
                    updateTime,
                    symbol: $0.symbol,
                    maximumAge: LiveTradingBrokerRefreshPolicy
                        .executableSnapshotMaximumAge
                )
            }
            return LiveTradingBrokerRefreshPolicy.isExecutableSnapshotFresh(
                updatedAt: sourceAt
            )
        } ?? false
        return ShadowEvaluationItem(
            symbol: item.canonicalSymbol,
            market: marketLabel,
            marketState: readiness.sessionLabel ?? marketState ?? "状态不可用",
            state: readiness.shouldEvaluate && quoteIsFresh ? .active : .waiting,
            reason: readiness.shouldEvaluate && !quoteIsFresh
                ? "行情时间已超过 5 秒，等待刷新"
                : readiness.reason
        )
    }

    private func setShadowEvaluationItems(
        _ items: [ShadowEvaluationItem],
        for connectionId: String
    ) {
        var runtime = shadowRuntimeByConnection[connectionId] ?? ShadowRuntimeState()
        runtime.evaluationItems = items
        runtime.evaluationUpdatedAt = Date()
        shadowRuntimeByConnection[connectionId] = runtime
    }

    private func applyShadowEvaluationResults(
        _ results: [ShadowEvaluationTaskResult],
        for connectionId: String
    ) {
        let resultBySymbol = Dictionary(uniqueKeysWithValues: results.map { ($0.symbol, $0) })
        let running = shadowRuntimeByConnection[connectionId]?.isRunning ?? false
        let updated = (shadowRuntimeByConnection[connectionId]?.evaluationItems ?? []).map { item in
            guard let result = resultBySymbol[item.symbol] else { return item }
            guard let code = result.errorCode else {
                return ShadowEvaluationItem(
                    symbol: item.symbol,
                    market: item.market,
                    marketState: item.marketState,
                    state: .active,
                    reason: "本轮评估已完成"
                )
            }
            let retrySuffix = running ? "，将在下一轮自动重试" : "，可再次运行评估"
            let waitingCodes = Set(["CONTEXT_EXPIRED", "CONTEXT_CLOCK_SKEW"])
            let reason: String
            if code == "CONTEXT_EXPIRED" {
                reason = "上下文在请求前已过期\(retrySuffix)"
            } else if code == "CONTEXT_CLOCK_SKEW" {
                reason = "本机与服务端时间暂未对齐\(retrySuffix)"
            } else {
                reason = (result.reason ?? "评估未完成（\(code)）") + retrySuffix
            }
            return ShadowEvaluationItem(
                symbol: item.symbol,
                market: item.market,
                marketState: item.marketState,
                state: waitingCodes.contains(code) ? .waiting : .error,
                reason: reason
            )
        }
        setShadowEvaluationItems(updated, for: connectionId)
    }

    func showPreviousModelRunPage() async {
        guard let connectionId = currentBrokerConnectionId,
              shadowHistory(for: connectionId).modelRunPage > 1,
              let accessToken = authenticationSession?.accessToken else { return }
        var history = shadowHistory(for: connectionId)
        history.modelRunPage -= 1
        shadowHistoryByConnection[connectionId] = history
        await refreshShadowHistory(connectionId: connectionId, accessToken: accessToken)
    }

    func showNextModelRunPage() async {
        guard let connectionId = currentBrokerConnectionId,
              let accessToken = authenticationSession?.accessToken else { return }
        var history = shadowHistory(for: connectionId)
        let pageCount = max(
            1,
            (history.modelRunTotal + shadowModelRunPageSize - 1) / shadowModelRunPageSize
        )
        guard history.modelRunPage < pageCount else { return }
        history.modelRunPage += 1
        shadowHistoryByConnection[connectionId] = history
        await refreshShadowHistory(connectionId: connectionId, accessToken: accessToken)
    }

    private func refreshShadowHistory(connectionId: String, accessToken: String) async {
        let requestedPage = shadowHistory(for: connectionId).modelRunPage
        do {
            async let runs = backend.modelRuns(
                brokerConnectionId: connectionId,
                limit: shadowModelRunPageSize,
                offset: (requestedPage - 1) * shadowModelRunPageSize,
                accessToken: accessToken
            )
            async let signals = backend.tradingSignals(
                brokerConnectionId: connectionId,
                accessToken: accessToken
            )
            async let candidates = backend.tradingCandidates(
                brokerConnectionId: connectionId,
                accessToken: accessToken
            )
            let runPage = try await runs
            let signalItems = try await signals
            let candidateItems = try await candidates
            guard runPage.items.allSatisfy({ $0.brokerConnectionId == connectionId }),
                  signalItems.allSatisfy({ $0.brokerConnectionId == connectionId }),
                  candidateItems.allSatisfy({ $0.brokerConnectionId == connectionId }) else {
                throw BackendClientError.serviceRejected("BROKER_HISTORY_MISMATCH")
            }
            var history = shadowHistory(for: connectionId)
            guard history.modelRunPage == requestedPage else { return }
            history.modelRuns = runPage.items
            history.modelRunTotal = runPage.total
            history.signals = signalItems
            history.candidates = candidateItems
            shadowHistoryByConnection[connectionId] = history
        } catch {
            setShadowRuntimeStatus(
                "历史同步失败：\(error.localizedDescription)",
                for: connectionId
            )
        }
    }

    private var currentShadowHistory: ShadowHistoryState {
        guard let connectionId = currentBrokerConnectionId else {
            return ShadowHistoryState()
        }
        return shadowHistory(for: connectionId)
    }

    private func shadowHistory(for connectionId: String) -> ShadowHistoryState {
        shadowHistoryByConnection[connectionId] ?? ShadowHistoryState()
    }

    private func contextSnapshot(
        account: AccountSummary,
        market: MarketSummary,
        capabilities: [ConversationCapability],
        requestedSymbols: [String]? = nil,
        provider: String,
        config: TradingConfiguration?
    ) -> ContextSnapshot {
        let accountHash = SHA256.hash(data: Data(account.accountId.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
        let requestedSymbolSet = requestedSymbols.flatMap { symbols in
            symbols.isEmpty ? nil : Set(symbols)
        }
        let isLongbridge = provider == "LONGBRIDGE"
        let snapshotPositions = isLongbridge ? longbridgePositions : positions
        let snapshotQuotes = isLongbridge ? longbridgeQuotes : quotes
        let snapshotMinuteBars = isLongbridge ? longbridgeMinuteBars : minuteBars
        let snapshotTickerPoints = isLongbridge ? longbridgeTickerPoints : tickerPoints
        let snapshotOrderBooks = isLongbridge ? longbridgeOrderBooks : orderBooks
        let snapshotOpenOrders = isLongbridge ? longbridgeOpenOrders : openOrders
        let snapshotRecentDeals = isLongbridge ? longbridgeRecentDeals : recentDeals
        let snapshotDataGapSource = isLongbridge ? longbridgeDataGaps : brokerDataGaps
        let snapshotSourceAt = isLongbridge ? longbridgeLastUpdatedAt : brokerLastUpdatedAt
        let snapshotMarketIntelligence = isLongbridge ? MarketIntelligenceSnapshot(
            providerId: "LONGBRIDGE",
            fetchedAt: ISO8601DateFormatter().string(from: Date()),
            sections: MarketEventGroup.allCases.map {
                MarketIntelligenceSection(
                    group: $0,
                    availability: .providerUnsupported,
                    message: "Longbridge 市场情报接口尚未接入"
                )
            }
        ) : marketIntelligence
        let positionValues = snapshotPositions.map { position in
            let market = position.symbol.hasPrefix("HK.") ? "HK" : "US"
            let side = position.quantity < 0 ? "SHORT" : "LONG"
            let absoluteQuantity = abs(position.quantity)
            return JSONValue.object([
                "symbol": .string(position.symbol),
                "market": .string(market),
                "side": .string(side),
                "quantity": .string(absoluteQuantity.description),
                "availableQuantity": .string(absoluteQuantity.description),
                "costPrice": position.costPrice.map { .string($0.description) } ?? .null,
                "lastPrice": position.lastPrice.map { .string($0.description) } ?? .null,
                "currency": .string(position.currency)
            ])
        }
        let quoteValues = snapshotQuotes.filter { quote in
            requestedSymbolSet?.contains(quote.symbol) ?? true
        }.map { quote in
            let sourceAt = BrokerTimestampNormalizer.iso8601UTC(
                from: quote.updateTime,
                symbol: quote.symbol
            ) ?? quote.updateTime ?? ISO8601DateFormatter().string(
                from: snapshotSourceAt ?? Date()
            )
            return JSONValue.object([
                "symbol": .string(quote.symbol),
                "market": .string(quote.symbol.hasPrefix("HK.") ? "HK" : "US"),
                "sourceAt": .string(sourceAt),
                "lastPrice": .string(quote.lastPrice.description),
                "bidPrice": quote.bidPrice.map { .string($0.description) } ?? .null,
                "askPrice": quote.askPrice.map { .string($0.description) } ?? .null,
                "lotSize": quote.lotSize.map { .number(Decimal($0)) } ?? .null,
                "shortable": quote.shortable.map(JSONValue.bool) ?? .null,
                "maxShortQuantity": quote.maxShortQuantity.map {
                    .string($0.description)
                } ?? .null
            ])
        }
        let barValues = snapshotMinuteBars.filter { bar in
            requestedSymbolSet?.contains(bar.symbol) ?? true
        }.map { bar in
            JSONValue.object([
                "symbol": .string(bar.symbol),
                "time": .string(bar.time),
                "open": .string(bar.open.description),
                "high": .string(bar.high.description),
                "low": .string(bar.low.description),
                "close": .string(bar.close.description),
                "volume": .string(bar.volume.description),
                "turnover": bar.turnover.map { .string($0.description) } ?? .null
            ])
        }
        let tickerValues = snapshotTickerPoints.filter { ticker in
            requestedSymbolSet?.contains(ticker.symbol) ?? true
        }.map { ticker in
            JSONValue.object([
                "symbol": .string(ticker.symbol),
                "time": .string(ticker.time),
                "sequence": .string(String(ticker.sequence)),
                "price": .string(ticker.price.description),
                "volume": .string(ticker.volume.description),
                "direction": .number(Decimal(ticker.direction))
            ])
        }
        let orderBookValues = snapshotOrderBooks.filter { book in
            requestedSymbolSet?.contains(book.symbol) ?? true
        }.map { book in
            JSONValue.object([
                "symbol": .string(book.symbol),
                "asks": .array(book.asks.map(orderBookLevelValue)),
                "bids": .array(book.bids.map(orderBookLevelValue))
            ])
        }
        let orderValues = snapshotOpenOrders.map(orderValue)
        let dealValues = snapshotRecentDeals.map(dealValue)
        let activeProviderPool = providerPools[provider]
        let allPoolSymbols = activeProviderPool?.items.map(\.canonicalSymbol)
            ?? researchPool.map(\.symbol)
        let selectedSymbols = requestedSymbols ?? conversationResearchSymbols.sorted()
        let serverPoolSymbols = requestedSymbols == nil
            ? Array(allPoolSymbols.prefix(100))
            : selectedSymbols
        let entitlementStatus = activeProviderPool?.entitlement.active == true
            ? "active"
            : researchPoolEntitlement.status.rawValue
        let entitlementName = currentSubscription?.planName ?? researchPoolEntitlement.planName
        let poolLimit = activeProviderPool?.entitlement.capacity ?? researchPoolEntitlement.poolLimit
        let depthLimitedGap = "K 线、盘口与逐笔仅加载前 8 个优先标的"
        let depthLoadedSymbols = Set(allPoolSymbols.prefix(8))
        let snapshotDataGaps = snapshotDataGapSource.filter { gap in
            guard gap == depthLimitedGap, let requestedSymbolSet else { return true }
            return !requestedSymbolSet.isSubset(of: depthLoadedSymbols)
        }
        var accountValue: [String: JSONValue] = [
                "accountIdHash": .string(accountHash),
                "broker": .string(provider),
                "environment": .string(account.environment),
                "totalAssets": .object([
                    "value": .string(account.totalAssets.description),
                    "currency": .string(account.currency)
                ]),
                "cash": .object([
                    "value": .string(account.cash.description),
                    "currency": .string(account.currency)
                ]),
                "buyingPower": .object([
                    "value": .string(account.buyingPower.description),
                    "currency": .string(account.currency)
                ])
            ]
        accountValue["marginAccount"] = account.marginAccount.map(JSONValue.bool) ?? .null
        accountValue["marginCallActive"] = account.marginCallActive.map(JSONValue.bool) ?? .null
        accountValue["shortRiskDisclosureAccepted"] =
            account.shortRiskDisclosureAccepted.map(JSONValue.bool) ?? .null
        return ContextSnapshot(
            account: accountValue,
            positions: positionValues,
            marketSessions: [.object([
                "market": .string(market.name),
                "state": .string(market.state),
                "sourceAt": .string(ISO8601DateFormatter().string(
                    from: snapshotSourceAt ?? Date()
                ))
            ])],
            quotes: quoteValues,
            minuteBars: barValues,
            tickerPoints: tickerValues,
            orderBooks: orderBookValues,
            openOrders: orderValues,
            recentDeals: dealValues,
            research: [
                "entitlementStatus": .string(entitlementStatus),
                "planName": entitlementName.map(JSONValue.string) ?? .null,
                "poolLimit": .number(Decimal(poolLimit)),
                "poolSymbols": .array(serverPoolSymbols.map { .string($0) }),
                "conversationSymbols": .array(selectedSymbols.map(JSONValue.string))
            ],
            decisionContext: requestedSymbols.map { symbols in
                DecisionContextBuilder.make(
                    account: account,
                    market: market,
                    positions: snapshotPositions,
                    quotes: snapshotQuotes.filter { symbols.contains($0.symbol) },
                    minuteBars: snapshotMinuteBars.filter { symbols.contains($0.symbol) },
                    tickerPoints: snapshotTickerPoints.filter { symbols.contains($0.symbol) },
                    orderBooks: snapshotOrderBooks.filter { symbols.contains($0.symbol) },
                    openOrders: snapshotOpenOrders,
                    requestedSymbols: symbols,
                    riskPolicyId: config?.riskPolicyId,
                    providerDataGaps: snapshotDataGaps,
                    marketIntelligence: snapshotMarketIntelligence,
                    sourceAt: snapshotSourceAt ?? Date()
                )
            },
            capabilities: capabilities.map { capability in
                .object([
                    "id": .string(capability.id),
                    "kind": .string(capability.kind.rawValue),
                    "title": .string(capability.title),
                    "promptVersion": capability.promptVersion.map(JSONValue.string) ?? .null,
                    "modelProfile": capability.modelProfile
                        .map { .string($0.rawValue) } ?? .null,
                    "toolPolicyVersion": capability.toolPolicyVersion
                        .map(JSONValue.string) ?? .null
                ])
            },
            dataGaps: snapshotDataGaps
        )
    }

    private func restoreResearchModels() {
        for skill in ResearchSkill.allCases {
            let key = Keys.researchModelPrefix + skill.rawValue
            if let raw = defaults.string(forKey: key),
               let model = ResearchModelProfile(rawValue: raw) {
                researchModels[skill] = model
            }
        }
    }

    private func persistResearchPreferences() {
        for skill in ResearchSkill.allCases {
            defaults.set(
                researchModel(for: skill).rawValue,
                forKey: Keys.researchModelPrefix + skill.rawValue
            )
        }
    }

    private func orderBookLevelValue(_ level: OrderBookLevel) -> JSONValue {
        .object([
            "side": .string(level.side),
            "level": .number(Decimal(level.level)),
            "price": .string(level.price.description),
            "volume": .string(level.volume.description),
            "orderCount": level.orderCount.map { .number(Decimal($0)) } ?? .null
        ])
    }

    private func orderValue(_ order: BrokerOrderSummary) -> JSONValue {
        .object([
            "orderId": .string(order.orderId),
            "symbol": .string(order.symbol),
            "name": .string(order.name),
            "side": .number(Decimal(order.side)),
            "status": .number(Decimal(order.status)),
            "quantity": .string(order.quantity.description),
            "price": .string(order.price.description),
            "filledQuantity": .string(order.filledQuantity.description),
            "filledAveragePrice": order.filledAveragePrice.map {
                .string($0.description)
            } ?? .null,
            "createdAt": .string(order.createdAt),
            "updatedAt": .string(order.updatedAt)
        ])
    }

    private func dealValue(_ deal: BrokerFillSummary) -> JSONValue {
        .object([
            "fillId": .string(deal.fillId),
            "orderId": .string(deal.orderId),
            "symbol": .string(deal.symbol),
            "name": .string(deal.name),
            "side": .number(Decimal(deal.side)),
            "quantity": .string(deal.quantity.description),
            "price": .string(deal.price.description),
            "createdAt": .string(deal.createdAt)
        ])
    }

    private func scheduleBrokerRefresh() {
        brokerRefreshTask?.cancel()
        brokerRefreshTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                guard !Task.isCancelled, let self else { return }
                await self.refreshCurrentBrokerData()
            }
        }
    }

    func dismissStartupAd() {
        startupTask?.cancel()
        startupTask = nil
        markStartupAdShown()
        startupAd = nil
        startupAdRemainingSeconds = 0
    }

    private func loadStartupAdIfNeeded() async {
        guard let accessToken = authenticationSession?.accessToken else {
            return
        }
        do {
            guard let config = try await backend.activeAd(
                placement: "startup",
                accessToken: accessToken
            ), !wasStartupAdShown(on: config.serverTime) else { return }
            startupAdServerTime = config.serverTime
            startupAd = config
            startupAdRemainingSeconds = config.durationSeconds
            startupTask = Task { [weak self] in
                guard let self else { return }
                while !Task.isCancelled, self.startupAdRemainingSeconds > 0 {
                    try? await Task.sleep(for: .seconds(1))
                    guard !Task.isCancelled else { return }
                    self.startupAdRemainingSeconds -= 1
                }
                if !Task.isCancelled {
                    self.dismissStartupAd()
                }
            }
        } catch {
            startupAd = nil
            if let backendError = error as? BackendClientError,
               case .authenticationRejected = backendError {
                invalidateAuthentication(message: "登录状态已失效，请重新登录")
            }
        }
    }

    private func wasStartupAdShown(on referenceDate: Date) -> Bool {
        guard let stored = defaults.object(forKey: Keys.startupAdDate) as? Date else { return false }
        return Calendar.current.isDate(stored, inSameDayAs: referenceDate)
    }

    private func markStartupAdShown() {
        defaults.set(startupAdServerTime ?? Date(), forKey: Keys.startupAdDate)
        startupAdServerTime = nil
    }

    private enum Keys {
        static let platform = "workspace.platform"
        static let workspace = "workspace.futu.page"
        static let conversationWidth = "workspace.conversation.width"
        static let researchModelPrefix = "workspace.research.model."
        static let startupAdDate = "ads.startup.lastShownAt"
    }
}
