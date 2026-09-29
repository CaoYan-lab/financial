import ChangFuDomain
import Foundation

@MainActor
public protocol LiveOrderBrokerClient: AnyObject {
    func tradeReadiness(
        _ request: BrokerTradeReadinessRequest
    ) async throws -> BrokerTradeReadiness
    func placeOrder(_ request: BrokerPlaceOrderRequest) async throws -> BrokerOrderReceipt
    func cancelOrder(_ request: BrokerCancelOrderRequest) async throws -> BrokerOrderReceipt
    func findOrder(_ request: BrokerFindOrderRequest) async throws -> BrokerOrderReceipt?
}
