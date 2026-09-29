import Foundation

public struct BrokerTradeReadinessRequest: Codable, Equatable, Sendable {
    public let accountId: String
    public let order: SignedOrderIntent.OrderSpec

    public init(accountId: String, order: SignedOrderIntent.OrderSpec) {
        self.accountId = accountId
        self.order = order
    }
}

public struct BrokerTradeReadiness: Codable, Equatable, Sendable {
    public let provider: String
    public let accountId: String
    public let environment: String
    public let ready: Bool
    public let reason: String?
    public let marginAccount: Bool?
    public let marginCallActive: Bool?
    public let shortable: Bool?
    public let maxOrderQuantity: Decimal?
    public let checkedAt: String

    public init(
        provider: String,
        accountId: String,
        environment: String,
        ready: Bool,
        reason: String?,
        marginAccount: Bool?,
        marginCallActive: Bool?,
        shortable: Bool?,
        maxOrderQuantity: Decimal?,
        checkedAt: String
    ) {
        self.provider = provider
        self.accountId = accountId
        self.environment = environment
        self.ready = ready
        self.reason = reason
        self.marginAccount = marginAccount
        self.marginCallActive = marginCallActive
        self.shortable = shortable
        self.maxOrderQuantity = maxOrderQuantity
        self.checkedAt = checkedAt
    }
}

public struct BrokerPlaceOrderRequest: Codable, Equatable, Sendable {
    public let intentId: String
    public let accountId: String
    public let order: SignedOrderIntent.OrderSpec

    public init(
        intentId: String,
        accountId: String,
        order: SignedOrderIntent.OrderSpec
    ) {
        self.intentId = intentId
        self.accountId = accountId
        self.order = order
    }
}

public struct BrokerCancelOrderRequest: Codable, Equatable, Sendable {
    public let intentId: String
    public let accountId: String
    public let brokerOrderId: String
    public let symbol: String

    public init(
        intentId: String,
        accountId: String,
        brokerOrderId: String,
        symbol: String
    ) {
        self.intentId = intentId
        self.accountId = accountId
        self.brokerOrderId = brokerOrderId
        self.symbol = symbol
    }
}

public struct BrokerFindOrderRequest: Codable, Equatable, Sendable {
    public let intentId: String
    public let accountId: String
    public let symbol: String
    public let side: String
    public let quantity: String
    public let limitPrice: String
    public let submittedAfter: String

    public init(
        intentId: String,
        accountId: String,
        symbol: String,
        side: String,
        quantity: String,
        limitPrice: String,
        submittedAfter: String
    ) {
        self.intentId = intentId
        self.accountId = accountId
        self.symbol = symbol
        self.side = side
        self.quantity = quantity
        self.limitPrice = limitPrice
        self.submittedAfter = submittedAfter
    }
}

public struct BrokerOrderReceipt: Codable, Equatable, Sendable {
    public let brokerOrderId: String
    public let status: String
    public let submittedQuantity: Decimal
    public let filledQuantity: Decimal
    public let filledAveragePrice: Decimal?
    public let remark: String
    public let brokerCode: String?
    public let updatedAt: String

    public init(
        brokerOrderId: String,
        status: String,
        submittedQuantity: Decimal,
        filledQuantity: Decimal,
        filledAveragePrice: Decimal?,
        remark: String,
        brokerCode: String? = nil,
        updatedAt: String
    ) {
        self.brokerOrderId = brokerOrderId
        self.status = status
        self.submittedQuantity = submittedQuantity
        self.filledQuantity = filledQuantity
        self.filledAveragePrice = filledAveragePrice
        self.remark = remark
        self.brokerCode = brokerCode
        self.updatedAt = updatedAt
    }
}

public struct LiveExecutionSetting: Codable, Equatable, Sendable {
    public let provider: String
    public let hardGateEnabled: Bool
    public let autoSubmitEnabled: Bool
    public let version: Int
    public let blockers: [String]
    public let updatedAt: String?
}

public struct UpdateLiveExecutionSettingRequest: Codable, Equatable, Sendable {
    public let autoSubmitEnabled: Bool
    public let expectedVersion: Int

    public init(autoSubmitEnabled: Bool, expectedVersion: Int) {
        self.autoSubmitEnabled = autoSubmitEnabled
        self.expectedVersion = expectedVersion
    }
}

public struct PendingLiveOrder: Codable, Equatable, Sendable {
    public let intentId: String
    public let signalId: String
    public let brokerConnectionId: String
    public let provider: String
    public let accountIdHash: String
    public let contextHash: String
    public let symbol: String
    public let side: String
    public let positionEffect: String
    public let submissionMode: String
    public let order: SignedOrderIntent.OrderSpec
    public let state: String
    public let signature: String
    public let keyId: String
    public let version: Int
    public let sessionId: String?
    public let poolVersion: Int
    public let configVersion: Int
    public let riskPolicyVersion: String
    public let clientRevalidation: SignedOrderIntent.ClientRevalidation
    public let issuedAt: String
    public let expiresAt: String
    public let signalValidUntil: String
    public let claimExpiresAt: String?
    public let cancelReasonCode: String?
    public let brokerOrderId: String?
    public let executionId: String?
    public let submittedAt: String?
    public let updatedAt: String

    public let userId: String
    public let deviceId: String
    public let strategyVersion: String

    public var signedIntent: SignedOrderIntent {
        SignedOrderIntent(
            schemaVersion: "2.0",
            intentId: intentId,
            userId: userId,
            deviceId: deviceId,
            brokerConnectionId: brokerConnectionId,
            provider: provider,
            accountIdHash: accountIdHash,
            contextHash: contextHash,
            strategyVersion: strategyVersion,
            sessionId: sessionId,
            poolVersion: poolVersion,
            configVersion: configVersion,
            riskPolicyVersion: riskPolicyVersion,
            executionMode: submissionMode,
            clientRevalidation: clientRevalidation,
            order: order,
            issuedAt: issuedAt,
            expiresAt: expiresAt,
            keyId: keyId,
            signature: signature
        )
    }

    private enum CodingKeys: String, CodingKey {
        case intentId, signalId, brokerConnectionId, provider, accountIdHash, contextHash
        case symbol, side, positionEffect, submissionMode, order, state, signature, keyId
        case version, sessionId, poolVersion, configVersion, riskPolicyVersion
        case clientRevalidation, issuedAt, expiresAt, signalValidUntil, claimExpiresAt
        case cancelReasonCode, brokerOrderId, executionId, submittedAt, updatedAt
        case userId, deviceId, strategyVersion
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        intentId = try values.decode(String.self, forKey: .intentId)
        signalId = try values.decode(String.self, forKey: .signalId)
        brokerConnectionId = try values.decode(String.self, forKey: .brokerConnectionId)
        provider = try values.decode(String.self, forKey: .provider)
        accountIdHash = try values.decode(String.self, forKey: .accountIdHash)
        contextHash = try values.decode(String.self, forKey: .contextHash)
        symbol = try values.decode(String.self, forKey: .symbol)
        side = try values.decode(String.self, forKey: .side)
        positionEffect = try values.decode(String.self, forKey: .positionEffect)
        submissionMode = try values.decode(String.self, forKey: .submissionMode)
        order = try values.decode(SignedOrderIntent.OrderSpec.self, forKey: .order)
        state = try values.decode(String.self, forKey: .state)
        signature = try values.decode(String.self, forKey: .signature)
        keyId = try values.decode(String.self, forKey: .keyId)
        version = try values.decodeLosslessInt(forKey: .version)
        sessionId = try values.decodeIfPresent(String.self, forKey: .sessionId)
        poolVersion = try values.decodeLosslessInt(forKey: .poolVersion)
        configVersion = try values.decodeLosslessInt(forKey: .configVersion)
        riskPolicyVersion = try values.decode(String.self, forKey: .riskPolicyVersion)
        clientRevalidation = try values.decode(
            SignedOrderIntent.ClientRevalidation.self,
            forKey: .clientRevalidation
        )
        issuedAt = try values.decode(String.self, forKey: .issuedAt)
        expiresAt = try values.decode(String.self, forKey: .expiresAt)
        signalValidUntil = try values.decode(String.self, forKey: .signalValidUntil)
        claimExpiresAt = try values.decodeIfPresent(String.self, forKey: .claimExpiresAt)
        cancelReasonCode = try values.decodeIfPresent(String.self, forKey: .cancelReasonCode)
        brokerOrderId = try values.decodeIfPresent(String.self, forKey: .brokerOrderId)
        executionId = try values.decodeIfPresent(String.self, forKey: .executionId)
        submittedAt = try values.decodeIfPresent(String.self, forKey: .submittedAt)
        updatedAt = try values.decode(String.self, forKey: .updatedAt)
        userId = try values.decode(String.self, forKey: .userId)
        deviceId = try values.decode(String.self, forKey: .deviceId)
        strategyVersion = try values.decode(String.self, forKey: .strategyVersion)
    }
}

public struct LiveOrderClaim: Codable, Equatable, Sendable {
    public let claimToken: String
    public let expiresAt: String
    public let version: Int
}

public struct ClaimPendingOrderRequest: Codable, Equatable, Sendable {
    public let deviceId: String
    public let provider: String
    public let expectedVersion: Int

    public init(deviceId: String, provider: String, expectedVersion: Int) {
        self.deviceId = deviceId
        self.provider = provider
        self.expectedVersion = expectedVersion
    }
}

public struct BeginOrderSubmissionRequest: Codable, Equatable, Sendable {
    public let deviceId: String
    public let provider: String
    public let claimToken: String
    public let brokerRequestHash: String

    public init(
        deviceId: String,
        provider: String,
        claimToken: String,
        brokerRequestHash: String
    ) {
        self.deviceId = deviceId
        self.provider = provider
        self.claimToken = claimToken
        self.brokerRequestHash = brokerRequestHash
    }
}

public struct LiveOrderSubmission: Codable, Equatable, Sendable {
    public let executionId: String
    public let intent: SignedOrderIntent
}

public struct RecordOrderExecutionResultRequest: Codable, Equatable, Sendable {
    public let deviceId: String
    public let status: String
    public let brokerOrderId: String?
    public let resultCode: String?
    public let responseSummary: JSONValue?

    public init(
        deviceId: String,
        status: String,
        brokerOrderId: String? = nil,
        resultCode: String? = nil,
        responseSummary: JSONValue? = nil
    ) {
        self.deviceId = deviceId
        self.status = status
        self.brokerOrderId = brokerOrderId
        self.resultCode = resultCode
        self.responseSummary = responseSummary
    }
}

public struct PendingOrderDecisionRequest: Codable, Equatable, Sendable {
    public let deviceId: String
    public let reasonCode: String

    public init(deviceId: String, reasonCode: String) {
        self.deviceId = deviceId
        self.reasonCode = reasonCode
    }
}

public struct PendingOrderAction: Codable, Equatable, Sendable {
    public let actionId: String
    public let intentId: String
    public let provider: String
    public let brokerConnectionId: String
    public let actionType: String
    public let reasonCode: String
    public let state: String
    public let version: Int
    public let createdAt: String
    public let updatedAt: String
}

public struct ClaimOrderActionRequest: Codable, Equatable, Sendable {
    public let deviceId: String
    public let expectedVersion: Int

    public init(deviceId: String, expectedVersion: Int) {
        self.deviceId = deviceId
        self.expectedVersion = expectedVersion
    }
}

public struct RecordOrderActionResultRequest: Codable, Equatable, Sendable {
    public let deviceId: String
    public let claimToken: String
    public let status: String
    public let resultSummary: JSONValue?

    public init(
        deviceId: String,
        claimToken: String,
        status: String,
        resultSummary: JSONValue? = nil
    ) {
        self.deviceId = deviceId
        self.claimToken = claimToken
        self.status = status
        self.resultSummary = resultSummary
    }
}

public struct LiveTradingSession: Codable, Equatable, Sendable {
    public let sessionId: String
    public let brokerConnectionId: String
    public let deviceId: String
    public let mode: String
    public let status: String
    public let configVersion: Int
    public let riskPolicyVersion: String
    public let appSessionId: String
    public let expiresAt: String
    public let version: Int
}

public struct ActivateLiveTradingSessionRequest: Codable, Equatable, Sendable {
    public let brokerConnectionId: String
    public let provider: String
    public let deviceId: String
    public let configVersion: Int
    public let riskPolicyVersion: String
    public let confirmationDigest: String
    public let appSessionId: String

    public init(
        brokerConnectionId: String,
        provider: String,
        deviceId: String,
        configVersion: Int,
        riskPolicyVersion: String,
        confirmationDigest: String,
        appSessionId: String
    ) {
        self.brokerConnectionId = brokerConnectionId
        self.provider = provider
        self.deviceId = deviceId
        self.configVersion = configVersion
        self.riskPolicyVersion = riskPolicyVersion
        self.confirmationDigest = confirmationDigest
        self.appSessionId = appSessionId
    }
}

public struct CurrentLiveTradingSession: Codable, Equatable, Sendable {
    public let session: LiveTradingSession?
}

public struct LiveOrderActionCreated: Codable, Equatable, Sendable {
    public let actionId: String
}

public struct LiveOperationRecorded: Codable, Equatable, Sendable {
    public let recorded: Bool
}

public struct LiveOrderRejected: Codable, Equatable, Sendable {
    public let rejected: Bool
}

public struct LiveTradingSessionDeactivated: Codable, Equatable, Sendable {
    public let deactivated: Bool
}

public struct TradingLeaseRequest: Codable, Equatable, Sendable {
    public let deviceId: String
    public let brokerConnectionId: String

    public init(deviceId: String, brokerConnectionId: String) {
        self.deviceId = deviceId
        self.brokerConnectionId = brokerConnectionId
    }
}

public struct TradingLease: Codable, Equatable, Sendable {
    public let leaseId: String
    public let deviceId: String
    public let brokerConnectionId: String
    public let expiresAt: String
    public let version: Int
}

public struct OrderIntentVerificationKey: Codable, Equatable, Sendable {
    public let keyId: String
    public let publicKey: String
}

public struct OrderIntentVerificationKeys: Codable, Equatable, Sendable {
    public let keys: [OrderIntentVerificationKey]
}

private extension KeyedDecodingContainer {
    func decodeLosslessInt(forKey key: Key) throws -> Int {
        if let value = try? decode(Int.self, forKey: key) {
            return value
        }
        let value = try decode(String.self, forKey: key)
        guard let integer = Int(value) else {
            throw DecodingError.dataCorruptedError(
                forKey: key,
                in: self,
                debugDescription: "Expected an integer or decimal integer string"
            )
        }
        return integer
    }
}
