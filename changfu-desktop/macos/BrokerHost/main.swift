import ChangFuBrokerNative
import ChangFuDomain
import Darwin
import Foundation

@main
struct BrokerHostMain {
    static func main() async {
        let command = CommandLine.arguments.dropFirst().first ?? "snapshot"
        let broker = FutuNativeBroker()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]

        do {
            switch command {
            case "probe":
                try broker.probe()
                writeStandardOutput(Data("{\"connected\":true}\n".utf8))
            case "capabilities":
                writeStandardOutput(try encoder.encode(BrokerCapability(
                    providerId: "FUTU",
                    searchMode: .fuzzy,
                    supportedMarkets: BrokerMarket.allCases,
                    supportedInstrumentTypes: BrokerInstrumentType.allCases,
                    supportsOptionChain: true
                )))
            case "search-instruments":
                let request = try decodeInput(BrokerInstrumentSearchRequest.self)
                writeStandardOutput(try encoder.encode(
                    try await searchInstruments(broker: broker, request: request)
                ))
            case "option-expiries":
                let request = try decodeInput(BrokerOptionRequest.self)
                writeStandardOutput(try encoder.encode(
                    broker.optionExpiries(for: request.underlyingSymbol)
                ))
            case "option-chain":
                let request = try decodeInput(BrokerOptionRequest.self)
                guard let expiryDate = request.expiryDate else {
                    throw HostError.invalidInput
                }
                writeStandardOutput(try encoder.encode(
                    broker.optionChain(
                        for: request.underlyingSymbol,
                        expiryDate: expiryDate
                    )
                ))
            case "sell-put-option-quotes":
                let request = try decodeInput(SellPutOptionQuoteRequest.self)
                writeStandardOutput(try encoder.encode(
                    broker.optionQuotes(symbols: request.optionSymbols)
                ))
            case "sell-put-underlying":
                let request = try decodeInput(SellPutUnderlyingRequest.self)
                writeStandardOutput(try encoder.encode(
                    broker.sellPutUnderlyingSnapshot(symbol: request.symbol)
                ))
            case "market-intelligence":
                let request = try decodeInput(MarketIntelligenceRequest.self)
                writeStandardOutput(try encoder.encode(
                    broker.loadMarketIntelligence(symbols: request.symbols)
                ))
            case "snapshot":
                let request = try decodeOptionalInput(BrokerSnapshotRequest.self)
                let snapshot = try broker.loadSnapshot(
                    additionalSymbols: request?.symbols ?? []
                )
                writeStandardOutput(try encoder.encode(snapshot))
                writeStandardOutput(Data("\n".utf8))
            default:
                throw HostError.invalidCommand(command)
            }
            // The vendor SDK can block while tearing down its callback threads.
            // BrokerHost is deliberately one-shot, so terminate after flushing IPC output.
            Darwin._exit(EXIT_SUCCESS)
        } catch {
            writeStandardError(error.localizedDescription)
            Darwin._exit(EXIT_FAILURE)
        }
    }

    private static func writeStandardOutput(_ data: Data) {
        FileHandle.standardOutput.write(data)
    }

    private static func writeStandardError(_ message: String) {
        FileHandle.standardError.write(Data("\(message)\n".utf8))
    }

    private static func decodeInput<Value: Decodable>(_ type: Value.Type) throws -> Value {
        let data = FileHandle.standardInput.readDataToEndOfFile()
        guard !data.isEmpty else {
            throw HostError.invalidInput
        }
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw HostError.invalidInput
        }
    }

    private static func decodeOptionalInput<Value: Decodable>(
        _ type: Value.Type
    ) throws -> Value? {
        let data = FileHandle.standardInput.readDataToEndOfFile()
        guard !data.isEmpty else { return nil }
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw HostError.invalidInput
        }
    }

    private static func searchInstruments(
        broker: FutuNativeBroker,
        request: BrokerInstrumentSearchRequest
    ) async throws -> BrokerInstrumentSearchResponse {
        let native = try broker.searchInstruments(request)
        guard native.results.isEmpty,
              let suggestions = try? await FutuSymbolAliasSearch().search(
                  query: request.query,
                  markets: request.markets,
                  limit: request.limit
              ),
              !suggestions.isEmpty else {
            return native
        }

        var results: [BrokerInstrument] = []
        var seen = Set<String>()
        for suggestion in suggestions where results.count < request.limit {
            let exactRequest = BrokerInstrumentSearchRequest(
                query: suggestion.providerSymbol,
                markets: [suggestion.market],
                instrumentTypes: request.instrumentTypes,
                limit: 1
            )
            guard let verified = try? broker.searchInstruments(exactRequest),
                  let instrument = verified.results.first,
                  seen.insert(instrument.providerSymbol).inserted else {
                continue
            }
            results.append(BrokerInstrument(
                providerId: instrument.providerId,
                providerSymbol: instrument.providerSymbol,
                canonicalSymbol: instrument.canonicalSymbol,
                displayName: suggestion.displayName,
                market: instrument.market,
                instrumentType: instrument.instrumentType,
                currency: instrument.currency,
                addable: instrument.addable,
                unavailableReason: instrument.unavailableReason
            ))
        }
        return BrokerInstrumentSearchResponse(
            providerId: "FUTU",
            query: request.query,
            queryMode: .fuzzy,
            results: results,
            fetchedAt: ISO8601DateFormatter().string(from: Date())
        )
    }
}

private struct BrokerSnapshotRequest: Codable {
    let symbols: [String]
}

private enum HostError: LocalizedError {
    case invalidCommand(String)
    case invalidInput

    var errorDescription: String? {
        switch self {
        case .invalidCommand(let command):
            "不支持的 BrokerHost 命令：\(command)"
        case .invalidInput:
            "BrokerHost 请求参数无效"
        }
    }
}

private struct FutuSymbolAliasSearch {
    private static let endpoint = URL(
        string: "https://searchapi.eastmoney.com/api/suggest/get"
    )!

    func search(
        query: String,
        markets: [BrokerMarket],
        limit: Int
    ) async throws -> [FutuSymbolAlias] {
        var components = URLComponents(url: Self.endpoint, resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "input", value: query),
            URLQueryItem(name: "type", value: "14"),
            URLQueryItem(name: "count", value: String(min(max(limit * 2, 10), 100)))
        ]
        guard let url = components.url else { return [] }
        var request = URLRequest(url: url)
        request.timeoutInterval = 5
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode),
              data.count <= 512 * 1024 else {
            return []
        }
        let payload = try JSONDecoder().decode(FutuSymbolAliasResponse.self, from: data)
        let allowedMarkets = Set(markets)
        return payload.quotationCodeTable.data.compactMap { item in
            guard let market = item.market, allowedMarkets.contains(market) else {
                return nil
            }
            return FutuSymbolAlias(
                providerSymbol: "\(market.rawValue).\(item.code)",
                displayName: item.name,
                market: market
            )
        }
    }
}

private struct FutuSymbolAlias: Sendable {
    let providerSymbol: String
    let displayName: String
    let market: BrokerMarket
}

private struct FutuSymbolAliasResponse: Decodable {
    let quotationCodeTable: Table

    struct Table: Decodable {
        let data: [Item]

        enum CodingKeys: String, CodingKey {
            case data = "Data"
        }
    }

    struct Item: Decodable {
        let code: String
        let name: String
        let classify: String
        let securityTypeName: String

        var market: BrokerMarket? {
            switch classify {
            case "UsStock": .us
            case "HK": .hk
            case "AStock": .cn
            case "SG": .sg
            default:
                securityTypeName.contains("美股") ? .us
                    : securityTypeName.contains("港股") ? .hk
                    : securityTypeName.contains("沪")
                        || securityTypeName.contains("深")
                        || securityTypeName.contains("A股") ? .cn
                    : securityTypeName.contains("新加坡") ? .sg
                    : nil
            }
        }

        enum CodingKeys: String, CodingKey {
            case code = "Code"
            case name = "Name"
            case classify = "Classify"
            case securityTypeName = "SecurityTypeName"
        }
    }

    enum CodingKeys: String, CodingKey {
        case quotationCodeTable = "QuotationCodeTable"
    }
}
