import ChangFuDomain
import Foundation

public enum ManagedOrderSupervisorError: LocalizedError {
    case orderMissing
    case brokerOrderIdMissing

    public var errorDescription: String? {
        switch self {
        case .orderMissing:
            "撤单任务对应的系统订单不存在"
        case .brokerOrderIdMissing:
            "系统订单缺少券商订单号，无法安全撤单"
        }
    }
}

@MainActor
public final class ManagedOrderSupervisor {
    private let backend: BackendClient
    private var executingActionIds = Set<String>()

    public init(backend: BackendClient) {
        self.backend = backend
    }

    public func process(
        actions: [PendingOrderAction],
        orders: [PendingLiveOrder],
        deviceId: String,
        accountId: String,
        broker: any LiveOrderBrokerClient,
        accessToken: String
    ) async {
        let ordersByIntent = Dictionary(uniqueKeysWithValues: orders.map { ($0.intentId, $0) })
        for action in actions where action.actionType == "CANCEL" {
            guard !Task.isCancelled,
                  executingActionIds.insert(action.actionId).inserted else { continue }
            defer { executingActionIds.remove(action.actionId) }
            var claimToken: String?
            do {
                guard let order = ordersByIntent[action.intentId] else {
                    throw ManagedOrderSupervisorError.orderMissing
                }
                let claim = try await backend.claimOrderAction(
                    actionId: action.actionId,
                    input: ClaimOrderActionRequest(
                        deviceId: deviceId,
                        expectedVersion: action.version
                    ),
                    accessToken: accessToken
                )
                claimToken = claim.claimToken
                let brokerOrderId = try await resolveBrokerOrderId(
                    order: order,
                    accountId: accountId,
                    broker: broker
                )
                let receipt = try await broker.cancelOrder(BrokerCancelOrderRequest(
                    intentId: order.intentId,
                    accountId: accountId,
                    brokerOrderId: brokerOrderId,
                    symbol: order.order.symbol
                ))
                try await record(
                    action: action,
                    claimToken: claim.claimToken,
                    deviceId: deviceId,
                    receipt: receipt,
                    status: Self.cancelStatus(receipt),
                    accessToken: accessToken
                )
            } catch {
                if let claimToken {
                    try? await recordUncertain(
                        action: action,
                        claimToken: claimToken,
                        deviceId: deviceId,
                        reason: error.localizedDescription,
                        accessToken: accessToken
                    )
                }
            }
        }
    }

    private func resolveBrokerOrderId(
        order: PendingLiveOrder,
        accountId: String,
        broker: any LiveOrderBrokerClient
    ) async throws -> String {
        if let brokerOrderId = order.brokerOrderId, !brokerOrderId.isEmpty {
            return brokerOrderId
        }
        guard let receipt = try await broker.findOrder(BrokerFindOrderRequest(
            intentId: order.intentId,
            accountId: accountId,
            symbol: order.order.symbol,
            side: order.order.side,
            quantity: order.order.quantity,
            limitPrice: order.order.limitPrice,
            submittedAfter: order.issuedAt
        )) else {
            throw ManagedOrderSupervisorError.brokerOrderIdMissing
        }
        return receipt.brokerOrderId
    }

    private func record(
        action: PendingOrderAction,
        claimToken: String,
        deviceId: String,
        receipt: BrokerOrderReceipt,
        status: String,
        accessToken: String
    ) async throws {
        _ = try await backend.recordOrderActionResult(
            actionId: action.actionId,
            input: RecordOrderActionResultRequest(
                deviceId: deviceId,
                claimToken: claimToken,
                status: status,
                resultSummary: .object([
                    "brokerOrderId": .string(receipt.brokerOrderId),
                    "brokerStatus": .string(receipt.status),
                    "filledQuantity": .string(receipt.filledQuantity.description),
                    "updatedAt": .string(receipt.updatedAt)
                ])
            ),
            accessToken: accessToken
        )
    }

    private func recordUncertain(
        action: PendingOrderAction,
        claimToken: String,
        deviceId: String,
        reason: String,
        accessToken: String
    ) async throws {
        _ = try await backend.recordOrderActionResult(
            actionId: action.actionId,
            input: RecordOrderActionResultRequest(
                deviceId: deviceId,
                claimToken: claimToken,
                status: "CANCEL_UNCERTAIN",
                resultSummary: .object(["reason": .string(reason)])
            ),
            accessToken: accessToken
        )
    }

    private static func cancelStatus(_ receipt: BrokerOrderReceipt) -> String {
        let status = receipt.status.uppercased()
        if status.contains("CANCEL") { return "CANCELLED" }
        if receipt.submittedQuantity > 0,
           receipt.filledQuantity >= receipt.submittedQuantity {
            return "FILLED"
        }
        return "CANCEL_PENDING"
    }
}
