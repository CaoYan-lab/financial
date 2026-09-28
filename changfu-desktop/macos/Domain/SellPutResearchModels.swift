import Foundation

public struct SellPutPoolItem: Codable, Identifiable, Equatable, Sendable {
    public let itemId: String
    public let rank: Int
    public let symbol: String
    public let displayName: String
    public let market: BrokerMarket
    public let addedAt: String

    public var id: String { itemId }
}

public struct SellPutPool: Codable, Equatable, Sendable {
    public let providerId: String
    public let version: Int
    public let capacity: Int
    public let items: [SellPutPoolItem]
    public let updatedAt: String
    public let universe: SellPutUniverseMetadata?
}

public struct SellPutUniverseMetadata: Codable, Equatable, Sendable {
    public let kind: String
    public let source: String
    public let sourceAccessedAt: String
    public let fallback: Bool
}

public struct AddSellPutPoolItemRequest: Encodable, Sendable {
    public let symbol: String
    public let displayName: String
    public let market: BrokerMarket

    public init(symbol: String, displayName: String, market: BrokerMarket) {
        self.symbol = symbol
        self.displayName = displayName
        self.market = market
    }
}

public struct SellPutOptionSnapshot: Codable, Equatable, Sendable {
    public let code: String
    public let expiryDate: String
    public let strikePrice: Double
    public let bid: Double?
    public let ask: Double?
    public let lastPrice: Double?
    public let delta: Double?
    public let impliedVolatility: Double?
    public let volume: Double?
    public let openInterest: Double?
    public let contractMultiplier: Double

    public init(
        code: String,
        expiryDate: String,
        strikePrice: Double,
        bid: Double?,
        ask: Double?,
        lastPrice: Double?,
        delta: Double?,
        impliedVolatility: Double?,
        volume: Double?,
        openInterest: Double?,
        contractMultiplier: Double
    ) {
        self.code = code
        self.expiryDate = expiryDate
        self.strikePrice = strikePrice
        self.bid = bid
        self.ask = ask
        self.lastPrice = lastPrice
        self.delta = delta
        self.impliedVolatility = impliedVolatility
        self.volume = volume
        self.openInterest = openInterest
        self.contractMultiplier = contractMultiplier
    }
}

public struct SellPutObservation: Codable, Equatable, Sendable {
    public let requestId: String
    public let rank: Int
    public let symbol: String
    public let displayName: String
    public let country: String
    public let capturedAt: String
    public let currentPrice: Double?
    public let marketCap: Double?
    public let peRatio: Double?
    public let rsi14: Double?
    public let ma50: Double?
    public let ma200: Double?
    public let ivRank: Double?
    public let iv30: Double?
    public let nextEarningsDate: String?
    public let sevenDayNews: [String]
    public let trend20d: Double?
    public let trend60d: Double?
    public let trend120d: Double?
    public let distanceTo52wHigh: Double?
    public let distanceTo52wLow: Double?
    public let realizedVol30d: Double?
    public let change30dPercent: Double?
    public let option: SellPutOptionSnapshot?
    public let dataGaps: [String]

    public init(
        requestId: String,
        symbol: String,
        displayName: String,
        capturedAt: String,
        currentPrice: Double?,
        change30dPercent: Double?,
        option: SellPutOptionSnapshot?,
        dataGaps: [String],
        rank: Int = 1,
        country: String = "United States",
        marketCap: Double? = nil,
        peRatio: Double? = nil,
        rsi14: Double? = nil,
        ma50: Double? = nil,
        ma200: Double? = nil,
        ivRank: Double? = nil,
        iv30: Double? = nil,
        nextEarningsDate: String? = nil,
        sevenDayNews: [String] = [],
        trend20d: Double? = nil,
        trend60d: Double? = nil,
        trend120d: Double? = nil,
        distanceTo52wHigh: Double? = nil,
        distanceTo52wLow: Double? = nil,
        realizedVol30d: Double? = nil
    ) {
        self.requestId = requestId
        self.rank = rank
        self.symbol = symbol
        self.displayName = displayName
        self.country = country
        self.capturedAt = capturedAt
        self.currentPrice = currentPrice
        self.marketCap = marketCap
        self.peRatio = peRatio
        self.rsi14 = rsi14
        self.ma50 = ma50
        self.ma200 = ma200
        self.ivRank = ivRank
        self.iv30 = iv30
        self.nextEarningsDate = nextEarningsDate
        self.sevenDayNews = sevenDayNews
        self.trend20d = trend20d
        self.trend60d = trend60d
        self.trend120d = trend120d
        self.distanceTo52wHigh = distanceTo52wHigh
        self.distanceTo52wLow = distanceTo52wLow
        self.realizedVol30d = realizedVol30d
        self.change30dPercent = change30dPercent
        self.option = option
        self.dataGaps = dataGaps
    }

    private enum CodingKeys: String, CodingKey {
        case requestId, rank, symbol, displayName, country, capturedAt
        case currentPrice, marketCap, peRatio, rsi14, ma50, ma200, ivRank, iv30
        case nextEarningsDate, sevenDayNews, trend20d, trend60d, trend120d
        case distanceTo52wHigh, distanceTo52wLow, realizedVol30d
        case change30dPercent, option, dataGaps
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        requestId = try values.decode(String.self, forKey: .requestId)
        rank = try values.decodeIfPresent(Int.self, forKey: .rank) ?? 1
        symbol = try values.decode(String.self, forKey: .symbol)
        displayName = try values.decode(String.self, forKey: .displayName)
        country = try values.decodeIfPresent(String.self, forKey: .country) ?? "United States"
        capturedAt = try values.decode(String.self, forKey: .capturedAt)
        currentPrice = try values.decodeIfPresent(Double.self, forKey: .currentPrice)
        marketCap = try values.decodeIfPresent(Double.self, forKey: .marketCap)
        peRatio = try values.decodeIfPresent(Double.self, forKey: .peRatio)
        rsi14 = try values.decodeIfPresent(Double.self, forKey: .rsi14)
        ma50 = try values.decodeIfPresent(Double.self, forKey: .ma50)
        ma200 = try values.decodeIfPresent(Double.self, forKey: .ma200)
        ivRank = try values.decodeIfPresent(Double.self, forKey: .ivRank)
        iv30 = try values.decodeIfPresent(Double.self, forKey: .iv30)
        nextEarningsDate = try values.decodeIfPresent(String.self, forKey: .nextEarningsDate)
        sevenDayNews = try values.decodeIfPresent([String].self, forKey: .sevenDayNews) ?? []
        trend20d = try values.decodeIfPresent(Double.self, forKey: .trend20d)
        trend60d = try values.decodeIfPresent(Double.self, forKey: .trend60d)
        trend120d = try values.decodeIfPresent(Double.self, forKey: .trend120d)
        distanceTo52wHigh = try values.decodeIfPresent(Double.self, forKey: .distanceTo52wHigh)
        distanceTo52wLow = try values.decodeIfPresent(Double.self, forKey: .distanceTo52wLow)
        realizedVol30d = try values.decodeIfPresent(Double.self, forKey: .realizedVol30d)
        change30dPercent = try values.decodeIfPresent(Double.self, forKey: .change30dPercent)
        option = try values.decodeIfPresent(SellPutOptionSnapshot.self, forKey: .option)
        dataGaps = try values.decodeIfPresent([String].self, forKey: .dataGaps) ?? []
    }
}

public struct CreateSellPutReportRequest: Encodable, Sendable {
    public let providerId: String
    public let poolVersion: Int
    public let reportWindowDays = 30
    public let observations: [SellPutObservation]

    public init(providerId: String, poolVersion: Int, observations: [SellPutObservation]) {
        self.providerId = providerId
        self.poolVersion = poolVersion
        self.observations = observations
    }
}

public struct SellPutItemAnalysis: Codable, Equatable, Sendable {
    public let symbol: String
    public let displayName: String
    public let candidate: Bool
    public let score: Double?
    public let currentPrice: Double?
    public let change30dPercent: Double?
    public let optionCode: String?
    public let expiryDate: String?
    public let daysToExpiry: Int?
    public let strikePrice: Double?
    public let premium: Double?
    public let annualizedReturnPercent: Double?
    public let safetyMarginPercent: Double?
    public let cashRequired: Double?
    public let delta: Double?
    public let impliedVolatility: Double?
    public let bidAskSpreadPercent: Double?
    public let volume: Double?
    public let openInterest: Double?
    public let liquidity: String
    public let risks: [String]
    public let exitConditions: [String]
    public let dataGaps: [String]
    public let capturedAt: String
}

public struct SellPutReportItem: Codable, Identifiable, Equatable, Sendable {
    public let symbol: String
    public let sourceSnapshot: SellPutObservation
    public let analysis: SellPutItemAnalysis

    public var id: String { symbol }
}

public struct SellPutReportSummary: Codable, Equatable, Sendable {
    public let generatedAt: String
    public let isUsableForAnalysis: Bool
    public let candidateCount: Int
    public let dataGapCount: Int
    public let topOpportunities: [SellPutItemAnalysis]
    public let bottomRisks: [SellPutItemAnalysis]
}

public struct SellPutDataQuality: Codable, Equatable, Sendable {
    public let isUsableForAnalysis: Bool
    public let issueCount: Int
}

public struct SellPutReport: Codable, Identifiable, Equatable, Sendable {
    public let runId: String
    public let providerId: String
    public let poolVersion: Int
    public let reportWindowDays: Int
    public let promptVersion: String
    public let status: String
    public let symbolCount: Int
    public let candidateCount: Int
    public let dataGapCount: Int
    public let dataQuality: SellPutDataQuality
    public let summary: SellPutReportSummary?
    public let markdown: String?
    public let errorCode: String?
    public let startedAt: String
    public let finishedAt: String?
    public let items: [SellPutReportItem]

    public var id: String { runId }
}

public struct SellPutReportHistoryItem: Codable, Identifiable, Equatable, Sendable {
    public let runId: String
    public let providerId: String
    public let poolVersion: Int
    public let reportWindowDays: Int
    public let promptVersion: String
    public let status: String
    public let symbolCount: Int
    public let candidateCount: Int
    public let dataGapCount: Int
    public let startedAt: String
    public let finishedAt: String?

    public var id: String { runId }
}

public struct SellPutReportHistoryPage: Codable, Equatable, Sendable {
    public let items: [SellPutReportHistoryItem]
    public let page: Int
    public let pageSize: Int
    public let total: Int
    public let totalPages: Int
}

public struct SellPutOptionQuote: Codable, Equatable, Sendable {
    public let code: String
    public let lastPrice: Double?
    public let bid: Double?
    public let ask: Double?
    public let delta: Double?
    public let impliedVolatility: Double?
    public let volume: Double?
    public let openInterest: Double?

    public init(
        code: String,
        lastPrice: Double?,
        bid: Double?,
        ask: Double?,
        delta: Double?,
        impliedVolatility: Double?,
        volume: Double?,
        openInterest: Double?
    ) {
        self.code = code
        self.lastPrice = lastPrice
        self.bid = bid
        self.ask = ask
        self.delta = delta
        self.impliedVolatility = impliedVolatility
        self.volume = volume
        self.openInterest = openInterest
    }
}

public struct SellPutOptionQuoteRequest: Codable, Equatable, Sendable {
    public let optionSymbols: [String]

    public init(optionSymbols: [String]) {
        self.optionSymbols = optionSymbols
    }
}

public struct SellPutOptionQuoteResponse: Codable, Equatable, Sendable {
    public let providerId: String
    public let quotes: [SellPutOptionQuote]
    public let fetchedAt: String
    public let dataGaps: [String]

    public init(
        providerId: String,
        quotes: [SellPutOptionQuote],
        fetchedAt: String,
        dataGaps: [String]
    ) {
        self.providerId = providerId
        self.quotes = quotes
        self.fetchedAt = fetchedAt
        self.dataGaps = dataGaps
    }
}

public struct SellPutUnderlyingRequest: Codable, Equatable, Sendable {
    public let symbol: String

    public init(symbol: String) {
        self.symbol = symbol
    }
}

public struct SellPutUnderlyingSnapshot: Codable, Equatable, Sendable {
    public let providerId: String
    public let symbol: String
    public let currentPrice: Double?
    public let change30dPercent: Double?
    public let marketCap: Double?
    public let peRatio: Double?
    public let rsi14: Double?
    public let ma50: Double?
    public let ma200: Double?
    public let trend20d: Double?
    public let trend60d: Double?
    public let trend120d: Double?
    public let distanceTo52wHigh: Double?
    public let distanceTo52wLow: Double?
    public let realizedVol30d: Double?
    public let capturedAt: String
    public let dataGaps: [String]

    public init(
        providerId: String,
        symbol: String,
        currentPrice: Double?,
        change30dPercent: Double?,
        capturedAt: String,
        dataGaps: [String],
        marketCap: Double? = nil,
        peRatio: Double? = nil,
        rsi14: Double? = nil,
        ma50: Double? = nil,
        ma200: Double? = nil,
        trend20d: Double? = nil,
        trend60d: Double? = nil,
        trend120d: Double? = nil,
        distanceTo52wHigh: Double? = nil,
        distanceTo52wLow: Double? = nil,
        realizedVol30d: Double? = nil
    ) {
        self.providerId = providerId
        self.symbol = symbol
        self.currentPrice = currentPrice
        self.change30dPercent = change30dPercent
        self.marketCap = marketCap
        self.peRatio = peRatio
        self.rsi14 = rsi14
        self.ma50 = ma50
        self.ma200 = ma200
        self.trend20d = trend20d
        self.trend60d = trend60d
        self.trend120d = trend120d
        self.distanceTo52wHigh = distanceTo52wHigh
        self.distanceTo52wLow = distanceTo52wLow
        self.realizedVol30d = realizedVol30d
        self.capturedAt = capturedAt
        self.dataGaps = dataGaps
    }
}
