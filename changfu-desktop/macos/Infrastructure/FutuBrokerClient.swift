import ChangFuDomain
import Foundation

@MainActor
public protocol BrokerClient: AnyObject {
    var connectionState: OpenDConnectionState { get }
    func connect() async
    func disconnect()
    func loadSnapshot() async throws -> BrokerSnapshot
}

@MainActor
public protocol BrokerInstrumentDiscoveryClient: AnyObject {
    func capabilities() async throws -> BrokerCapability
    func searchInstruments(
        _ request: BrokerInstrumentSearchRequest
    ) async throws -> BrokerInstrumentSearchResponse
    func optionExpiries(
        for underlyingSymbol: String
    ) async throws -> BrokerOptionExpiryResponse
    func optionChain(
        for underlyingSymbol: String,
        expiryDate: String
    ) async throws -> BrokerOptionChainResponse
    func sellPutOptionQuotes(
        symbols: [String]
    ) async throws -> SellPutOptionQuoteResponse
    func sellPutUnderlyingSnapshot(
        symbol: String
    ) async throws -> SellPutUnderlyingSnapshot
}

@MainActor
public protocol MarketIntelligenceClient: AnyObject {
    func loadMarketIntelligence(symbols: [String]) async throws
        -> MarketIntelligenceSnapshot
}

public enum BrokerClientError: LocalizedError {
    case hostUnavailable
    case hostFailed(String)
    case invalidResponse

    public var errorDescription: String? {
        switch self {
        case .hostUnavailable:
            "长富 BrokerHost 不可用，请重新运行本地启动脚本"
        case .hostFailed(let message):
            message
        case .invalidResponse:
            "BrokerHost 返回了无效数据"
        }
    }
}

@MainActor
public final class FutuBrokerClient:
    BrokerClient,
    BrokerInstrumentDiscoveryClient,
    MarketIntelligenceClient,
    QuantitativeResearchBrokerClient,
    LiveOrderBrokerClient
{
    public private(set) var connectionState: OpenDConnectionState = .disconnected
    private let runner: BrokerHostRunner
    private var quantitativeMarketSnapshot: MarketIntelligenceSnapshot?

    public init(hostExecutableURL: URL? = nil) {
        runner = BrokerHostRunner(executableURL: hostExecutableURL ?? Self.defaultHostURL())
    }

    public func connect() async {
        connectionState = .connecting
        do {
            _ = try await runner.run(command: "probe")
            connectionState = .connected
        } catch {
            connectionState = .failed(error.localizedDescription)
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
            let input = additionalSymbols.isEmpty
                ? nil
                : try JSONEncoder().encode(BrokerSnapshotRequest(symbols: additionalSymbols))
            let data = try await runner.run(command: "snapshot", input: input)
            let snapshot = try JSONDecoder().decode(BrokerSnapshot.self, from: data)
            connectionState = .connected
            return snapshot
        } catch is DecodingError {
            connectionState = .failed(BrokerClientError.invalidResponse.localizedDescription)
            throw BrokerClientError.invalidResponse
        } catch {
            connectionState = .failed(error.localizedDescription)
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

    public func loadMarketIntelligence(
        symbols: [String]
    ) async throws -> MarketIntelligenceSnapshot {
        try await decode(
            MarketIntelligenceSnapshot.self,
            command: "market-intelligence",
            request: MarketIntelligenceRequest(symbols: symbols)
        )
    }

    public func prepareQuantitativeResearch(symbols: [String]) async throws {
        var snapshots: [MarketIntelligenceSnapshot] = []
        for start in stride(from: 0, to: symbols.count, by: 12) {
            let end = min(start + 12, symbols.count)
            snapshots.append(try await loadMarketIntelligence(
                symbols: Array(symbols[start..<end])
            ))
        }
        guard let first = snapshots.first else {
            quantitativeMarketSnapshot = try await loadMarketIntelligence(symbols: [])
            return
        }
        let sections = MarketEventGroup.allCases.map { group in
            let matching = snapshots.map { $0.section(group) }
            let events = Dictionary(
                matching.flatMap(\.events).map { ($0.id, $0) },
                uniquingKeysWith: { first, _ in first }
            ).values.sorted { $0.publishedAt > $1.publishedAt }
            let availability: MarketIntelligenceAvailability
            if matching.allSatisfy({ $0.availability == .available }) {
                availability = .available
            } else if matching.contains(where: { !$0.events.isEmpty }) {
                availability = .partial
            } else {
                availability = .unavailable
            }
            return MarketIntelligenceSection(
                group: group,
                availability: availability,
                message: matching.compactMap(\.message).first,
                events: events
            )
        }
        quantitativeMarketSnapshot = MarketIntelligenceSnapshot(
            providerId: "FUTU",
            fetchedAt: first.fetchedAt,
            sections: sections
        )
    }

    public func quantitativeResearchObservation(
        _ request: QuantitativeBrokerObservationRequest
    ) async throws -> QuantitativeBrokerObservation {
        let snapshot = try await sellPutUnderlyingSnapshot(symbol: request.symbol)
        let market: MarketIntelligenceSnapshot
        if let quantitativeMarketSnapshot {
            market = quantitativeMarketSnapshot
        } else {
            market = try await loadMarketIntelligence(symbols: [request.symbol])
        }
        let capturedAt = snapshot.capturedAt
        var evidence: [QuantitativeEvidence] = []
        func appendNumber(
            _ id: String,
            _ layer: QuantitativeEvidenceLayer,
            _ title: String,
            _ value: Double?
        ) {
            guard let value else { return }
            evidence.append(QuantitativeEvidence(
                id: "futu:\(id):\(request.ticker)",
                layer: layer,
                source: "FUTU",
                title: title,
                capturedAt: capturedAt,
                asOf: capturedAt,
                value: .number(value)
            ))
        }
        appendNumber("market-cap", .fundamentals, "总市值", snapshot.marketCap)
        appendNumber("pe-ratio", .fundamentals, "市盈率", snapshot.peRatio)
        appendNumber("rsi14", .priceTrend, "RSI14", snapshot.rsi14)
        appendNumber("ma50", .priceTrend, "50 日均线", snapshot.ma50)
        appendNumber("ma200", .priceTrend, "200 日均线", snapshot.ma200)
        appendNumber("trend20d", .priceTrend, "20 日前复权趋势", snapshot.trend20d)
        appendNumber("trend60d", .priceTrend, "60 日前复权趋势", snapshot.trend60d)
        appendNumber("trend120d", .priceTrend, "120 日前复权趋势", snapshot.trend120d)
        appendNumber("distance-52w-high", .priceTrend, "距 52 周高点", snapshot.distanceTo52wHigh)
        appendNumber("distance-52w-low", .priceTrend, "距 52 周低点", snapshot.distanceTo52wLow)
        appendNumber("realized-vol-30d", .priceTrend, "30 日实现波动率", snapshot.realizedVol30d)

        let relatedEvents = market.sections.flatMap(\.events).filter { event in
            event.group == .usMacro
                || event.relatedSymbols.isEmpty
                || event.relatedSymbols.contains(request.symbol)
        }
        for event in relatedEvents {
            let layer: QuantitativeEvidenceLayer = event.group == .usMacro
                ? .macroFit
                : .filings
            evidence.append(QuantitativeEvidence(
                id: "futu:event:\(event.id)",
                layer: layer,
                source: "FUTU",
                title: event.title,
                capturedAt: event.fetchedAt,
                asOf: event.publishedAt,
                value: .string(event.detail ?? event.category),
                metadata: [
                    "category": .string(event.category),
                    "importance": .string(event.importance.rawValue),
                    "validUntil": .string(event.validUntil)
                ]
            ))
        }
        let sectionGaps = market.sections.compactMap { section -> String? in
            guard section.availability != .available else { return nil }
            return section.message ?? "\(section.group.rawValue) 数据不可用"
        }
        return QuantitativeBrokerObservation(
            requestId: request.requestId,
            rank: request.rank,
            symbol: request.symbol,
            ticker: request.ticker,
            displayName: request.displayName,
            providerId: "FUTU",
            capturedAt: capturedAt,
            currentPrice: snapshot.currentPrice,
            quoteFreshness: snapshot.currentPrice == nil ? "UNAVAILABLE" : "FRESH",
            adjustedDailyBarCount: snapshot.adjustedDailyBarCount ?? 0,
            evidence: evidence,
            dataGaps: Array(Set(
                snapshot.dataGaps
                    + sectionGaps
                    + ["Futu 完整财务报表能力不可用", "Futu 卖空数据能力不可用"]
            )).sorted()
        )
    }

    public func tradeReadiness(
        _ request: BrokerTradeReadinessRequest
    ) async throws -> BrokerTradeReadiness {
        try await decode(
            BrokerTradeReadiness.self,
            command: "trade-readiness",
            request: request
        )
    }

    public func placeOrder(
        _ request: BrokerPlaceOrderRequest
    ) async throws -> BrokerOrderReceipt {
        try await decode(
            BrokerOrderReceipt.self,
            command: "place-order",
            request: request
        )
    }

    public func cancelOrder(
        _ request: BrokerCancelOrderRequest
    ) async throws -> BrokerOrderReceipt {
        try await decode(
            BrokerOrderReceipt.self,
            command: "cancel-order",
            request: request
        )
    }

    public func findOrder(
        _ request: BrokerFindOrderRequest
    ) async throws -> BrokerOrderReceipt? {
        try await decode(
            BrokerOrderReceipt?.self,
            command: "find-order-by-intent",
            request: request
        )
    }

    private func decode<Response: Decodable>(
        _ type: Response.Type,
        command: String
    ) async throws -> Response {
        do {
            let data = try await runner.run(command: command)
            return try JSONDecoder().decode(type, from: data)
        } catch is DecodingError {
            throw BrokerClientError.invalidResponse
        }
    }

    private func decode<Response: Decodable, Request: Encodable>(
        _ type: Response.Type,
        command: String,
        request: Request
    ) async throws -> Response {
        do {
            let input = try JSONEncoder().encode(request)
            let data = try await runner.run(command: command, input: input)
            return try JSONDecoder().decode(type, from: data)
        } catch is DecodingError {
            throw BrokerClientError.invalidResponse
        }
    }

    private static func defaultHostURL() -> URL {
        if let configured = ProcessInfo.processInfo.environment["CHANGFU_BROKER_HOST"],
           !configured.isEmpty {
            return URL(fileURLWithPath: configured)
        }
        let executableURL = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
        return executableURL.deletingLastPathComponent().appending(path: "ChangFuBrokerHost")
    }

}

private struct BrokerSnapshotRequest: Encodable {
    let symbols: [String]
}

actor BrokerHostRunner {
    private let executableURL: URL

    init(executableURL: URL) {
        self.executableURL = executableURL
    }

    func run(command: String, input: Data? = nil) throws -> Data {
        guard FileManager.default.isExecutableFile(atPath: executableURL.path) else {
            throw BrokerClientError.hostUnavailable
        }

        let process = Process()
        let runDirectory = FileManager.default.temporaryDirectory
            .appending(path: "changfu-broker-\(UUID().uuidString)")
        let outputURL = runDirectory.appending(path: "stdout")
        let errorURL = runDirectory.appending(path: "stderr")
        do {
            try FileManager.default.createDirectory(
                at: runDirectory,
                withIntermediateDirectories: true
            )
            try Data().write(to: outputURL)
            try Data().write(to: errorURL)
        } catch {
            throw BrokerClientError.hostUnavailable
        }
        defer { try? FileManager.default.removeItem(at: runDirectory) }
        guard let standardOutput = try? FileHandle(forWritingTo: outputURL),
              let standardError = try? FileHandle(forWritingTo: errorURL) else {
            throw BrokerClientError.hostUnavailable
        }
        defer {
            try? standardOutput.close()
            try? standardError.close()
        }
        process.executableURL = executableURL
        process.arguments = [command]
        process.standardOutput = standardOutput
        process.standardError = standardError
        let standardInput = Pipe()
        process.standardInput = standardInput

        do {
            try process.run()
            if let input {
                try standardInput.fileHandleForWriting.write(contentsOf: input)
            }
            try standardInput.fileHandleForWriting.close()
        } catch {
            try? standardInput.fileHandleForWriting.close()
            throw BrokerClientError.hostUnavailable
        }
        let deadline = Date().addingTimeInterval(90)
        while process.isRunning, Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        if process.isRunning {
            process.terminate()
            process.waitUntilExit()
            throw BrokerClientError.hostFailed("BrokerHost 执行超过 90 秒，已终止本次刷新")
        }
        try standardOutput.synchronize()
        try standardError.synchronize()
        let output = try Data(contentsOf: outputURL)
        let errorData = try Data(contentsOf: errorURL)
        guard process.terminationStatus == EXIT_SUCCESS else {
            let message = String(data: errorData, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            throw BrokerClientError.hostFailed(
                message?.isEmpty == false ? message! : "BrokerHost 执行失败"
            )
        }
        return output
    }
}
