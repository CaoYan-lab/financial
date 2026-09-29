import ChangFuDomain
import CryptoKit
import Foundation

public struct LiveOrderExecutionContext: Equatable, Sendable {
    public let userId: String
    public let deviceId: String
    public let brokerConnectionId: String
    public let provider: String
    public let accountId: String
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
        accountId: String,
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
        self.accountId = accountId
        self.accountIdHash = accountIdHash
        self.poolVersion = poolVersion
        self.configVersion = configVersion
        self.riskPolicyVersion = riskPolicyVersion
        self.sessionId = sessionId
    }
}

public struct LiveOrderExecutionOutcome: Equatable, Sendable {
    public let intentId: String
    public let executionId: String
    public let status: String
    public let brokerOrderId: String?
    public let message: String
}

public enum LiveOrderCoordinatorError: LocalizedError {
    case alreadyExecuting
    case unsignedOrder
    case signingKeyMissing
    case signingKeyInvalid
    case tokenClaimsInvalid
    case readinessRejected(String)
    case submissionIntentMismatch

    public var errorDescription: String? {
        switch self {
        case .alreadyExecuting:
            "该系统订单正在处理中"
        case .unsignedOrder:
            "订单缺少完整签名字段"
        case .signingKeyMissing:
            "订单签名公钥不可用"
        case .signingKeyInvalid:
            "订单签名公钥格式无效"
        case .tokenClaimsInvalid:
            "登录身份无法绑定订单意图"
        case .readinessRejected(let reason):
            "券商下单前置检查未通过：\(reason)"
        case .submissionIntentMismatch:
            "提交阶段返回的订单意图与待确认订单不一致"
        }
    }
}

@MainActor
public final class LiveOrderCoordinator {
    private let backend: BackendClient
    private var executingIntentIds = Set<String>()

    public init(backend: BackendClient) {
        self.backend = backend
    }

    public func execute(
        pending: PendingLiveOrder,
        context: LiveOrderExecutionContext,
        broker: any LiveOrderBrokerClient,
        accessToken: String
    ) async throws -> LiveOrderExecutionOutcome {
        guard executingIntentIds.insert(pending.intentId).inserted else {
            throw LiveOrderCoordinatorError.alreadyExecuting
        }
        defer { executingIntentIds.remove(pending.intentId) }

        let intent = try await verifiedIntent(
            pending: pending,
            context: context,
            accessToken: accessToken
        )

        let readiness = try await broker.tradeReadiness(BrokerTradeReadinessRequest(
            accountId: context.accountId,
            order: intent.order
        ))
        guard readiness.ready else {
            throw LiveOrderCoordinatorError.readinessRejected(
                readiness.reason ?? "券商未返回可交易状态"
            )
        }

        let claim = try await backend.claimPendingOrder(
            intentId: intent.intentId,
            input: ClaimPendingOrderRequest(
                deviceId: context.deviceId,
                provider: context.provider,
                expectedVersion: pending.version
            ),
            accessToken: accessToken
        )
        let brokerRequest = BrokerPlaceOrderRequest(
            intentId: intent.intentId,
            accountId: context.accountId,
            order: intent.order
        )
        let brokerRequestData = try Self.canonicalEncoder.encode(brokerRequest)
        let submission = try await backend.beginOrderSubmission(
            intentId: intent.intentId,
            input: BeginOrderSubmissionRequest(
                deviceId: context.deviceId,
                provider: context.provider,
                claimToken: claim.claimToken,
                brokerRequestHash: Self.sha256(brokerRequestData)
            ),
            accessToken: accessToken
        )
        guard submission.intent == intent else {
            try? await record(
                executionId: submission.executionId,
                deviceId: context.deviceId,
                status: "FAILED",
                resultCode: "SUBMISSION_INTENT_MISMATCH",
                receipt: nil,
                accessToken: accessToken
            )
            throw LiveOrderCoordinatorError.submissionIntentMismatch
        }

        do {
            let receipt = try await broker.placeOrder(brokerRequest)
            try await record(
                executionId: submission.executionId,
                deviceId: context.deviceId,
                status: "SUBMITTED",
                resultCode: receipt.brokerCode,
                receipt: receipt,
                accessToken: accessToken
            )
            return LiveOrderExecutionOutcome(
                intentId: intent.intentId,
                executionId: submission.executionId,
                status: receipt.status,
                brokerOrderId: receipt.brokerOrderId,
                message: "订单已提交，券商订单号 \(receipt.brokerOrderId)"
            )
        } catch {
            return try await reconcileSubmission(
                intent: intent,
                executionId: submission.executionId,
                context: context,
                broker: broker,
                originalError: error,
                accessToken: accessToken
            )
        }
    }

    public func reconcileSubmitting(
        pending: PendingLiveOrder,
        context: LiveOrderExecutionContext,
        broker: any LiveOrderBrokerClient,
        accessToken: String
    ) async throws -> LiveOrderExecutionOutcome {
        guard let executionId = pending.executionId else {
            throw LiveOrderCoordinatorError.submissionIntentMismatch
        }
        let intent = try await verifiedIntent(
            pending: pending,
            context: context,
            accessToken: accessToken
        )
        return try await reconcileSubmission(
            intent: intent,
            executionId: executionId,
            context: context,
            broker: broker,
            originalError: LiveOrderCoordinatorError.submissionIntentMismatch,
            accessToken: accessToken
        )
    }

    public func reject(
        pending: PendingLiveOrder,
        deviceId: String,
        reasonCode: String,
        accessToken: String
    ) async throws {
        _ = try await backend.rejectPendingOrder(
            intentId: pending.intentId,
            input: PendingOrderDecisionRequest(
                deviceId: deviceId,
                reasonCode: reasonCode
            ),
            accessToken: accessToken
        )
    }

    private func reconcileSubmission(
        intent: SignedOrderIntent,
        executionId: String,
        context: LiveOrderExecutionContext,
        broker: any LiveOrderBrokerClient,
        originalError: Error,
        accessToken: String
    ) async throws -> LiveOrderExecutionOutcome {
        let receipt: BrokerOrderReceipt?
        do {
            receipt = try await broker.findOrder(BrokerFindOrderRequest(
                intentId: intent.intentId,
                accountId: context.accountId,
                symbol: intent.order.symbol,
                side: intent.order.side,
                quantity: intent.order.quantity,
                limitPrice: intent.order.limitPrice,
                submittedAfter: intent.issuedAt
            ))
        } catch {
            try? await record(
                executionId: executionId,
                deviceId: context.deviceId,
                status: "UNKNOWN",
                resultCode: "BROKER_RECONCILIATION_FAILED",
                receipt: nil,
                accessToken: accessToken
            )
            throw originalError
        }
        if let receipt {
            try await record(
                executionId: executionId,
                deviceId: context.deviceId,
                status: "SUBMITTED",
                resultCode: receipt.brokerCode,
                receipt: receipt,
                accessToken: accessToken
            )
            return LiveOrderExecutionOutcome(
                intentId: intent.intentId,
                executionId: executionId,
                status: receipt.status,
                brokerOrderId: receipt.brokerOrderId,
                message: "提交响应中断，已通过券商订单查询确认"
            )
        }
        try await record(
            executionId: executionId,
            deviceId: context.deviceId,
            status: "FAILED",
            resultCode: "BROKER_ORDER_NOT_FOUND",
            receipt: nil,
            accessToken: accessToken
        )
        throw originalError
    }

    private func record(
        executionId: String,
        deviceId: String,
        status: String,
        resultCode: String?,
        receipt: BrokerOrderReceipt?,
        accessToken: String
    ) async throws {
        let summary: JSONValue? = receipt.map {
            .object([
                "status": .string($0.status),
                "submittedQuantity": .string($0.submittedQuantity.description),
                "filledQuantity": .string($0.filledQuantity.description),
                "averagePrice": $0.filledAveragePrice.map {
                    .string($0.description)
                } ?? .null,
                "remark": .string($0.remark),
                "updatedAt": .string($0.updatedAt)
            ])
        }
        _ = try await backend.recordOrderExecutionResult(
            executionId: executionId,
            input: RecordOrderExecutionResultRequest(
                deviceId: deviceId,
                status: status,
                brokerOrderId: receipt?.brokerOrderId,
                resultCode: resultCode,
                responseSummary: summary
            ),
            accessToken: accessToken
        )
    }

    private func verifiedIntent(
        pending: PendingLiveOrder,
        context: LiveOrderExecutionContext,
        accessToken: String
    ) async throws -> SignedOrderIntent {
        let intent = pending.signedIntent
        let keys = try await backend.orderIntentVerificationKeys(accessToken: accessToken)
        guard let key = keys.keys.first(where: { $0.keyId == intent.keyId }) else {
            throw LiveOrderCoordinatorError.signingKeyMissing
        }
        let publicKey = try Self.publicKey(fromPEM: key.publicKey)
        try OrderIntentVerifier.verify(
            intent,
            binding: OrderIntentBinding(
                userId: context.userId,
                deviceId: context.deviceId,
                brokerConnectionId: context.brokerConnectionId,
                provider: context.provider,
                accountIdHash: context.accountIdHash,
                poolVersion: context.poolVersion,
                configVersion: context.configVersion,
                riskPolicyVersion: context.riskPolicyVersion,
                sessionId: context.sessionId
            ),
            publicKey: publicKey
        )
        return intent
    }

    private static let canonicalEncoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }()

    private static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static func publicKey(
        fromPEM pem: String
    ) throws -> Curve25519.Signing.PublicKey {
        let base64 = pem
            .replacingOccurrences(of: "-----BEGIN PUBLIC KEY-----", with: "")
            .replacingOccurrences(of: "-----END PUBLIC KEY-----", with: "")
            .components(separatedBy: .whitespacesAndNewlines)
            .joined()
        guard let der = Data(base64Encoded: base64),
              der.count == 44,
              der.prefix(12) == Data([
                  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03,
                  0x2b, 0x65, 0x70, 0x03, 0x21, 0x00
              ]) else {
            throw LiveOrderCoordinatorError.signingKeyInvalid
        }
        return try Curve25519.Signing.PublicKey(rawRepresentation: der.suffix(32))
    }
}
