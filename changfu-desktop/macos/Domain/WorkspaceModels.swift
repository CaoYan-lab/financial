import Foundation

public enum TradingPlatform: String, CaseIterable, Identifiable, Sendable {
    case aShare
    case futu
    case longbridge

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .aShare: "A 股"
        case .futu: "Futu"
        case .longbridge: "Longbridge"
        }
    }

    public var isAvailable: Bool { self != .aShare }
}

public enum FutuWorkspace: String, CaseIterable, Identifiable, Sendable {
    case overview
    case market
    case research
    case trading
    case assets
    case strategyCenter

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .overview: "今日总览"
        case .market: "市场"
        case .research: "研究"
        case .trading: "交易"
        case .assets: "资产"
        case .strategyCenter: "策略中心"
        }
    }

    public var systemImage: String {
        switch self {
        case .overview: "rectangle.3.group"
        case .market: "chart.xyaxis.line"
        case .research: "doc.text.magnifyingglass"
        case .trading: "arrow.left.arrow.right"
        case .assets: "briefcase"
        case .strategyCenter: "scope"
        }
    }
}

public enum OpenDConnectionState: Equatable, Sendable {
    case disconnected
    case connecting
    case connected
    case sdkUnavailable
    case failed(String)

    public var label: String {
        switch self {
        case .disconnected: "OpenD 未连接"
        case .connecting: "OpenD 连接中"
        case .connected: "OpenD 已连接"
        case .sdkUnavailable: "Futu SDK 未配置"
        case .failed(let reason): "OpenD 异常：\(reason)"
        }
    }
}

public enum LongbridgeConnectionState: Equatable, Sendable {
    case disconnected
    case connecting
    case connected
    case unauthorized
    case cliUnavailable
    case failed(String)

    public var label: String {
        switch self {
        case .disconnected: "Longbridge 未连接"
        case .connecting: "Longbridge 连接中"
        case .connected: "Longbridge 已连接"
        case .unauthorized: "Longbridge 未授权"
        case .cliUnavailable: "Longbridge CLI 不可用"
        case .failed(let reason): "Longbridge 异常：\(reason)"
        }
    }
}

public struct AccountSummary: Codable, Equatable, Sendable {
    public let accountId: String
    public let environment: String
    public let totalAssets: Decimal
    public let cash: Decimal
    public let buyingPower: Decimal
    public let unrealizedProfit: Decimal?
    public let realizedProfit: Decimal?
    public let currency: String
    public let marginAccount: Bool?
    public let marginCallActive: Bool?
    public let shortRiskDisclosureAccepted: Bool?

    public init(
        accountId: String,
        environment: String,
        totalAssets: Decimal,
        cash: Decimal,
        buyingPower: Decimal,
        unrealizedProfit: Decimal? = nil,
        realizedProfit: Decimal? = nil,
        currency: String,
        marginAccount: Bool? = nil,
        marginCallActive: Bool? = nil,
        shortRiskDisclosureAccepted: Bool? = nil
    ) {
        self.accountId = accountId
        self.environment = environment
        self.totalAssets = totalAssets
        self.cash = cash
        self.buyingPower = buyingPower
        self.unrealizedProfit = unrealizedProfit
        self.realizedProfit = realizedProfit
        self.currency = currency
        self.marginAccount = marginAccount
        self.marginCallActive = marginCallActive
        self.shortRiskDisclosureAccepted = shortRiskDisclosureAccepted
    }

    public var totalProfit: Decimal? {
        guard unrealizedProfit != nil || realizedProfit != nil else { return nil }
        return (unrealizedProfit ?? 0) + (realizedProfit ?? 0)
    }
}

public struct PositionSummary: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let symbol: String
    public let name: String
    public let quantity: Decimal
    public let costPrice: Decimal?
    public let lastPrice: Decimal?
    public let todayProfit: Decimal?
    public let currency: String

    public init(
        id: String,
        symbol: String,
        name: String,
        quantity: Decimal,
        costPrice: Decimal?,
        lastPrice: Decimal?,
        todayProfit: Decimal?,
        currency: String
    ) {
        self.id = id
        self.symbol = symbol
        self.name = name
        self.quantity = quantity
        self.costPrice = costPrice
        self.lastPrice = lastPrice
        self.todayProfit = todayProfit
        self.currency = currency
    }
}

public struct MarketSummary: Codable, Equatable, Sendable {
    public let name: String
    public let state: String
    public let stateValue: Int

    public init(name: String, state: String, stateValue: Int) {
        self.name = name
        self.state = state
        self.stateValue = stateValue
    }
}

public struct QuoteSummary: Codable, Identifiable, Equatable, Sendable {
    public var id: String { symbol }
    public let symbol: String
    public let name: String
    public let lastPrice: Decimal
    public let openPrice: Decimal?
    public let highPrice: Decimal?
    public let lowPrice: Decimal?
    public let previousClose: Decimal?
    public let volume: Decimal?
    public let turnover: Decimal?
    public let updateTime: String?
    public let preMarketPrice: Decimal?
    public let afterHoursPrice: Decimal?
    public let overnightPrice: Decimal?
    public let marketState: String?
    public let marketStateValue: Int?
    public let bidPrice: Decimal?
    public let askPrice: Decimal?
    public let lotSize: Int?
    public let shortable: Bool?
    public let maxShortQuantity: Decimal?

    public init(
        symbol: String,
        name: String,
        lastPrice: Decimal,
        openPrice: Decimal?,
        highPrice: Decimal?,
        lowPrice: Decimal?,
        previousClose: Decimal?,
        volume: Decimal?,
        turnover: Decimal?,
        updateTime: String?,
        preMarketPrice: Decimal? = nil,
        afterHoursPrice: Decimal? = nil,
        overnightPrice: Decimal? = nil,
        marketState: String? = nil,
        marketStateValue: Int? = nil,
        bidPrice: Decimal? = nil,
        askPrice: Decimal? = nil,
        lotSize: Int? = nil,
        shortable: Bool? = nil,
        maxShortQuantity: Decimal? = nil
    ) {
        self.symbol = symbol
        self.name = name
        self.lastPrice = lastPrice
        self.openPrice = openPrice
        self.highPrice = highPrice
        self.lowPrice = lowPrice
        self.previousClose = previousClose
        self.volume = volume
        self.turnover = turnover
        self.updateTime = updateTime
        self.preMarketPrice = preMarketPrice
        self.afterHoursPrice = afterHoursPrice
        self.overnightPrice = overnightPrice
        self.marketState = marketState
        self.marketStateValue = marketStateValue
        self.bidPrice = bidPrice
        self.askPrice = askPrice
        self.lotSize = lotSize
        self.shortable = shortable
        self.maxShortQuantity = maxShortQuantity
    }
}

public struct CandlestickSummary: Codable, Identifiable, Equatable, Sendable {
    public var id: String { "\(symbol):\(time)" }
    public let symbol: String
    public let time: String
    public let open: Decimal
    public let high: Decimal
    public let low: Decimal
    public let close: Decimal
    public let volume: Decimal
    public let turnover: Decimal?

    public init(
        symbol: String,
        time: String,
        open: Decimal,
        high: Decimal,
        low: Decimal,
        close: Decimal,
        volume: Decimal,
        turnover: Decimal?
    ) {
        self.symbol = symbol
        self.time = time
        self.open = open
        self.high = high
        self.low = low
        self.close = close
        self.volume = volume
        self.turnover = turnover
    }
}

public struct TickerSummary: Codable, Identifiable, Equatable, Sendable {
    public var id: String { "\(symbol):\(sequence):\(time)" }
    public let symbol: String
    public let time: String
    public let sequence: Int64
    public let price: Decimal
    public let volume: Decimal
    public let direction: Int

    public init(
        symbol: String,
        time: String,
        sequence: Int64,
        price: Decimal,
        volume: Decimal,
        direction: Int
    ) {
        self.symbol = symbol
        self.time = time
        self.sequence = sequence
        self.price = price
        self.volume = volume
        self.direction = direction
    }
}

public struct OrderBookLevel: Codable, Identifiable, Equatable, Sendable {
    public var id: String { "\(side):\(level)" }
    public let side: String
    public let level: Int
    public let price: Decimal
    public let volume: Decimal
    public let orderCount: Int?

    public init(
        side: String,
        level: Int,
        price: Decimal,
        volume: Decimal,
        orderCount: Int?
    ) {
        self.side = side
        self.level = level
        self.price = price
        self.volume = volume
        self.orderCount = orderCount
    }
}

public struct OrderBookSummary: Codable, Identifiable, Equatable, Sendable {
    public var id: String { symbol }
    public let symbol: String
    public let asks: [OrderBookLevel]
    public let bids: [OrderBookLevel]

    public init(symbol: String, asks: [OrderBookLevel], bids: [OrderBookLevel]) {
        self.symbol = symbol
        self.asks = asks
        self.bids = bids
    }
}

public struct BrokerOrderSummary: Codable, Identifiable, Equatable, Sendable {
    public var id: String { orderId }
    public let orderId: String
    public let symbol: String
    public let name: String
    public let side: Int
    public let status: Int
    public let quantity: Decimal
    public let price: Decimal
    public let filledQuantity: Decimal
    public let filledAveragePrice: Decimal?
    public let createdAt: String
    public let updatedAt: String

    public init(
        orderId: String,
        symbol: String,
        name: String,
        side: Int,
        status: Int,
        quantity: Decimal,
        price: Decimal,
        filledQuantity: Decimal,
        filledAveragePrice: Decimal?,
        createdAt: String,
        updatedAt: String
    ) {
        self.orderId = orderId
        self.symbol = symbol
        self.name = name
        self.side = side
        self.status = status
        self.quantity = quantity
        self.price = price
        self.filledQuantity = filledQuantity
        self.filledAveragePrice = filledAveragePrice
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public struct BrokerFillSummary: Codable, Identifiable, Equatable, Sendable {
    public var id: String { fillId }
    public let fillId: String
    public let orderId: String
    public let symbol: String
    public let name: String
    public let side: Int
    public let quantity: Decimal
    public let price: Decimal
    public let createdAt: String

    public init(
        fillId: String,
        orderId: String,
        symbol: String,
        name: String,
        side: Int,
        quantity: Decimal,
        price: Decimal,
        createdAt: String
    ) {
        self.fillId = fillId
        self.orderId = orderId
        self.symbol = symbol
        self.name = name
        self.side = side
        self.quantity = quantity
        self.price = price
        self.createdAt = createdAt
    }
}

public struct BrokerSnapshot: Codable, Equatable, Sendable {
    public let account: AccountSummary
    public let positions: [PositionSummary]
    public let market: MarketSummary
    public let quotes: [QuoteSummary]
    public let minuteBars: [CandlestickSummary]
    public let tickerPoints: [TickerSummary]
    public let orderBooks: [OrderBookSummary]
    public let openOrders: [BrokerOrderSummary]
    public let recentDeals: [BrokerFillSummary]
    public let historicalOrders: [BrokerOrderSummary]
    public let historicalDeals: [BrokerFillSummary]
    public let dataGaps: [String]

    public init(
        account: AccountSummary,
        positions: [PositionSummary],
        market: MarketSummary,
        quotes: [QuoteSummary] = [],
        minuteBars: [CandlestickSummary] = [],
        tickerPoints: [TickerSummary] = [],
        orderBooks: [OrderBookSummary] = [],
        openOrders: [BrokerOrderSummary] = [],
        recentDeals: [BrokerFillSummary] = [],
        historicalOrders: [BrokerOrderSummary] = [],
        historicalDeals: [BrokerFillSummary] = [],
        dataGaps: [String] = []
    ) {
        self.account = account
        self.positions = positions
        self.market = market
        self.quotes = quotes
        self.minuteBars = minuteBars
        self.tickerPoints = tickerPoints
        self.orderBooks = orderBooks
        self.openOrders = openOrders
        self.recentDeals = recentDeals
        self.historicalOrders = historicalOrders
        self.historicalDeals = historicalDeals
        self.dataGaps = dataGaps
    }

    private enum CodingKeys: String, CodingKey {
        case account, positions, market, quotes, minuteBars, tickerPoints, orderBooks
        case openOrders, recentDeals, historicalOrders, historicalDeals, dataGaps
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        account = try values.decode(AccountSummary.self, forKey: .account)
        positions = try values.decode([PositionSummary].self, forKey: .positions)
        market = try values.decode(MarketSummary.self, forKey: .market)
        quotes = try values.decodeIfPresent([QuoteSummary].self, forKey: .quotes) ?? []
        minuteBars = try values.decodeIfPresent(
            [CandlestickSummary].self,
            forKey: .minuteBars
        ) ?? []
        tickerPoints = try values.decodeIfPresent(
            [TickerSummary].self,
            forKey: .tickerPoints
        ) ?? []
        orderBooks = try values.decodeIfPresent(
            [OrderBookSummary].self,
            forKey: .orderBooks
        ) ?? []
        openOrders = try values.decodeIfPresent(
            [BrokerOrderSummary].self,
            forKey: .openOrders
        ) ?? []
        recentDeals = try values.decodeIfPresent(
            [BrokerFillSummary].self,
            forKey: .recentDeals
        ) ?? []
        historicalOrders = try values.decodeIfPresent(
            [BrokerOrderSummary].self,
            forKey: .historicalOrders
        ) ?? []
        historicalDeals = try values.decodeIfPresent(
            [BrokerFillSummary].self,
            forKey: .historicalDeals
        ) ?? []
        dataGaps = try values.decodeIfPresent([String].self, forKey: .dataGaps) ?? []
    }
}
