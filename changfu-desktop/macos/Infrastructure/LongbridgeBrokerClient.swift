import ChangFuDomain
import Foundation

private struct LongbridgeSnapshotRequest: Encodable {
    let symbols: [String]
}

@MainActor
public final class LongbridgeBrokerClient: BrokerInstrumentDiscoveryClient {
    public private(set) var connectionState: LongbridgeConnectionState = .disconnected
    private let runner: BrokerHostRunner
    private let credentialStore: SecureCredentialStore

    public init(
        hostExecutableURL: URL? = nil,
        credentialStore: SecureCredentialStore = SecureCredentialStore()
    ) {
        runner = BrokerHostRunner(executableURL: hostExecutableURL ?? Self.defaultHostURL())
        self.credentialStore = credentialStore
    }

    public func connect() async {
        connectionState = .connecting
        do {
            _ = try await runner.run(command: "probe", input: credentialInput())
            connectionState = .connected
        } catch {
            connectionState = Self.connectionState(for: error)
        }
    }

    public func disconnect() {
        connectionState = .disconnected
    }

    public func loadSnapshot() async throws -> BrokerSnapshot {
        try await loadSnapshot(additionalSymbols: [])
    }

    public func loadSnapshot(additionalSymbols: [String]) async throws -> BrokerSnapshot {
        do {
            let input: Data?
            if additionalSymbols.isEmpty {
                input = try credentialInput()
            } else {
                input = try commandInput(
                    LongbridgeSnapshotRequest(symbols: additionalSymbols)
                )
            }
            let data = try await runner.run(command: "snapshot", input: input)
            let snapshot = try JSONDecoder().decode(BrokerSnapshot.self, from: data)
            connectionState = .connected
            return snapshot
        } catch is DecodingError {
            connectionState = .failed(BrokerClientError.invalidResponse.localizedDescription)
            throw BrokerClientError.invalidResponse
        } catch {
            connectionState = Self.connectionState(for: error)
            throw error
        }
    }

    public func capabilities() async throws -> BrokerCapability {
        try await decode(BrokerCapability.self, command: "capabilities")
    }

    public func searchInstruments(
        _ request: BrokerInstrumentSearchRequest
    ) async throws -> BrokerInstrumentSearchResponse {
        try await decode(
            BrokerInstrumentSearchResponse.self,
            command: "search-instruments",
            request: request
        )
    }

    public func optionExpiries(
        for underlyingSymbol: String
    ) async throws -> BrokerOptionExpiryResponse {
        try await decode(
            BrokerOptionExpiryResponse.self,
            command: "option-expiries",
            request: BrokerOptionRequest(underlyingSymbol: underlyingSymbol)
        )
    }

    public func optionChain(
        for underlyingSymbol: String,
        expiryDate: String
    ) async throws -> BrokerOptionChainResponse {
        try await decode(
            BrokerOptionChainResponse.self,
            command: "option-chain",
            request: BrokerOptionRequest(
                underlyingSymbol: underlyingSymbol,
                expiryDate: expiryDate
            )
        )
    }

    public func sellPutOptionQuotes(
        symbols: [String]
    ) async throws -> SellPutOptionQuoteResponse {
        try await decode(
            SellPutOptionQuoteResponse.self,
            command: "sell-put-option-quotes",
            request: SellPutOptionQuoteRequest(optionSymbols: symbols)
        )
    }

    public func sellPutUnderlyingSnapshot(
        symbol: String
    ) async throws -> SellPutUnderlyingSnapshot {
        try await decode(
            SellPutUnderlyingSnapshot.self,
            command: "sell-put-underlying",
            request: SellPutUnderlyingRequest(symbol: symbol)
        )
    }

    private static func connectionState(for error: Error) -> LongbridgeConnectionState {
        let message = error.localizedDescription
        if message.contains("未授权") || message.contains("not_found") {
            return .unauthorized
        }
        if case BrokerClientError.hostUnavailable = error {
            return .cliUnavailable
        }
        return .failed(message)
    }

    private func credentialInput() throws -> Data? {
        guard let credentials = try credentialStore.longbridgeCredentials() else {
            return nil
        }
        return try JSONEncoder().encode(credentials)
    }

    private func commandInput<Request: Encodable>(_ request: Request) throws -> Data {
        var object = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(request)
        ) as? [String: Any] ?? [:]
        if let credentials = try credentialStore.longbridgeCredentials() {
            object["appKey"] = credentials.appKey
            object["appSecret"] = credentials.appSecret
            object["accessToken"] = credentials.accessToken
        }
        return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }

    private func decode<Response: Decodable>(
        _ type: Response.Type,
        command: String
    ) async throws -> Response {
        try await decode(type, command: command, input: credentialInput())
    }

    private func decode<Response: Decodable, Request: Encodable>(
        _ type: Response.Type,
        command: String,
        request: Request
    ) async throws -> Response {
        try await decode(type, command: command, input: commandInput(request))
    }

    private func decode<Response: Decodable>(
        _ type: Response.Type,
        command: String,
        input: Data?
    ) async throws -> Response {
        do {
            let data = try await runner.run(command: command, input: input)
            connectionState = .connected
            return try JSONDecoder().decode(type, from: data)
        } catch is DecodingError {
            connectionState = .failed(BrokerClientError.invalidResponse.localizedDescription)
            throw BrokerClientError.invalidResponse
        } catch {
            connectionState = Self.connectionState(for: error)
            throw error
        }
    }

    private static func defaultHostURL() -> URL {
        if let configured = ProcessInfo.processInfo.environment["CHANGFU_LONGBRIDGE_HOST"],
           !configured.isEmpty {
            return URL(fileURLWithPath: configured)
        }
        let executableURL = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
        return executableURL.deletingLastPathComponent()
            .appending(path: "ChangFuLongbridgeHost")
    }
}
