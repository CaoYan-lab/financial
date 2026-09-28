import ChangFuDomain
import Darwin
import Foundation

private enum HostError: LocalizedError {
    case cliUnavailable
    case unauthorized
    case commandFailed(String)
    case invalidJSON(String)
    case missingField(String)
    case invalidRequest(String)

    var errorDescription: String? {
        switch self {
        case .cliUnavailable:
            "Longbridge CLI 不可用，请重新运行本地启动脚本"
        case .unauthorized:
            "Longbridge 未授权，请先完成 Longbridge 登录授权"
        case .commandFailed(let message):
            "Longbridge 查询失败：\(message)"
        case .invalidJSON(let command):
            "Longbridge \(command) 返回了无效 JSON"
        case .missingField(let field):
            "Longbridge 返回缺少关键字段：\(field)"
        case .invalidRequest(let message):
            "Longbridge Host 请求无效：\(message)"
        }
    }
}

private struct CredentialInput: Codable {
    let appKey: String
    let appSecret: String
    let accessToken: String
    let symbols: [String]?

    var isComplete: Bool {
        !appKey.isEmpty && !appSecret.isEmpty && !accessToken.isEmpty
    }
}

private struct CLI {
    let executableURL: URL
    let credentials: CredentialInput?

    init(credentials: CredentialInput?) throws {
        let environment = ProcessInfo.processInfo.environment
        let configured = environment["CHANGFU_LONGBRIDGE_CLI"].flatMap {
            $0.isEmpty ? nil : URL(fileURLWithPath: $0)
        }
        let sibling = URL(fileURLWithPath: CommandLine.arguments[0])
            .standardizedFileURL
            .deletingLastPathComponent()
            .appending(path: "longbridge")
        let candidates = [configured, sibling].compactMap { $0 }
        guard let executable = candidates.first(where: {
            FileManager.default.isExecutableFile(atPath: $0.path)
        }) else {
            throw HostError.cliUnavailable
        }
        executableURL = executable
        self.credentials = credentials
    }

    func json(_ arguments: [String], name: String) throws -> Any {
        let data = try run(arguments + ["--format", "json"])
        do {
            return try JSONSerialization.jsonObject(with: data)
        } catch {
            throw HostError.invalidJSON(name)
        }
    }

    private func run(_ arguments: [String]) throws -> Data {
        let directory = FileManager.default.temporaryDirectory
            .appending(path: "changfu-longbridge-\(UUID().uuidString)")
        let outputURL = directory.appending(path: "stdout")
        let errorURL = directory.appending(path: "stderr")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try Data().write(to: outputURL)
        try Data().write(to: errorURL)

        let output = try FileHandle(forWritingTo: outputURL)
        let error = try FileHandle(forWritingTo: errorURL)
        defer {
            try? output.close()
            try? error.close()
        }
        let process = Process()
        process.executableURL = executableURL
        process.arguments = arguments
        if let credentials {
            process.environment = ProcessInfo.processInfo.environment.merging([
                "LONGBRIDGE_APP_KEY": credentials.appKey,
                "LONGBRIDGE_APP_SECRET": credentials.appSecret,
                "LONGBRIDGE_ACCESS_TOKEN": credentials.accessToken
            ]) { _, configured in configured }
        }
        process.standardOutput = output
        process.standardError = error
        try process.run()

        let deadline = Date().addingTimeInterval(30)
        while process.isRunning, Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        if process.isRunning {
            process.terminate()
            process.waitUntilExit()
            throw HostError.commandFailed("命令执行超过 30 秒")
        }
        try output.synchronize()
        try error.synchronize()
        let outputData = try Data(contentsOf: outputURL)
        guard process.terminationStatus == EXIT_SUCCESS else {
            var message = String(data: try Data(contentsOf: errorURL), encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if let credentials {
                for secret in [credentials.appKey, credentials.appSecret, credentials.accessToken]
                where !secret.isEmpty {
                    message = message?.replacingOccurrences(of: secret, with: "***")
                }
            }
            throw HostError.commandFailed(message?.isEmpty == false ? message! : "未知错误")
        }
        return outputData
    }
}

private struct JSONRecord {
    let value: [String: Any]

    func string(_ keys: String...) -> String? {
        for key in keys {
            guard let raw = value[key], !(raw is NSNull) else { continue }
            if let string = raw as? String, !string.isEmpty { return string }
            if let number = raw as? NSNumber { return number.stringValue }
        }
        return nil
    }

    func decimal(_ keys: String...) -> Decimal? {
        guard let raw = keys.lazy.compactMap({ value[$0] }).first(where: { !($0 is NSNull) })
        else { return nil }
        if let number = raw as? NSNumber {
            return Decimal(string: number.stringValue, locale: Locale(identifier: "en_US_POSIX"))
        }
        if let string = raw as? String {
            return Decimal(string: string, locale: Locale(identifier: "en_US_POSIX"))
        }
        return nil
    }

    func object(_ keys: String...) -> JSONRecord? {
        for key in keys {
            if let object = value[key] as? [String: Any] {
                return JSONRecord(value: object)
            }
        }
        return nil
    }
}

private func records(_ json: Any, keys: [String] = []) -> [JSONRecord] {
    if let array = json as? [[String: Any]] {
        return array.map(JSONRecord.init)
    }
    guard let object = json as? [String: Any] else { return [] }
    for key in keys {
        if let nested = object[key] {
            let result = records(nested)
            if !result.isEmpty || nested is [Any] { return result }
        }
    }
    return [JSONRecord(value: object)]
}

private func fetchedAt() -> String {
    ISO8601DateFormatter().string(from: Date())
}

private func double(_ value: Decimal?) -> Double? {
    value.map { NSDecimalNumber(decimal: $0).doubleValue }
}

private func longbridgeSymbol(_ symbol: String) -> String {
    let parts = symbol.split(separator: ".", maxSplits: 1).map(String.init)
    guard parts.count == 2 else { return symbol }
    let market = parts[0].uppercased()
    return ["US", "HK", "SH", "SZ", "SG"].contains(market)
        ? "\(parts[1]).\(market)"
        : symbol
}

private func providerMarket(for symbol: String) -> BrokerMarket? {
    switch symbol.split(separator: ".").last?.uppercased() {
    case "US": return .us
    case "HK": return .hk
    case "SH", "SZ": return .cn
    case "SG": return .sg
    default: return nil
    }
}

private func currency(for market: BrokerMarket) -> String {
    switch market {
    case .us: "USD"
    case .hk: "HKD"
    case .cn: "CNY"
    case .sg: "SGD"
    }
}

private func canonicalSymbol(_ providerSymbol: String) -> String {
    normalizeSymbol(providerSymbol, market: nil)
}

private func instrumentType(_ record: JSONRecord) -> BrokerInstrumentType? {
    let value = record.string("security_type", "instrument_type", "type")?.uppercased() ?? ""
    if value.contains("ETF") { return .etf }
    if value.contains("STOCK") || value.contains("EQUITY") { return .stock }
    return nil
}

private func makeCapabilities() -> BrokerCapability {
    BrokerCapability(
        providerId: "LONGBRIDGE",
        searchMode: .fuzzy,
        supportedMarkets: BrokerMarket.allCases,
        supportedInstrumentTypes: BrokerInstrumentType.allCases,
        supportsOptionChain: true
    )
}

private func makeInstrument(
    record: JSONRecord,
    fallbackSymbol: String,
    displayName: String? = nil,
    request: BrokerInstrumentSearchRequest
) -> BrokerInstrument? {
    let symbol = record.string("symbol", "code") ?? fallbackSymbol
    guard let resultMarket = providerMarket(for: symbol),
          request.markets.contains(resultMarket) else { return nil }
    let resolvedType = instrumentType(record)
    let requestedFallback = request.instrumentTypes.count == 1
        ? request.instrumentTypes[0]
        : .stock
    let type = resolvedType ?? requestedFallback
    let addable = resolvedType != nil && request.instrumentTypes.contains(type)
    return BrokerInstrument(
        providerId: "LONGBRIDGE",
        providerSymbol: symbol,
        canonicalSymbol: canonicalSymbol(symbol),
        displayName: displayName
            ?? record.string("name_zh", "name_cn", "name", "name_en")
            ?? symbol,
        market: resultMarket,
        instrumentType: type,
        currency: record.string("currency")?.uppercased() ?? currency(for: resultMarket),
        addable: addable,
        unavailableReason: addable ? nil : "券商未返回可确认的证券类型"
    )
}

private func searchInstruments(
    _ cli: CLI,
    request: BrokerInstrumentSearchRequest
) async throws -> BrokerInstrumentSearchResponse {
    let query = request.query.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    guard request.limit > 0, request.limit <= 100,
          !query.isEmpty,
          !request.instrumentTypes.isEmpty,
          request.instrumentTypes.allSatisfy({ $0 == .stock || $0 == .etf }) else {
        throw HostError.invalidRequest("证券搜索参数不合法")
    }

    if let market = providerMarket(for: query) {
        guard request.markets.contains(market) else {
            throw HostError.invalidRequest("证券代码与所选市场不一致")
        }
        let result = try cli.json(["static", query], name: "证券静态信息")
        let instruments = records(result, keys: ["data", "securities", "list"])
            .prefix(request.limit)
            .compactMap {
                makeInstrument(record: $0, fallbackSymbol: query, request: request)
            }
        return BrokerInstrumentSearchResponse(
            providerId: "LONGBRIDGE",
            query: request.query,
            queryMode: .fuzzy,
            results: instruments,
            fetchedAt: fetchedAt()
        )
    }

    let aliases = (try? await SymbolAliasSearch().search(
        query: request.query,
        markets: request.markets,
        limit: request.limit
    )) ?? []
    var instruments: [BrokerInstrument] = []
    var seen = Set<String>()
    for alias in aliases where instruments.count < request.limit {
        guard let result = try? cli.json(
            ["static", alias.providerSymbol],
            name: "证券静态信息"
        ) else { continue }
        for record in records(result, keys: ["data", "securities", "list"]) {
            guard let instrument = makeInstrument(
                record: record,
                fallbackSymbol: alias.providerSymbol,
                displayName: alias.displayName,
                request: request
            ), seen.insert(instrument.providerSymbol).inserted else { continue }
            instruments.append(instrument)
            if instruments.count == request.limit { break }
        }
    }
    return BrokerInstrumentSearchResponse(
        providerId: "LONGBRIDGE",
        query: request.query,
        queryMode: .fuzzy,
        results: instruments,
        fetchedAt: fetchedAt()
    )
}

private struct SymbolAliasSearch {
    private static let endpoint = URL(
        string: "https://searchapi.eastmoney.com/api/suggest/get"
    )!

    func search(
        query: String,
        markets: [BrokerMarket],
        limit: Int
    ) async throws -> [SymbolAlias] {
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
        let payload = try JSONDecoder().decode(SymbolAliasResponse.self, from: data)
        let allowedMarkets = Set(markets)
        return payload.quotationCodeTable.data.compactMap { item in
            guard let market = item.market,
                  allowedMarkets.contains(market),
                  let providerSymbol = item.providerSymbol else {
                return nil
            }
            return SymbolAlias(
                providerSymbol: providerSymbol,
                displayName: item.name
            )
        }
    }
}

private struct SymbolAlias: Sendable {
    let providerSymbol: String
    let displayName: String
}

private struct SymbolAliasResponse: Decodable {
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
        let exchange: String

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

        var providerSymbol: String? {
            switch market {
            case .us: "\(code).US"
            case .hk: "\(Int(code).map(String.init) ?? code).HK"
            case .cn:
                securityTypeName.contains("沪") ? "\(code).SH"
                    : securityTypeName.contains("深") ? "\(code).SZ"
                    : ["2", "SH", "SSE"].contains(exchange.uppercased()) ? "\(code).SH"
                    : ["80", "SZ", "SZSE"].contains(exchange.uppercased()) ? "\(code).SZ"
                    : nil
            case .sg: "\(code).SG"
            case nil: nil
            }
        }

        enum CodingKeys: String, CodingKey {
            case code = "Code"
            case name = "Name"
            case classify = "Classify"
            case securityTypeName = "SecurityTypeName"
            case exchange = "JYS"
        }
    }

    enum CodingKeys: String, CodingKey {
        case quotationCodeTable = "QuotationCodeTable"
    }
}

private func optionExpiries(
    _ cli: CLI,
    request: BrokerOptionRequest
) throws -> BrokerOptionExpiryResponse {
    let underlying = request.underlyingSymbol
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .uppercased()
    let brokerUnderlying = longbridgeSymbol(underlying)
    guard providerMarket(for: brokerUnderlying) != nil else {
        throw HostError.invalidRequest("期权底层标的必须使用 <CODE>.<MARKET>")
    }
    let result = try cli.json(["option", "chain", brokerUnderlying], name: "期权到期日")
    let expiries = records(result, keys: ["data", "expiries", "list"]).compactMap {
        record -> BrokerOptionExpiry? in
        guard let date = record.string("expiry_date", "expiryDate", "date") else { return nil }
        return BrokerOptionExpiry(underlyingSymbol: underlying, expiryDate: date)
    }
    return BrokerOptionExpiryResponse(
        providerId: "LONGBRIDGE",
        underlyingSymbol: underlying,
        expiries: expiries,
        fetchedAt: fetchedAt()
    )
}

private func optionChain(
    _ cli: CLI,
    request: BrokerOptionRequest
) throws -> BrokerOptionChainResponse {
    let underlying = request.underlyingSymbol
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .uppercased()
    let brokerUnderlying = longbridgeSymbol(underlying)
    guard let market = providerMarket(for: brokerUnderlying),
          let expiryDate = request.expiryDate,
          expiryDate.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil else {
        throw HostError.invalidRequest("期权链需要有效底层代码与 YYYY-MM-DD 到期日")
    }
    let chainJSON = try cli.json(
        ["option", "chain", brokerUnderlying, "--date", expiryDate],
        name: "期权链"
    )
    let rows = records(chainJSON, keys: ["data", "strikes", "list"])
    let symbols = rows.flatMap { record in
        [record.string("call_symbol", "callSymbol"), record.string("put_symbol", "putSymbol")]
            .compactMap { $0 }
    }
    var staticBySymbol: [String: JSONRecord] = [:]
    for batchStart in stride(from: 0, to: symbols.count, by: 100) {
        let batchEnd = min(batchStart + 100, symbols.count)
        let staticJSON = try cli.json(
            ["static"] + Array(symbols[batchStart..<batchEnd]),
            name: "期权合约静态信息"
        )
        for record in records(staticJSON, keys: ["data", "securities", "list"]) {
            if let symbol = record.string("symbol", "code") {
                staticBySymbol[symbol] = record
            }
        }
    }
    var contracts: [BrokerOptionContract] = []
    for row in rows {
        guard let strike = row.string("strike", "strike_price", "price") else { continue }
        for (type, symbol) in [
            (BrokerOptionType.call, row.string("call_symbol", "callSymbol")),
            (BrokerOptionType.put, row.string("put_symbol", "putSymbol"))
        ] {
            guard let symbol else { continue }
            let metadata = staticBySymbol[symbol]
            let multiplier = metadata?.string("lot_size", "lotSize", "contract_multiplier")
            let contractCurrency = metadata?.string("currency")?.uppercased()
            let addable = multiplier != nil && contractCurrency != nil
            contracts.append(BrokerOptionContract(
                providerId: "LONGBRIDGE",
                providerSymbol: symbol,
                canonicalSymbol: symbol,
                displayName: metadata?.string("name_zh", "name_cn", "name", "name_en") ?? symbol,
                market: market,
                instrumentType: .option,
                optionType: type,
                underlyingSymbol: underlying,
                expiryDate: expiryDate,
                strikePrice: strike,
                currency: contractCurrency ?? currency(for: market),
                contractMultiplier: multiplier ?? "0",
                addable: addable,
                unavailableReason: addable ? nil : "券商未返回币种或合约乘数"
            ))
        }
    }
    return BrokerOptionChainResponse(
        providerId: "LONGBRIDGE",
        underlyingSymbol: underlying,
        expiryDate: expiryDate,
        contracts: contracts,
        fetchedAt: fetchedAt()
    )
}

private func sellPutOptionQuotes(
    _ cli: CLI,
    request: SellPutOptionQuoteRequest
) throws -> SellPutOptionQuoteResponse {
    let symbols = Array(Set(request.optionSymbols.map(longbridgeSymbol))).sorted()
    guard !symbols.isEmpty, symbols.count <= 100 else {
        throw HostError.invalidRequest("期权快照需要 1 至 100 个合约代码")
    }
    let result = try cli.json(["option", "quote"] + symbols, name: "期权快照")
    let rows = records(result, keys: ["data", "quotes", "list"])
    let quotes = rows.compactMap { record -> SellPutOptionQuote? in
        guard let code = record.string("symbol", "code") else { return nil }
        return SellPutOptionQuote(
            code: code.uppercased(),
            lastPrice: double(record.decimal("last_done", "last", "last_price")),
            bid: double(record.decimal("bid_price", "bid")),
            ask: double(record.decimal("ask_price", "ask")),
            delta: double(record.decimal("delta", "option_delta")),
            impliedVolatility: double(record.decimal(
                "implied_volatility",
                "option_implied_volatility",
                "iv"
            )),
            volume: double(record.decimal("volume")),
            openInterest: double(record.decimal("open_interest", "openInterest"))
        )
    }
    let returned = Set(quotes.map { $0.code.uppercased() })
    return SellPutOptionQuoteResponse(
        providerId: "LONGBRIDGE",
        quotes: quotes,
        fetchedAt: fetchedAt(),
        dataGaps: symbols.filter { !returned.contains($0.uppercased()) }
            .map { "\($0) 期权快照不可用" }
    )
}

private func sellPutUnderlyingSnapshot(
    _ cli: CLI,
    request: SellPutUnderlyingRequest
) throws -> SellPutUnderlyingSnapshot {
    let brokerSymbol = longbridgeSymbol(request.symbol)
    let quoteJSON = try cli.json(["quote", brokerSymbol], name: "正股快照")
    let quote = records(quoteJSON, keys: ["data", "quotes", "list"]).first
    let currentPrice = double(quote?.decimal("last_done", "last", "last_price"))
    let klineJSON = try cli.json(
        ["kline", brokerSymbol, "--period", "day", "--count", "31", "--adjust", "forward"],
        name: "30 日 K 线"
    )
    let closes = records(klineJSON, keys: ["data", "candlesticks", "list"])
        .compactMap { double($0.decimal("close", "close_price")) }
    let change = closes.count >= 2 && closes[0] > 0
        ? ((closes[closes.count - 1] / closes[0]) - 1) * 100
        : nil
    var gaps: [String] = []
    if currentPrice == nil { gaps.append("正股现价不可用") }
    if change == nil { gaps.append("30 日 K 线不可用") }
    return SellPutUnderlyingSnapshot(
        providerId: "LONGBRIDGE",
        symbol: request.symbol,
        currentPrice: currentPrice,
        change30dPercent: change,
        capturedAt: fetchedAt(),
        dataGaps: gaps
    )
}

private func normalizeSymbol(_ raw: String, market: String?) -> String {
    let knownMarkets = Set(["US", "HK", "SG", "SH", "SZ"])
    let components = raw.split(separator: ".", maxSplits: 1).map(String.init)
    if components.count == 2 {
        if knownMarkets.contains(components[0].uppercased()) { return raw }
        if knownMarkets.contains(components[1].uppercased()) {
            return "\(components[1].uppercased()).\(components[0])"
        }
    }
    guard let market, !market.isEmpty else { return raw }
    return "\(market.uppercased()).\(raw)"
}

private func marketName(for symbol: String) -> String {
    if symbol.hasPrefix("HK.") || symbol.hasSuffix(".HK") { return "港股" }
    if symbol.hasPrefix("SG.") || symbol.hasSuffix(".SG") { return "新加坡" }
    if symbol.hasPrefix("SH.") || symbol.hasPrefix("SZ.")
        || symbol.hasSuffix(".SH") || symbol.hasSuffix(".SZ") { return "A 股" }
    return "美股"
}

private func sessionLabel(_ raw: String?) -> String {
    let value = raw?.lowercased() ?? ""
    if value.contains("overnight") || value.contains("night") { return "夜盘" }
    if value.contains("pre") { return "盘前" }
    if value.contains("after") || value.contains("post") { return "盘后" }
    if value.contains("open") || value.contains("trading") || value.contains("normal") {
        return "盘中"
    }
    if value.contains("close") { return "已收盘" }
    return raw?.isEmpty == false ? raw! : "状态未知"
}

private func sideValue(_ raw: String?) -> Int {
    let value = raw?.lowercased() ?? ""
    return value.contains("buy") ? 1 : value.contains("sell") ? 2 : 0
}

private func statusValue(_ raw: String?) -> Int {
    switch raw?.lowercased() ?? "" {
    case let value where value.contains("filled"): return 3
    case let value where value.contains("cancel"): return 4
    case let value where value.contains("reject"): return 5
    case let value where value.contains("partial"): return 2
    case let value where value.contains("new") || value.contains("wait"): return 1
    default: return 0
    }
}

private func verifyAuthorization(_ cli: CLI, forceRemoteCheck: Bool = false) throws {
    if cli.credentials != nil {
        if forceRemoteCheck {
            _ = try cli.json(["assets", "--currency", "USD"], name: "账户资产")
        }
        return
    }
    let json = try cli.json(["auth", "status"], name: "授权状态")
    let root = JSONRecord(value: json as? [String: Any] ?? [:])
    let token = root.object("token")
    let status = token?.string("status") ?? root.string("status")
    guard status == "authenticated" || status == "valid" || status == "logged_in" else {
        throw HostError.unauthorized
    }
}

private func makeSnapshot(_ cli: CLI, additionalSymbols: [String] = []) throws -> BrokerSnapshot {
    try verifyAuthorization(cli)
    let assetsJSON = try cli.json(["assets", "--currency", "USD"], name: "账户资产")
    guard let asset = records(assetsJSON, keys: ["data", "assets", "account"]).first else {
        throw HostError.missingField("assets")
    }
    guard let totalAssets = asset.decimal("net_assets", "netAssets"),
          let cash = asset.decimal("total_cash", "totalCash"),
          let buyingPower = asset.decimal("buy_power", "buyPower") else {
        throw HostError.missingField("net_assets/total_cash/buy_power")
    }
    let currency = asset.string("currency") ?? "USD"
    let account = AccountSummary(
        accountId: asset.string("account_id", "accountId") ?? "longbridge",
        environment: "REAL",
        totalAssets: totalAssets,
        cash: cash,
        buyingPower: buyingPower,
        currency: currency
    )

    let positionsJSON = try cli.json(["positions"], name: "持仓")
    let positionRecords = records(positionsJSON, keys: ["data", "positions", "list"])
    let positions = positionRecords.compactMap {
        record -> PositionSummary? in
        guard let rawSymbol = record.string("symbol", "code"),
              let quantity = record.decimal("quantity", "qty") else { return nil }
        let symbol = normalizeSymbol(rawSymbol, market: record.string("market"))
        return PositionSummary(
            id: symbol,
            symbol: symbol,
            name: record.string("name", "symbol_name") ?? symbol,
            quantity: quantity,
            costPrice: record.decimal("cost_price", "costPrice"),
            lastPrice: nil,
            todayProfit: nil,
            currency: record.string("currency") ?? currency
        )
    }

    let cliSymbols = Array(Set(
        positionRecords.compactMap { $0.string("symbol", "code") }
            + additionalSymbols.map(longbridgeSymbol)
    )).sorted()
    let symbols = Array(Set(positions.map(\.symbol) + additionalSymbols)).sorted()
    let quoteJSON: Any = cliSymbols.isEmpty
        ? []
        : try cli.json(["quote"] + cliSymbols, name: "报价")
    let quoteRecords = records(quoteJSON, keys: ["data", "quotes", "list"])
    var quotes = quoteRecords.compactMap { record -> QuoteSummary? in
        guard let rawSymbol = record.string("symbol", "code"),
              let last = record.decimal("last_done", "last", "last_price") else { return nil }
        let symbol = normalizeSymbol(rawSymbol, market: record.string("market"))
        let pre = record.object("pre_market_quote", "preMarketQuote")
        let post = record.object("post_market_quote", "postMarketQuote")
        let overnight = record.object("overnight_quote", "overnightQuote")
        return QuoteSummary(
            symbol: symbol,
            name: record.string("name") ?? symbol,
            lastPrice: last,
            openPrice: record.decimal("open"),
            highPrice: record.decimal("high"),
            lowPrice: record.decimal("low"),
            previousClose: record.decimal("prev_close", "previous_close"),
            volume: record.decimal("volume"),
            turnover: record.decimal("turnover"),
            updateTime: record.string("timestamp", "updated_at", "update_time"),
            preMarketPrice: pre?.decimal("last_done", "price"),
            afterHoursPrice: post?.decimal("last_done", "price"),
            overnightPrice: overnight?.decimal("last_done", "price"),
            marketState: sessionLabel(record.string("trade_status", "market_status")),
            marketStateValue: nil
        )
    }

    let quoteBySymbol = Dictionary(uniqueKeysWithValues: quotes.map { ($0.symbol, $0) })
    let normalizedPositions = positions.map { position in
        PositionSummary(
            id: position.id,
            symbol: position.symbol,
            name: position.name,
            quantity: position.quantity,
            costPrice: position.costPrice,
            lastPrice: quoteBySymbol[position.symbol]?.lastPrice,
            todayProfit: nil,
            currency: position.currency
        )
    }

    let marketJSON = try cli.json(["market-status"], name: "市场状态")
    let marketRecords = records(marketJSON, keys: ["data", "markets", "status"])
    let preferredMarket = symbols.first.map(marketName(for:)) ?? "美股"
    let preferredCode = preferredMarket == "港股" ? "HK" : preferredMarket == "A 股" ? "SH" : "US"
    let selectedMarket = marketRecords.first {
        let code = $0.string("market", "region", "exchange")?.uppercased() ?? ""
        return code.contains(preferredCode)
    } ?? marketRecords.first
    let marketState = sessionLabel(selectedMarket?.string("status", "trade_status", "state"))
    let market = MarketSummary(name: preferredMarket, state: marketState, stateValue: 0)

    quotes = quotes.map { quote in
        let state = marketName(for: quote.symbol) == preferredMarket
            ? marketState
            : quote.marketState
        return QuoteSummary(
            symbol: quote.symbol,
            name: quote.name,
            lastPrice: quote.lastPrice,
            openPrice: quote.openPrice,
            highPrice: quote.highPrice,
            lowPrice: quote.lowPrice,
            previousClose: quote.previousClose,
            volume: quote.volume,
            turnover: quote.turnover,
            updateTime: quote.updateTime,
            preMarketPrice: quote.preMarketPrice,
            afterHoursPrice: quote.afterHoursPrice,
            overnightPrice: quote.overnightPrice,
            marketState: state,
            marketStateValue: nil
        )
    }

    let minuteBars = try cliSymbols.prefix(8).flatMap { cliSymbol in
        records(
            try cli.json(
                ["kline", cliSymbol, "--period", "1m", "--count", "60", "--session", "all"],
                name: "\(cliSymbol) 分钟线"
            ),
            keys: ["data", "candlesticks", "list"]
        ).compactMap { record -> CandlestickSummary? in
            guard let time = record.string("time", "timestamp"),
                  let open = record.decimal("open"),
                  let high = record.decimal("high"),
                  let low = record.decimal("low"),
                  let close = record.decimal("close"),
                  let volume = record.decimal("volume") else { return nil }
            return CandlestickSummary(
                symbol: normalizeSymbol(cliSymbol, market: nil),
                time: time,
                open: open,
                high: high,
                low: low,
                close: close,
                volume: volume,
                turnover: record.decimal("turnover")
            )
        }
    }

    let currentOrders = try orderSummaries(
        cli.json(["order"], name: "当前订单")
    )
    let historicalOrders = try orderSummaries(
        cli.json(["order", "--history"], name: "历史订单")
    )
    let currentDeals = try fillSummaries(
        cli.json(["order", "executions"], name: "当前成交")
    )
    let historicalDeals = try fillSummaries(
        cli.json(["order", "executions", "--history"], name: "历史成交")
    )
    return BrokerSnapshot(
        account: account,
        positions: normalizedPositions,
        market: market,
        quotes: quotes,
        minuteBars: minuteBars,
        openOrders: currentOrders,
        recentDeals: currentDeals,
        historicalOrders: historicalOrders,
        historicalDeals: historicalDeals,
        dataGaps: ["Longbridge 逐笔暂未接入", "Longbridge 盘口暂未接入"]
    )
}

private func orderSummaries(_ json: Any) throws -> [BrokerOrderSummary] {
    records(json, keys: ["data", "orders", "list"]).compactMap { record in
        guard let orderId = record.string("order_id", "orderId"),
              let rawSymbol = record.string("symbol"),
              let quantity = record.decimal("quantity", "submitted_quantity"),
              let price = record.decimal("price", "submitted_price") else { return nil }
        let symbol = normalizeSymbol(rawSymbol, market: record.string("market"))
        return BrokerOrderSummary(
            orderId: orderId,
            symbol: symbol,
            name: record.string("name", "symbol_name") ?? symbol,
            side: sideValue(record.string("side")),
            status: statusValue(record.string("status")),
            quantity: quantity,
            price: price,
            filledQuantity: record.decimal("executed_quantity", "filled_quantity") ?? 0,
            filledAveragePrice: record.decimal("executed_price", "filled_average_price"),
            createdAt: record.string("submitted_at", "created_at") ?? "",
            updatedAt: record.string("updated_at", "last_done_at") ?? ""
        )
    }
}

private func fillSummaries(_ json: Any) throws -> [BrokerFillSummary] {
    records(json, keys: ["data", "executions", "trades", "list"]).compactMap { record in
        guard let fillId = record.string("trade_id", "execution_id"),
              let orderId = record.string("order_id"),
              let rawSymbol = record.string("symbol"),
              let quantity = record.decimal("quantity"),
              let price = record.decimal("price") else { return nil }
        let symbol = normalizeSymbol(rawSymbol, market: record.string("market"))
        return BrokerFillSummary(
            fillId: fillId,
            orderId: orderId,
            symbol: symbol,
            name: record.string("name", "symbol_name") ?? symbol,
            side: sideValue(record.string("side")),
            quantity: quantity,
            price: price,
            createdAt: record.string("trade_done_at", "created_at") ?? ""
        )
    }
}

@main
private struct LongbridgeHostMain {
    static func main() async {
        do {
            let inputData = isatty(STDIN_FILENO) == 0
                ? FileHandle.standardInput.readDataToEndOfFile()
                : Data()
            let credentials: CredentialInput?
            if inputData.isEmpty {
                credentials = nil
            } else if let decoded = try? JSONDecoder().decode(
                CredentialInput.self,
                from: inputData
            ) {
                guard decoded.isComplete else {
                    throw HostError.commandFailed("Longbridge API 凭据不完整")
                }
                credentials = decoded
            } else {
                let object = try JSONSerialization.jsonObject(with: inputData)
                    as? [String: Any] ?? [:]
                if ["appKey", "appSecret", "accessToken"].contains(where: {
                    object[$0] != nil
                }) {
                    throw HostError.commandFailed("Longbridge API 凭据不完整")
                }
                credentials = nil
            }
            let cli = try CLI(credentials: credentials)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
            switch CommandLine.arguments.dropFirst().first {
            case "probe":
                try verifyAuthorization(cli, forceRemoteCheck: true)
                print("{\"connected\":true}")
            case "capabilities":
                FileHandle.standardOutput.write(try encoder.encode(makeCapabilities()))
            case "search-instruments":
                let request = try JSONDecoder().decode(
                    BrokerInstrumentSearchRequest.self,
                    from: inputData
                )
                try verifyAuthorization(cli)
                FileHandle.standardOutput.write(try encoder.encode(
                    try await searchInstruments(cli, request: request)
                ))
            case "option-expiries":
                let request = try JSONDecoder().decode(
                    BrokerOptionRequest.self,
                    from: inputData
                )
                try verifyAuthorization(cli)
                FileHandle.standardOutput.write(try encoder.encode(
                    optionExpiries(cli, request: request)
                ))
            case "option-chain":
                let request = try JSONDecoder().decode(
                    BrokerOptionRequest.self,
                    from: inputData
                )
                try verifyAuthorization(cli)
                FileHandle.standardOutput.write(try encoder.encode(
                    optionChain(cli, request: request)
                ))
            case "sell-put-option-quotes":
                let request = try JSONDecoder().decode(
                    SellPutOptionQuoteRequest.self,
                    from: inputData
                )
                try verifyAuthorization(cli)
                FileHandle.standardOutput.write(try encoder.encode(
                    sellPutOptionQuotes(cli, request: request)
                ))
            case "sell-put-underlying":
                let request = try JSONDecoder().decode(
                    SellPutUnderlyingRequest.self,
                    from: inputData
                )
                try verifyAuthorization(cli)
                FileHandle.standardOutput.write(try encoder.encode(
                    sellPutUnderlyingSnapshot(cli, request: request)
                ))
            case "snapshot":
                let data = try encoder.encode(makeSnapshot(
                    cli,
                    additionalSymbols: credentials?.symbols ?? []
                ))
                FileHandle.standardOutput.write(data)
            default:
                throw HostError.commandFailed("未知 Host 命令")
            }
        } catch {
            FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
            exit(EXIT_FAILURE)
        }
    }
}
