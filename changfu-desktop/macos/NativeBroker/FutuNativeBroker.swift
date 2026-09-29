import ChangFuDomain
import Foundation
import FutuCppBridge

public enum FutuNativeBrokerError: LocalizedError {
    case sdkUnavailable
    case connectionFailed(String)
    case snapshotFailed(String)
    case invalidSnapshot
    case discoveryFailed(String)
    case invalidDiscoveryResponse

    public var errorDescription: String? {
        switch self {
        case .sdkUnavailable:
            "Futu SDK 未配置"
        case .connectionFailed(let message):
            message
        case .snapshotFailed(let message):
            message
        case .invalidSnapshot:
            "OpenD 返回的账户快照格式无效"
        case .discoveryFailed(let message):
            message
        case .invalidDiscoveryResponse:
            "OpenD 返回的标的发现数据格式无效"
        }
    }
}

public final class FutuNativeBroker {
    private let client: OpaquePointer?

    public init() {
        client = changfu_futu_create()
    }

    deinit {
        changfu_futu_destroy(client)
    }

    public func probe(host: String = "127.0.0.1", port: UInt16 = 11111) throws {
        guard changfu_futu_sdk_available() else {
            throw FutuNativeBrokerError.sdkUnavailable
        }
        let status = changfu_futu_connect(client, host, port)
        guard status == ChangFuFutuStatusOk else {
            throw FutuNativeBrokerError.connectionFailed(lastError())
        }
    }

    public func loadSnapshot(
        refreshCache: Bool = true,
        additionalSymbols: [String] = []
    ) throws -> BrokerSnapshot {
        try probe()
        var output: UnsafeMutablePointer<CChar>?
        let symbols = additionalSymbols.prefix(100).joined(separator: ",")
        let status = changfu_futu_load_snapshot_json(
            client,
            refreshCache,
            symbols,
            &output
        )
        guard status == ChangFuFutuStatusOk else {
            throw FutuNativeBrokerError.snapshotFailed(lastError())
        }
        guard let output else {
            throw FutuNativeBrokerError.invalidSnapshot
        }
        defer { changfu_futu_free_string(output) }
        let data = Data(bytes: output, count: strlen(output))
        do {
            return try JSONDecoder().decode(BrokerSnapshot.self, from: data)
        } catch {
            throw FutuNativeBrokerError.invalidSnapshot
        }
    }

    public func searchInstruments(
        _ request: BrokerInstrumentSearchRequest
    ) throws -> BrokerInstrumentSearchResponse {
        try probe()
        let markets = request.markets.map(\.rawValue).joined(separator: ",")
        let instrumentTypes = request.instrumentTypes.map(\.rawValue).joined(separator: ",")
        return try decodeDiscoveryResponse {
            changfu_futu_search_instruments_json(
                client,
                request.query,
                markets,
                instrumentTypes,
                UInt32(clamping: request.limit),
                $0
            )
        }
    }

    public func optionExpiries(
        for underlyingSymbol: String
    ) throws -> BrokerOptionExpiryResponse {
        try probe()
        return try decodeDiscoveryResponse {
            changfu_futu_option_expiries_json(client, underlyingSymbol, $0)
        }
    }

    public func optionChain(
        for underlyingSymbol: String,
        expiryDate: String
    ) throws -> BrokerOptionChainResponse {
        try probe()
        return try decodeDiscoveryResponse {
            changfu_futu_option_chain_json(
                client,
                underlyingSymbol,
                expiryDate,
                $0
            )
        }
    }

    public func optionQuotes(
        symbols: [String]
    ) throws -> SellPutOptionQuoteResponse {
        try probe()
        return try decodeDiscoveryResponse {
            changfu_futu_option_quotes_json(
                client,
                symbols.joined(separator: ","),
                $0
            )
        }
    }

    public func sellPutUnderlyingSnapshot(
        symbol: String
    ) throws -> SellPutUnderlyingSnapshot {
        try probe()
        return try decodeDiscoveryResponse {
            changfu_futu_sell_put_underlying_json(client, symbol, $0)
        }
    }

    public func loadMarketIntelligence(
        symbols: [String]
    ) throws -> MarketIntelligenceSnapshot {
        try probe()
        return try decodeDiscoveryResponse {
            changfu_futu_market_intelligence_json(
                client,
                symbols.prefix(12).joined(separator: ","),
                $0
            )
        }
    }

    public func tradeReadiness(
        _ request: BrokerTradeReadinessRequest
    ) throws -> BrokerTradeReadiness {
        try probe()
        let order = request.order
        return try decodeDiscoveryResponse {
            changfu_futu_trade_readiness_json(
                client,
                request.accountId,
                order.symbol,
                order.side,
                order.positionEffect,
                order.orderType,
                order.tradingSession,
                order.timeInForce,
                NSDecimalNumber(string: order.quantity).doubleValue,
                NSDecimalNumber(string: order.limitPrice).doubleValue,
                $0
            )
        }
    }

    public func placeOrder(
        _ request: BrokerPlaceOrderRequest
    ) throws -> BrokerOrderReceipt {
        try probe()
        let order = request.order
        return try decodeDiscoveryResponse {
            changfu_futu_place_order_json(
                client,
                request.intentId,
                request.accountId,
                order.symbol,
                order.side,
                order.positionEffect,
                order.orderType,
                order.tradingSession,
                order.timeInForce,
                NSDecimalNumber(string: order.quantity).doubleValue,
                NSDecimalNumber(string: order.limitPrice).doubleValue,
                $0
            )
        }
    }

    public func cancelOrder(
        _ request: BrokerCancelOrderRequest
    ) throws -> BrokerOrderReceipt {
        try probe()
        return try decodeDiscoveryResponse {
            changfu_futu_cancel_order_json(
                client,
                request.intentId,
                request.accountId,
                request.brokerOrderId,
                request.symbol,
                $0
            )
        }
    }

    public func findOrder(
        _ request: BrokerFindOrderRequest
    ) throws -> BrokerOrderReceipt? {
        try probe()
        return try decodeDiscoveryResponse {
            changfu_futu_find_order_by_intent_json(
                client,
                request.intentId,
                request.accountId,
                request.symbol,
                request.side,
                NSDecimalNumber(string: request.quantity).doubleValue,
                NSDecimalNumber(string: request.limitPrice).doubleValue,
                $0
            )
        }
    }

    private func decodeDiscoveryResponse<Response: Decodable>(
        _ invoke: (UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>) -> ChangFuFutuStatus
    ) throws -> Response {
        var output: UnsafeMutablePointer<CChar>?
        let status = invoke(&output)
        guard status == ChangFuFutuStatusOk else {
            throw FutuNativeBrokerError.discoveryFailed(lastError())
        }
        guard let output else {
            throw FutuNativeBrokerError.invalidDiscoveryResponse
        }
        defer { changfu_futu_free_string(output) }
        do {
            return try JSONDecoder().decode(
                Response.self,
                from: Data(bytes: output, count: strlen(output))
            )
        } catch {
            throw FutuNativeBrokerError.invalidDiscoveryResponse
        }
    }

    private func lastError() -> String {
        guard let client, let value = changfu_futu_last_error(client) else {
            return "OpenD 操作失败"
        }
        let message = String(cString: value)
        return message.isEmpty ? "OpenD 操作失败" : message
    }
}
