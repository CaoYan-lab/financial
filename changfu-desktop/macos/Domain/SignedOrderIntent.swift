import CryptoKit
import Foundation

public struct SignedOrderIntent: Codable, Equatable, Sendable {
    public let schemaVersion: String
    public let intentId: String
    public let userId: String
    public let deviceId: String
    public let brokerConnectionId: String
    public let provider: String
    public let accountIdHash: String
    public let contextHash: String
    public let strategyVersion: String
    public let sessionId: String?
    public let poolVersion: Int
    public let configVersion: Int
    public let riskPolicyVersion: String
    public let executionMode: String
    public let clientRevalidation: ClientRevalidation
    public let order: OrderSpec
    public let issuedAt: String
    public let expiresAt: String
    public let keyId: String
    public let signature: String

    public init(
        schemaVersion: String,
        intentId: String,
        userId: String,
        deviceId: String,
        brokerConnectionId: String,
        provider: String,
        accountIdHash: String,
        contextHash: String,
        strategyVersion: String,
        sessionId: String?,
        poolVersion: Int,
        configVersion: Int,
        riskPolicyVersion: String,
        executionMode: String,
        clientRevalidation: ClientRevalidation,
        order: OrderSpec,
        issuedAt: String,
        expiresAt: String,
        keyId: String,
        signature: String
    ) {
        self.schemaVersion = schemaVersion
        self.intentId = intentId
        self.userId = userId
        self.deviceId = deviceId
        self.brokerConnectionId = brokerConnectionId
        self.provider = provider
        self.accountIdHash = accountIdHash
        self.contextHash = contextHash
        self.strategyVersion = strategyVersion
        self.sessionId = sessionId
        self.poolVersion = poolVersion
        self.configVersion = configVersion
        self.riskPolicyVersion = riskPolicyVersion
        self.executionMode = executionMode
        self.clientRevalidation = clientRevalidation
        self.order = order
        self.issuedAt = issuedAt
        self.expiresAt = expiresAt
        self.keyId = keyId
        self.signature = signature
    }

    public struct ClientRevalidation: Codable, Equatable, Sendable {
        public let quoteMaxAgeMs: Int
        public let accountMaxAgeMs: Int
        public let mustCheckOpenOrders: Bool

        public init(quoteMaxAgeMs: Int, accountMaxAgeMs: Int, mustCheckOpenOrders: Bool) {
            self.quoteMaxAgeMs = quoteMaxAgeMs
            self.accountMaxAgeMs = accountMaxAgeMs
            self.mustCheckOpenOrders = mustCheckOpenOrders
        }
    }

    public struct OrderSpec: Codable, Equatable, Sendable {
        public let broker: String
        public let environment: String
        public let market: String
        public let symbol: String
        public let side: String
        public let positionEffect: String
        public let orderType: String
        public let tradingSession: String
        public let timeInForce: String
        public let quantity: String
        public let limitPrice: String
        public let currency: String
        public let maxSlippageBps: Int

        public init(
            broker: String,
            environment: String,
            market: String,
            symbol: String,
            side: String,
            positionEffect: String,
            orderType: String,
            tradingSession: String = "RTH",
            timeInForce: String = "DAY",
            quantity: String,
            limitPrice: String,
            currency: String,
            maxSlippageBps: Int
        ) {
            self.broker = broker
            self.environment = environment
            self.market = market
            self.symbol = symbol
            self.side = side
            self.positionEffect = positionEffect
            self.orderType = orderType
            self.tradingSession = tradingSession
            self.timeInForce = timeInForce
            self.quantity = quantity
            self.limitPrice = limitPrice
            self.currency = currency
            self.maxSlippageBps = maxSlippageBps
        }
    }
}

public struct OrderIntentBinding: Sendable {
    public let userId: String
    public let deviceId: String
    public let brokerConnectionId: String
    public let provider: String
    public let accountIdHash: String
    public let poolVersion: Int
    public let configVersion: Int
    public let riskPolicyVersion: String
    public let sessionId: String?

    public init(
        userId: String,
        deviceId: String,
        brokerConnectionId: String,
        provider: String,
        accountIdHash: String,
        poolVersion: Int,
        configVersion: Int,
        riskPolicyVersion: String,
        sessionId: String?
    ) {
        self.userId = userId
        self.deviceId = deviceId
        self.brokerConnectionId = brokerConnectionId
        self.provider = provider
        self.accountIdHash = accountIdHash
        self.poolVersion = poolVersion
        self.configVersion = configVersion
        self.riskPolicyVersion = riskPolicyVersion
        self.sessionId = sessionId
    }
}

public enum OrderIntentVerificationError: LocalizedError {
    case unsupportedVersion
    case bindingMismatch
    case expired
    case invalidIssueTime
    case invalidSlippage
    case invalidSignatureEncoding
    case invalidSignature

    public var errorDescription: String? {
        switch self {
        case .unsupportedVersion: "订单意图版本不受支持"
        case .bindingMismatch: "订单意图与当前用户、设备或账户不匹配"
        case .expired: "订单意图已过期"
        case .invalidIssueTime: "订单意图签发时间异常"
        case .invalidSlippage: "订单意图滑点超过客户端上限"
        case .invalidSignatureEncoding: "订单意图签名编码非法"
        case .invalidSignature: "订单意图签名校验失败"
        }
    }
}

public enum OrderIntentVerifier {
    public static func verify(
        _ intent: SignedOrderIntent,
        binding: OrderIntentBinding,
        publicKey: Curve25519.Signing.PublicKey,
        now: Date = Date()
    ) throws {
        guard intent.schemaVersion == "2.0" else {
            throw OrderIntentVerificationError.unsupportedVersion
        }
        guard intent.userId == binding.userId,
              intent.deviceId == binding.deviceId,
              intent.brokerConnectionId == binding.brokerConnectionId,
              intent.provider == binding.provider,
              intent.order.broker == binding.provider,
              intent.accountIdHash == binding.accountIdHash,
              intent.poolVersion == binding.poolVersion,
              intent.configVersion == binding.configVersion,
              intent.riskPolicyVersion == binding.riskPolicyVersion,
              intent.sessionId == binding.sessionId else {
            throw OrderIntentVerificationError.bindingMismatch
        }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let expiresAt = formatter.date(from: intent.expiresAt),
              expiresAt > now else {
            throw OrderIntentVerificationError.expired
        }
        guard let issuedAt = formatter.date(from: intent.issuedAt),
              issuedAt <= now.addingTimeInterval(5) else {
            throw OrderIntentVerificationError.invalidIssueTime
        }
        guard (0...15).contains(intent.order.maxSlippageBps) else {
            throw OrderIntentVerificationError.invalidSlippage
        }
        guard intent.clientRevalidation.mustCheckOpenOrders,
              intent.clientRevalidation.quoteMaxAgeMs > 0,
              intent.clientRevalidation.accountMaxAgeMs > 0,
              intent.executionMode == "MANUAL_CONFIRM"
                || (intent.executionMode == "AUTO_EXECUTE" && intent.sessionId != nil) else {
            throw OrderIntentVerificationError.bindingMismatch
        }
        guard let signature = Data(base64URLEncoded: intent.signature) else {
            throw OrderIntentVerificationError.invalidSignatureEncoding
        }

        let unsigned = UnsignedOrderIntent(intent)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let payload = try encoder.encode(unsigned)
        guard publicKey.isValidSignature(signature, for: payload) else {
            throw OrderIntentVerificationError.invalidSignature
        }
    }
}

private struct UnsignedOrderIntent: Encodable {
    let schemaVersion: String
    let intentId: String
    let userId: String
    let deviceId: String
    let brokerConnectionId: String
    let provider: String
    let accountIdHash: String
    let contextHash: String
    let strategyVersion: String
    let sessionId: String?
    let poolVersion: Int
    let configVersion: Int
    let riskPolicyVersion: String
    let executionMode: String
    let clientRevalidation: SignedOrderIntent.ClientRevalidation
    let order: SignedOrderIntent.OrderSpec
    let issuedAt: String
    let expiresAt: String
    let keyId: String

    init(_ intent: SignedOrderIntent) {
        schemaVersion = intent.schemaVersion
        intentId = intent.intentId
        userId = intent.userId
        deviceId = intent.deviceId
        brokerConnectionId = intent.brokerConnectionId
        provider = intent.provider
        accountIdHash = intent.accountIdHash
        contextHash = intent.contextHash
        strategyVersion = intent.strategyVersion
        sessionId = intent.sessionId
        poolVersion = intent.poolVersion
        configVersion = intent.configVersion
        riskPolicyVersion = intent.riskPolicyVersion
        executionMode = intent.executionMode
        clientRevalidation = intent.clientRevalidation
        order = intent.order
        issuedAt = intent.issuedAt
        expiresAt = intent.expiresAt
        keyId = intent.keyId
    }
}

private extension Data {
    init?(base64URLEncoded value: String) {
        var normalized = value
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = normalized.count % 4
        if remainder != 0 {
            normalized.append(String(repeating: "=", count: 4 - remainder))
        }
        self.init(base64Encoded: normalized)
    }
}
