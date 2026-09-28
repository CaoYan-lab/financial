import CryptoKit
import Foundation

public enum JSONValue: Codable, Equatable, Sendable {
    case string(String)
    case number(Decimal)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Decimal.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            self = .array(try container.decode([JSONValue].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }
}

public struct ContextEnvelope: Codable, Equatable, Sendable {
    public let schemaVersion: String
    public let requestId: String
    public let deviceId: String
    public let brokerConnectionId: String
    public let provider: String?
    public let purpose: String
    public let capturedAt: String
    public let expiresAt: String
    public let sequence: Int
    public let account: [String: JSONValue]
    public let positions: [JSONValue]
    public let marketSessions: [JSONValue]
    public let quotes: [JSONValue]
    public let minuteBars: [JSONValue]
    public let tickerPoints: [JSONValue]
    public let orderBooks: [JSONValue]
    public let openOrders: [JSONValue]
    public let recentDeals: [JSONValue]
    public let research: [String: JSONValue]?
    public let decisionContext: [String: JSONValue]?
    public let capabilities: [JSONValue]
    public let strategyConfigVersion: String?
    public let researchPoolVersion: Int?
    public let tradingConfigVersion: Int?
    public let catalogVersion: String?
    public let tradingSessionId: String?
    public let requestedSymbols: [String]?
    public let clientPolicyVersion: String
    public let dataGaps: [String]
    public let contentHash: String
    public let deviceSignature: String
}

public struct ContextSnapshot: Sendable {
    public let account: [String: JSONValue]
    public let positions: [JSONValue]
    public let marketSessions: [JSONValue]
    public let quotes: [JSONValue]
    public let minuteBars: [JSONValue]
    public let tickerPoints: [JSONValue]
    public let orderBooks: [JSONValue]
    public let openOrders: [JSONValue]
    public let recentDeals: [JSONValue]
    public let research: [String: JSONValue]?
    public let decisionContext: [String: JSONValue]?
    public let capabilities: [JSONValue]
    public let dataGaps: [String]

    public init(
        account: [String: JSONValue],
        positions: [JSONValue] = [],
        marketSessions: [JSONValue] = [],
        quotes: [JSONValue] = [],
        minuteBars: [JSONValue] = [],
        tickerPoints: [JSONValue] = [],
        orderBooks: [JSONValue] = [],
        openOrders: [JSONValue] = [],
        recentDeals: [JSONValue] = [],
        research: [String: JSONValue]? = nil,
        decisionContext: [String: JSONValue]? = nil,
        capabilities: [JSONValue] = [],
        dataGaps: [String] = []
    ) {
        self.account = account
        self.positions = positions
        self.marketSessions = marketSessions
        self.quotes = quotes
        self.minuteBars = minuteBars
        self.tickerPoints = tickerPoints
        self.orderBooks = orderBooks
        self.openOrders = openOrders
        self.recentDeals = recentDeals
        self.research = research
        self.decisionContext = decisionContext
        self.capabilities = capabilities
        self.dataGaps = dataGaps
    }
}

public enum ContextEnvelopeError: LocalizedError {
    case invalidPurpose
    case invalidLifetime
    case tooLarge

    public var errorDescription: String? {
        switch self {
        case .invalidPurpose: "模型上下文用途非法"
        case .invalidLifetime: "模型上下文有效期非法"
        case .tooLarge: "模型上下文超过 2 MiB"
        }
    }
}

public enum ContextEnvelopeFactory {
    private static let maximumBytes = 2 * 1024 * 1024
    private static let executablePurposes = Set([
        "SINGLE_DECISION",
        "PORTFOLIO_REVIEW",
        "MANAGED_ORDER_REVIEW"
    ])
    private static let purposes = executablePurposes.union(["CHAT", "REPORT"])

    public static func make(
        requestId: UUID = UUID(),
        deviceId: String,
        brokerConnectionId: String,
        purpose: String,
        sequence: Int,
        snapshot: ContextSnapshot,
        strategyConfigVersion: String,
        clientPolicyVersion: String,
        devicePrivateKey: Curve25519.Signing.PrivateKey,
        now: Date = Date()
    ) throws -> ContextEnvelope {
        guard purposes.contains(purpose), !executablePurposes.contains(purpose) else {
            throw ContextEnvelopeError.invalidPurpose
        }
        let lifetime: TimeInterval = 300
        guard sequence > 0 else { throw ContextEnvelopeError.invalidLifetime }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let unsigned = UnsignedContextEnvelope(
            schemaVersion: "1.0",
            requestId: requestId.uuidString.lowercased(),
            deviceId: deviceId,
            brokerConnectionId: brokerConnectionId,
            provider: nil,
            purpose: purpose,
            capturedAt: formatter.string(from: now),
            expiresAt: formatter.string(from: now.addingTimeInterval(lifetime)),
            sequence: sequence,
            account: snapshot.account,
            positions: snapshot.positions,
            marketSessions: snapshot.marketSessions,
            quotes: snapshot.quotes,
            minuteBars: snapshot.minuteBars,
            tickerPoints: snapshot.tickerPoints,
            orderBooks: snapshot.orderBooks,
            openOrders: snapshot.openOrders,
            recentDeals: snapshot.recentDeals,
            research: snapshot.research,
            decisionContext: snapshot.decisionContext,
            capabilities: snapshot.capabilities,
            strategyConfigVersion: strategyConfigVersion,
            researchPoolVersion: nil,
            tradingConfigVersion: nil,
            catalogVersion: nil,
            tradingSessionId: nil,
            requestedSymbols: nil,
            clientPolicyVersion: clientPolicyVersion,
            dataGaps: snapshot.dataGaps
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let canonical = try encoder.encode(unsigned)
        let digest = Data(SHA256.hash(data: canonical))
        let contentHash = digest.map { String(format: "%02x", $0) }.joined()
        let signature = try devicePrivateKey.signature(for: digest).base64URLEncodedString()
        let envelope = ContextEnvelope(
            schemaVersion: unsigned.schemaVersion,
            requestId: unsigned.requestId,
            deviceId: unsigned.deviceId,
            brokerConnectionId: unsigned.brokerConnectionId,
            provider: unsigned.provider,
            purpose: unsigned.purpose,
            capturedAt: unsigned.capturedAt,
            expiresAt: unsigned.expiresAt,
            sequence: unsigned.sequence,
            account: unsigned.account,
            positions: unsigned.positions,
            marketSessions: unsigned.marketSessions,
            quotes: unsigned.quotes,
            minuteBars: unsigned.minuteBars,
            tickerPoints: unsigned.tickerPoints,
            orderBooks: unsigned.orderBooks,
            openOrders: unsigned.openOrders,
            recentDeals: unsigned.recentDeals,
            research: unsigned.research,
            decisionContext: unsigned.decisionContext,
            capabilities: unsigned.capabilities,
            strategyConfigVersion: unsigned.strategyConfigVersion,
            researchPoolVersion: unsigned.researchPoolVersion,
            tradingConfigVersion: unsigned.tradingConfigVersion,
            catalogVersion: unsigned.catalogVersion,
            tradingSessionId: unsigned.tradingSessionId,
            requestedSymbols: unsigned.requestedSymbols,
            clientPolicyVersion: unsigned.clientPolicyVersion,
            dataGaps: unsigned.dataGaps,
            contentHash: contentHash,
            deviceSignature: signature
        )
        if try encoder.encode(envelope).count > maximumBytes {
            throw ContextEnvelopeError.tooLarge
        }
        return envelope
    }

    public static func makeTrading(
        requestId: UUID = UUID(),
        deviceId: String,
        brokerConnectionId: String,
        provider: String,
        purpose: String,
        sequence: Int,
        snapshot: ContextSnapshot,
        researchPoolVersion: Int,
        tradingConfigVersion: Int,
        catalogVersion: String,
        tradingSessionId: String? = nil,
        requestedSymbols: [String],
        clientPolicyVersion: String,
        devicePrivateKey: Curve25519.Signing.PrivateKey,
        now: Date = Date()
    ) throws -> ContextEnvelope {
        guard executablePurposes.contains(purpose),
              ["FUTU", "LONGBRIDGE"].contains(provider),
              researchPoolVersion > 0,
              tradingConfigVersion > 0,
              !catalogVersion.isEmpty,
              !requestedSymbols.isEmpty,
              requestedSymbols.count <= 100,
              Set(requestedSymbols).count == requestedSymbols.count else {
            throw ContextEnvelopeError.invalidPurpose
        }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let unsigned = UnsignedContextEnvelope(
            schemaVersion: "2.0",
            requestId: requestId.uuidString.lowercased(),
            deviceId: deviceId,
            brokerConnectionId: brokerConnectionId,
            provider: provider,
            purpose: purpose,
            capturedAt: formatter.string(from: now),
            expiresAt: formatter.string(from: now.addingTimeInterval(60)),
            sequence: sequence,
            account: snapshot.account,
            positions: snapshot.positions,
            marketSessions: snapshot.marketSessions,
            quotes: snapshot.quotes,
            minuteBars: snapshot.minuteBars,
            tickerPoints: snapshot.tickerPoints,
            orderBooks: snapshot.orderBooks,
            openOrders: snapshot.openOrders,
            recentDeals: snapshot.recentDeals,
            research: snapshot.research,
            decisionContext: snapshot.decisionContext,
            capabilities: snapshot.capabilities,
            strategyConfigVersion: nil,
            researchPoolVersion: researchPoolVersion,
            tradingConfigVersion: tradingConfigVersion,
            catalogVersion: catalogVersion,
            tradingSessionId: tradingSessionId,
            requestedSymbols: requestedSymbols,
            clientPolicyVersion: clientPolicyVersion,
            dataGaps: snapshot.dataGaps
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let canonical = try encoder.encode(unsigned)
        let digest = Data(SHA256.hash(data: canonical))
        let envelope = ContextEnvelope(
            schemaVersion: unsigned.schemaVersion,
            requestId: unsigned.requestId,
            deviceId: unsigned.deviceId,
            brokerConnectionId: unsigned.brokerConnectionId,
            provider: unsigned.provider,
            purpose: unsigned.purpose,
            capturedAt: unsigned.capturedAt,
            expiresAt: unsigned.expiresAt,
            sequence: unsigned.sequence,
            account: unsigned.account,
            positions: unsigned.positions,
            marketSessions: unsigned.marketSessions,
            quotes: unsigned.quotes,
            minuteBars: unsigned.minuteBars,
            tickerPoints: unsigned.tickerPoints,
            orderBooks: unsigned.orderBooks,
            openOrders: unsigned.openOrders,
            recentDeals: unsigned.recentDeals,
            research: unsigned.research,
            decisionContext: unsigned.decisionContext,
            capabilities: unsigned.capabilities,
            strategyConfigVersion: nil,
            researchPoolVersion: unsigned.researchPoolVersion,
            tradingConfigVersion: unsigned.tradingConfigVersion,
            catalogVersion: unsigned.catalogVersion,
            tradingSessionId: unsigned.tradingSessionId,
            requestedSymbols: unsigned.requestedSymbols,
            clientPolicyVersion: unsigned.clientPolicyVersion,
            dataGaps: unsigned.dataGaps,
            contentHash: digest.map { String(format: "%02x", $0) }.joined(),
            deviceSignature: try devicePrivateKey.signature(for: digest).base64URLEncodedString()
        )
        if try encoder.encode(envelope).count > maximumBytes {
            throw ContextEnvelopeError.tooLarge
        }
        return envelope
    }
}

private struct UnsignedContextEnvelope: Encodable {
    let schemaVersion: String
    let requestId: String
    let deviceId: String
    let brokerConnectionId: String
    let provider: String?
    let purpose: String
    let capturedAt: String
    let expiresAt: String
    let sequence: Int
    let account: [String: JSONValue]
    let positions: [JSONValue]
    let marketSessions: [JSONValue]
    let quotes: [JSONValue]
    let minuteBars: [JSONValue]
    let tickerPoints: [JSONValue]
    let orderBooks: [JSONValue]
    let openOrders: [JSONValue]
    let recentDeals: [JSONValue]
    let research: [String: JSONValue]?
    let decisionContext: [String: JSONValue]?
    let capabilities: [JSONValue]
    let strategyConfigVersion: String?
    let researchPoolVersion: Int?
    let tradingConfigVersion: Int?
    let catalogVersion: String?
    let tradingSessionId: String?
    let requestedSymbols: [String]?
    let clientPolicyVersion: String
    let dataGaps: [String]
}

private extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
