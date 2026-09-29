import ChangFuDomain
import Foundation

public struct AdConfiguration: Decodable, Sendable {
    public let serverTime: Date
    public let enabled: Bool
    public let placement: String
    public let durationSeconds: Int
    public let campaignId: UUID?
    public let version: Int
    public let localAssetId: String?

    public var isValid: Bool {
        enabled
            && (1...30).contains(durationSeconds)
            && ["startup", "overlay"].contains(placement)
            && ["startup_default", "overlay_default"].contains(localAssetId ?? "")
    }
}

public struct BrokerConnection: Decodable, Sendable {
    public let brokerConnectionId: String
    public let provider: String?
    public let displayName: String?
    public let environment: String
    public let status: String
}

public struct ProviderPoolListFetchResult: Sendable {
    public let items: [ProviderPoolSummary]?
    public let etag: String?
    public let notModified: Bool
}

public struct ProviderPoolPageFetchResult: Sendable {
    public let pool: ProviderPool?
    public let etag: String?
    public let notModified: Bool
}

public struct BackendReadiness: Decodable, Equatable, Sendable {
    public let ok: Bool
    public let database: Bool
    public let worker: Bool
}

public actor BackendClient {
    private let baseURL: URL
    private let session: URLSession
    private let decoder: JSONDecoder

    public init(baseURL: URL, session: URLSession? = nil) {
        self.baseURL = baseURL
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
            self.session = URLSession(configuration: configuration)
        }
        decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
    }

    public func login(_ input: DesktopLoginRequest) async throws -> TokenPair {
        try await sendAuthenticationRequest(path: "/v1/auth/login", body: input)
    }

    public func refresh(refreshToken: String) async throws -> TokenPair {
        try await sendAuthenticationRequest(
            path: "/v1/auth/refresh",
            body: RefreshTokenRequest(refreshToken: refreshToken)
        )
    }

    public func logout(refreshToken: String) async {
        let url = baseURL.appending(path: "/v1/auth/logout")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 5
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(
            RefreshTokenRequest(refreshToken: refreshToken)
        )
        _ = try? await session.data(for: request)
    }

    public func changePassword(
        nextPassword: String,
        accessToken: String
    ) async throws {
        let url = baseURL.appending(path: "/v1/auth/password")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 10
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue(UUID().uuidString.lowercased(), forHTTPHeaderField: "Idempotency-Key")
        request.httpBody = try JSONEncoder().encode(PasswordChangeRequest(
            nextPassword: nextPassword
        ))
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw BackendClientError.requestFailed
        }
        if http.statusCode == 401 {
            throw BackendClientError.authenticationRejected
        }
        guard http.statusCode == 200 else {
            throw responseError(data: data, statusCode: http.statusCode)
        }
    }

    public func readiness() async throws -> BackendReadiness {
        var request = URLRequest(url: baseURL.appending(path: "/v1/ready"))
        request.timeoutInterval = 5
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse,
              http.statusCode == 200 else {
            throw BackendClientError.serviceUnavailable
        }
        let readiness = try decoder.decode(BackendReadiness.self, from: data)
        guard readiness.ok, readiness.database, readiness.worker else {
            throw BackendClientError.serviceUnavailable
        }
        return readiness
    }

    public func cancelAllRequests() {
        session.invalidateAndCancel()
    }

    public func activeAd(placement: String, accessToken: String) async throws -> AdConfiguration? {
        guard var components = URLComponents(
            url: baseURL.appending(path: "/v1/ads/active"),
            resolvingAgainstBaseURL: false
        ) else {
            return nil
        }
        components.queryItems = [URLQueryItem(name: "placement", value: placement)]
        guard let url = components.url else { return nil }

        var request = URLRequest(url: url)
        request.timeoutInterval = 3
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw BackendClientError.requestFailed
        }
        if http.statusCode == 401 {
            throw BackendClientError.authenticationRejected
        }
        guard http.statusCode == 200 else { return nil }
        let config = try decoder.decode(AdConfiguration.self, from: data)
        return config.isValid ? config : nil
    }

    public func runModel(
        context: ContextEnvelope,
        userMessage: String?,
        modelRoute: String? = nil,
        accessToken: String
    ) async throws -> ModelResult {
        let url = baseURL.appending(path: "/v1/model/runs")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 330
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue(UUID().uuidString.lowercased(), forHTTPHeaderField: "Idempotency-Key")

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        request.httpBody = try encoder.encode(ModelRunRequest(
            context: context,
            userMessage: userMessage,
            modelRoute: modelRoute
        ))
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw BackendClientError.requestFailed
        }
        if http.statusCode == 401 {
            throw BackendClientError.authenticationRejected
        }
        guard http.statusCode == 200 else {
            throw BackendClientError.serviceUnavailable
        }
        guard let lines = String(data: data, encoding: .utf8)?
            .split(separator: "\n"), !lines.isEmpty else {
            throw BackendClientError.requestFailed
        }
        var finalResult: ModelResult?
        for line in lines {
            let event = try decoder.decode(ModelRunEvent.self, from: Data(line.utf8))
            if let failure = event.error {
                throw BackendClientError.modelRunFailed(failure.code)
            }
            if let result = event.result {
                finalResult = result
            }
        }
        guard let finalResult else { throw BackendClientError.requestFailed }
        return finalResult
    }

    public func registerFutuConnection(
        accountIdHash: String,
        environment: String,
        accessToken: String
    ) async throws -> BrokerConnection {
        try await registerBrokerConnection(
            provider: "FUTU",
            accountIdHash: accountIdHash,
            environment: environment,
            displayName: environment == "REAL" ? "Futu 实盘账户" : "Futu 模拟账户",
            accessToken: accessToken
        )
    }

    public func registerBrokerConnection(
        provider: String,
        accountIdHash: String,
        environment: String,
        displayName: String,
        accessToken: String
    ) async throws -> BrokerConnection {
        let url = baseURL.appending(path: "/v1/broker-connections")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 10
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue(UUID().uuidString.lowercased(), forHTTPHeaderField: "Idempotency-Key")
        request.httpBody = try JSONEncoder().encode(BrokerConnectionRequest(
            provider: provider,
            accountIdHash: accountIdHash,
            environment: environment,
            displayName: displayName
        ))
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw BackendClientError.requestFailed
        }
        if http.statusCode == 401 {
            throw BackendClientError.authenticationRejected
        }
        guard http.statusCode == 200 else {
            throw BackendClientError.serviceUnavailable
        }
        return try decoder.decode(BrokerConnection.self, from: data)
    }

    public func tradingCatalog(
        brokerConnectionId: String,
        accessToken: String
    ) async throws -> TradingCatalog {
        try await authenticatedGET(
            path: "/v1/trading/catalog",
            query: [URLQueryItem(name: "brokerConnectionId", value: brokerConnectionId)],
            accessToken: accessToken
        )
    }

    public func tradingConfiguration(
        brokerConnectionId: String,
        accessToken: String
    ) async throws -> TradingConfiguration? {
        do {
            return try await authenticatedGET(
                path: "/v1/trading/config",
                query: [URLQueryItem(name: "brokerConnectionId", value: brokerConnectionId)],
                accessToken: accessToken
            )
        } catch BackendClientError.notFound {
            return nil
        }
    }

    public func saveTradingConfiguration(
        brokerConnectionId: String,
        input: SaveTradingConfigurationRequest,
        accessToken: String
    ) async throws -> TradingConfiguration {
        try await authenticatedMutation(
            path: "/v1/trading/config/\(brokerConnectionId)",
            method: "PUT",
            body: input,
            acceptedStatusCodes: [200],
            accessToken: accessToken
        )
    }

    public func researchPool(accessToken: String) async throws -> ServerResearchPool {
        try await authenticatedGET(
            path: "/v1/research/pool",
            query: [],
            accessToken: accessToken
        )
    }

    public func modelRuns(
        brokerConnectionId: String,
        limit: Int = 10,
        offset: Int = 0,
        accessToken: String
    ) async throws -> ModelRunPage {
        try await authenticatedGET(
            path: "/v1/model/runs",
            query: [
                URLQueryItem(name: "brokerConnectionId", value: brokerConnectionId),
                URLQueryItem(name: "limit", value: String(limit)),
                URLQueryItem(name: "offset", value: String(offset))
            ],
            accessToken: accessToken
        )
    }

    public func tradingSignals(
        brokerConnectionId: String,
        accessToken: String
    ) async throws -> [TradingSignal] {
        let response: ItemList<TradingSignal> = try await authenticatedGET(
            path: "/v1/signals",
            query: [
                URLQueryItem(name: "brokerConnectionId", value: brokerConnectionId),
                URLQueryItem(name: "limit", value: "100")
            ],
            accessToken: accessToken
        )
        return response.items
    }

    public func tradingCandidates(
        brokerConnectionId: String,
        accessToken: String
    ) async throws -> [TradingCandidate] {
        let response: ItemList<TradingCandidate> = try await authenticatedGET(
            path: "/v1/candidates",
            query: [
                URLQueryItem(name: "brokerConnectionId", value: brokerConnectionId),
                URLQueryItem(name: "limit", value: "100")
            ],
            accessToken: accessToken
        )
        return response.items
    }

    public func subscriptionCatalog(accessToken: String) async throws -> SubscriptionCatalog {
        try await authenticatedGET(
            path: "/v1/subscription/catalog",
            query: [],
            accessToken: accessToken
        )
    }

    public func currentSubscription(
        accessToken: String
    ) async throws -> UserSubscription? {
        let response: SubscriptionCurrentEnvelope = try await authenticatedGET(
            path: "/v1/subscription/current",
            query: [],
            accessToken: accessToken
        )
        return response.subscription
    }

    public func thirdPartyModelConfiguration(
        accessToken: String
    ) async throws -> ThirdPartyModelConfigurationEnvelope {
        try await authenticatedGET(
            path: "/v1/model-provider/config",
            query: [],
            accessToken: accessToken
        )
    }

    public func saveThirdPartyModelConfiguration(
        _ input: SaveThirdPartyModelConfigurationRequest,
        accessToken: String
    ) async throws -> ThirdPartyModelConfigurationEnvelope {
        try await authenticatedMutation(
            path: "/v1/model-provider/config",
            method: "PUT",
            body: input,
            acceptedStatusCodes: [200],
            accessToken: accessToken
        )
    }

    public func deleteThirdPartyModelConfiguration(
        accessToken: String
    ) async throws -> ThirdPartyModelConfigurationEnvelope {
        try await authenticatedMutation(
            path: "/v1/model-provider/config",
            method: "DELETE",
            body: EmptyRequest(),
            acceptedStatusCodes: [200],
            accessToken: accessToken
        )
    }

    public func createSubscriptionOrder(
        _ input: CreateSubscriptionOrderRequest,
        accessToken: String
    ) async throws -> SubscriptionOrder {
        try await authenticatedMutation(
            path: "/v1/subscription/orders",
            method: "POST",
            body: input,
            acceptedStatusCodes: [201],
            accessToken: accessToken
        )
    }

    public func subscriptionOrder(
        orderId: String,
        accessToken: String
    ) async throws -> SubscriptionOrder {
        try await authenticatedGET(
            path: "/v1/subscription/orders/\(orderId)",
            query: [],
            accessToken: accessToken
        )
    }

    public func startSubscriptionPayment(
        orderId: String,
        channel: SubscriptionPaymentChannel,
        accessToken: String
    ) async throws -> SubscriptionOrder {
        try await authenticatedMutation(
            path: "/v1/subscription/orders/\(orderId)/payment",
            method: "POST",
            body: StartSubscriptionPaymentRequest(channel: channel),
            acceptedStatusCodes: [200],
            accessToken: accessToken
        )
    }

    public func scheduleSubscriptionChange(
        _ input: ScheduleSubscriptionChangeRequest,
        accessToken: String
    ) async throws -> UserSubscription {
        try await authenticatedMutation(
            path: "/v1/subscription/changes",
            method: "POST",
            body: input,
            acceptedStatusCodes: [200],
            accessToken: accessToken
        )
    }

    public func bindSubscriptionBrokerSlot(
        slotId: String,
        providerId: String,
        expectedVersion: Int,
        accessToken: String
    ) async throws -> UserSubscription {
        try await authenticatedMutation(
            path: "/v1/subscription/broker-slots/\(slotId)",
            method: "PUT",
            body: BindSubscriptionBrokerSlotRequest(
                providerId: providerId,
                expectedVersion: expectedVersion
            ),
            acceptedStatusCodes: [200],
            accessToken: accessToken
        )
    }

    public func providerPoolSummaries(
        ifNoneMatch: String?,
        accessToken: String
    ) async throws -> ProviderPoolListFetchResult {
        let result = try await authenticatedData(
            path: "/v1/research/pools",
            query: [],
            ifNoneMatch: ifNoneMatch,
            accessToken: accessToken
        )
        if result.statusCode == 304 {
            return ProviderPoolListFetchResult(
                items: nil,
                etag: result.etag ?? ifNoneMatch,
                notModified: true
            )
        }
        let response = try decoder.decode(ProviderPoolSummaryList.self, from: result.data)
        return ProviderPoolListFetchResult(
            items: response.items,
            etag: result.etag,
            notModified: false
        )
    }

    public func providerPoolPage(
        providerId: String,
        cursor: String?,
        ifNoneMatch: String?,
        accessToken: String
    ) async throws -> ProviderPoolPageFetchResult {
        var query = [URLQueryItem(name: "limit", value: "100")]
        if let cursor {
            query.append(URLQueryItem(name: "cursor", value: cursor))
        }
        let result = try await authenticatedData(
            path: "/v1/research/pools/\(providerId)",
            query: query,
            ifNoneMatch: ifNoneMatch,
            accessToken: accessToken
        )
        if result.statusCode == 304 {
            return ProviderPoolPageFetchResult(
                pool: nil,
                etag: result.etag ?? ifNoneMatch,
                notModified: true
            )
        }
        return ProviderPoolPageFetchResult(
            pool: try decoder.decode(ProviderPool.self, from: result.data),
            etag: result.etag,
            notModified: false
        )
    }

    public func addProviderPoolItem(
        providerId: String,
        item: AddProviderPoolItemRequest,
        accessToken: String
    ) async throws -> ProviderPool {
        try await authenticatedMutation(
            path: "/v1/research/pools/\(providerId)/items",
            method: "POST",
            body: item,
            acceptedStatusCodes: [201],
            accessToken: accessToken
        )
    }

    public func removeProviderPoolItem(
        providerId: String,
        itemId: String,
        accessToken: String
    ) async throws -> ProviderPool {
        try await authenticatedMutation(
            path: "/v1/research/pools/\(providerId)/items/\(itemId)",
            method: "DELETE",
            body: EmptyRequest(),
            acceptedStatusCodes: [200],
            accessToken: accessToken
        )
    }

    public func sellPutPool(
        providerId: String,
        accessToken: String
    ) async throws -> SellPutPool {
        try await authenticatedGET(
            path: "/v1/sell-put/pools/\(providerId)",
            query: [],
            accessToken: accessToken
        )
    }

    public func syncSellPutTopThirtyPool(
        providerId: String,
        accessToken: String
    ) async throws -> SellPutPool {
        try await authenticatedMutation(
            path: "/v1/sell-put/pools/\(providerId)/sync-top30",
            method: "POST",
            body: EmptyRequest(),
            acceptedStatusCodes: [200],
            accessToken: accessToken
        )
    }

    public func addSellPutPoolItem(
        providerId: String,
        input: AddSellPutPoolItemRequest,
        accessToken: String
    ) async throws -> SellPutPool {
        try await authenticatedMutation(
            path: "/v1/sell-put/pools/\(providerId)/items",
            method: "POST",
            body: input,
            acceptedStatusCodes: [201],
            accessToken: accessToken
        )
    }

    public func removeSellPutPoolItem(
        providerId: String,
        itemId: String,
        accessToken: String
    ) async throws -> SellPutPool {
        try await authenticatedMutation(
            path: "/v1/sell-put/pools/\(providerId)/items/\(itemId)",
            method: "DELETE",
            body: EmptyRequest(),
            acceptedStatusCodes: [200],
            accessToken: accessToken
        )
    }

    public func createSellPutReport(
        _ input: CreateSellPutReportRequest,
        accessToken: String
    ) async throws -> SellPutReport {
        try await authenticatedMutation(
            path: "/v1/sell-put/reports",
            method: "POST",
            body: input,
            acceptedStatusCodes: [201],
            timeoutInterval: 360,
            accessToken: accessToken
        )
    }

    public func latestSellPutReport(
        providerId: String,
        accessToken: String
    ) async throws -> SellPutReport? {
        do {
            return try await authenticatedGET(
                path: "/v1/sell-put/reports/latest",
                query: [URLQueryItem(name: "provider", value: providerId)],
                accessToken: accessToken
            )
        } catch BackendClientError.notFound {
            return nil
        }
    }

    public func sellPutReportHistory(
        providerId: String,
        page: Int = 1,
        pageSize: Int = 10,
        accessToken: String
    ) async throws -> SellPutReportHistoryPage {
        try await authenticatedGET(
            path: "/v1/sell-put/reports/history",
            query: [
                URLQueryItem(name: "provider", value: providerId),
                URLQueryItem(name: "page", value: String(page)),
                URLQueryItem(name: "pageSize", value: String(pageSize))
            ],
            accessToken: accessToken
        )
    }

    public func sellPutReport(
        runId: String,
        providerId: String,
        accessToken: String
    ) async throws -> SellPutReport {
        try await authenticatedGET(
            path: "/v1/sell-put/reports/\(runId)",
            query: [URLQueryItem(name: "provider", value: providerId)],
            accessToken: accessToken
        )
    }

    private func authenticatedGET<Response: Decodable>(
        path: String,
        query: [URLQueryItem],
        accessToken: String
    ) async throws -> Response {
        guard var components = URLComponents(
            url: baseURL.appending(path: path),
            resolvingAgainstBaseURL: false
        ) else {
            throw BackendClientError.requestFailed
        }
        components.queryItems = query.isEmpty ? nil : query
        guard let url = components.url else { throw BackendClientError.requestFailed }
        var request = URLRequest(url: url)
        request.timeoutInterval = 10
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw BackendClientError.requestFailed
        }
        if http.statusCode == 401 {
            throw BackendClientError.authenticationRejected
        }
        if http.statusCode == 404 {
            throw BackendClientError.notFound
        }
        guard http.statusCode == 200 else {
            throw responseError(data: data, statusCode: http.statusCode)
        }
        return try decoder.decode(Response.self, from: data)
    }

    private func authenticatedMutation<Body: Encodable, Response: Decodable>(
        path: String,
        method: String,
        body: Body,
        acceptedStatusCodes: Set<Int>,
        timeoutInterval: TimeInterval = 15,
        accessToken: String
    ) async throws -> Response {
        let url = baseURL.appending(path: path)
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = timeoutInterval
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue(UUID().uuidString.lowercased(), forHTTPHeaderField: "Idempotency-Key")
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        request.httpBody = try encoder.encode(body)

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw BackendClientError.requestFailed
        }
        if http.statusCode == 401 {
            throw BackendClientError.authenticationRejected
        }
        if http.statusCode == 404 {
            throw BackendClientError.notFound
        }
        guard acceptedStatusCodes.contains(http.statusCode) else {
            throw responseError(data: data, statusCode: http.statusCode)
        }
        return try decoder.decode(Response.self, from: data)
    }

    private func authenticatedData(
        path: String,
        query: [URLQueryItem],
        ifNoneMatch: String?,
        accessToken: String
    ) async throws -> (
        data: Data,
        statusCode: Int,
        etag: String?
    ) {
        guard var components = URLComponents(
            url: baseURL.appending(path: path),
            resolvingAgainstBaseURL: false
        ) else {
            throw BackendClientError.requestFailed
        }
        components.queryItems = query.isEmpty ? nil : query
        guard let url = components.url else { throw BackendClientError.requestFailed }
        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        if let ifNoneMatch {
            request.setValue(ifNoneMatch, forHTTPHeaderField: "If-None-Match")
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw BackendClientError.requestFailed
        }
        if http.statusCode == 401 {
            throw BackendClientError.authenticationRejected
        }
        if http.statusCode == 404 {
            throw BackendClientError.notFound
        }
        guard http.statusCode == 200 || http.statusCode == 304 else {
            throw responseError(data: data, statusCode: http.statusCode)
        }
        return (
            data,
            http.statusCode,
            http.value(forHTTPHeaderField: "ETag")
        )
    }

    private func responseError(data: Data, statusCode: Int) -> BackendClientError {
        if let problem = try? decoder.decode(BackendProblem.self, from: data) {
            return .serviceRejected(problem.code)
        }
        return statusCode >= 500 ? .serviceUnavailable : .requestFailed
    }

    private func sendAuthenticationRequest<Body: Encodable>(
        path: String,
        body: Body
    ) async throws -> TokenPair {
        let url = baseURL.appending(path: path)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 10
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw BackendClientError.requestFailed
        }
        if http.statusCode == 401 {
            throw BackendClientError.authenticationRejected
        }
        guard http.statusCode == 200 else {
            throw BackendClientError.serviceUnavailable
        }
        return try decoder.decode(TokenPair.self, from: data)
    }
}

private struct ModelRunRequest: Encodable {
    let context: ContextEnvelope
    let userMessage: String?
    let modelRoute: String?
}

private struct BrokerConnectionRequest: Encodable {
    let provider: String
    let accountIdHash: String
    let environment: String
    let displayName: String
}

private struct RefreshTokenRequest: Encodable {
    let refreshToken: String
}

private struct ItemList<Item: Decodable>: Decodable {
    let items: [Item]
}

private struct ProviderPoolSummaryList: Decodable {
    let items: [ProviderPoolSummary]
}

private struct EmptyRequest: Encodable {}

private struct BackendProblem: Decodable {
    let code: String
}

public enum BackendClientError: LocalizedError {
    case requestFailed
    case authenticationRejected
    case serviceUnavailable
    case notFound
    case modelRunFailed(String)
    case serviceRejected(String)

    public var errorDescription: String? {
        switch self {
        case .requestFailed: "长富后台请求失败"
        case .authenticationRejected: "用户名或密码错误，或账号不可用"
        case .serviceUnavailable: "长富服务暂时不可用"
        case .notFound: "请求的长富资源不存在"
        case .modelRunFailed(let code): "模型运行失败（\(code)）"
        case .serviceRejected(let code):
            switch code {
            case "CURRENT_PASSWORD_INVALID":
                "当前密码错误"
            case "PASSWORD_POLICY_INVALID":
                "新密码至少 12 位，并同时包含字母和数字"
            case "PASSWORD_CHANGE_REQUIRED":
                "首次登录必须先修改密码"
            default:
                "请求未完成（\(code)）"
            }
        }
    }
}
