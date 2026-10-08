import Foundation

public enum ResearchModelProfile: String, CaseIterable, Codable, Identifiable, Sendable {
    case fast
    case deep
    case risk

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .fast: "快速研究"
        case .deep: "深度研究"
        case .risk: "风险复核"
        }
    }

    public var detail: String {
        switch self {
        case .fast: "优先速度，适合事实查询和盘中跟踪"
        case .deep: "优先证据完整性，适合标的与策略研究"
        case .risk: "优先反证、风险暴露与退出条件"
        }
    }
}

public enum ResearchSkill: String, CaseIterable, Codable, Identifiable, Sendable {
    case quantitative
    case sellPut

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .quantitative: "选股研究"
        case .sellPut: "SELL PUT 期权研究"
        }
    }

    public var detail: String {
        switch self {
        case .quantitative: "聚合价格、趋势、成交与事件证据，形成可复核的量化结论"
        case .sellPut: "基于当日全球市值 Top30、OpenD 行情与期权快照评估现金担保卖 Put"
        }
    }

    public var systemImage: String {
        switch self {
        case .quantitative: "chart.xyaxis.line"
        case .sellPut: "option"
        }
    }

    public var promptVersion: String {
        switch self {
        case .quantitative: "research-quantitative-v1"
        case .sellPut: "top30-mega-cap-csp-v3"
        }
    }

    public var sections: [String] {
        switch self {
        case .quantitative:
            [
                "SEC XBRL 基本面",
                "SEC 申报事件",
                "FINRA 卖空成交",
                "券商宏观环境",
                "前复权价格趋势"
            ]
        case .sellPut:
            ["Top30 与基本面", "趋势与波动率", "期权快照与流动性", "Top 5、Bottom 5 与退出条件"]
        }
    }
}

public enum ConversationCapabilityKind: String, Codable, Sendable {
    case skill
    case agent
    case tool

    public var title: String {
        switch self {
        case .skill: "技能"
        case .agent: "智能体"
        case .tool: "工具"
        }
    }
}

public struct ConversationCapability: Identifiable, Equatable, Sendable {
    public let id: String
    public let kind: ConversationCapabilityKind
    public let title: String
    public let detail: String
    public let systemImage: String
    public let promptVersion: String?
    public let modelProfile: ResearchModelProfile?
    public let toolPolicyVersion: String?

    public init(
        id: String,
        kind: ConversationCapabilityKind,
        title: String,
        detail: String,
        systemImage: String,
        promptVersion: String? = nil,
        modelProfile: ResearchModelProfile? = nil,
        toolPolicyVersion: String? = nil
    ) {
        self.id = id
        self.kind = kind
        self.title = title
        self.detail = detail
        self.systemImage = systemImage
        self.promptVersion = promptVersion
        self.modelProfile = modelProfile
        self.toolPolicyVersion = toolPolicyVersion
    }

    public var mention: String { "@\(title)" }

    public func isMentioned(in text: String) -> Bool {
        var searchStart = text.startIndex
        while searchStart < text.endIndex,
              let range = text.range(of: mention, range: searchStart..<text.endIndex) {
            let hasValidPrefix = range.lowerBound == text.startIndex
                || text[text.index(before: range.lowerBound)].isWhitespace
            let hasValidSuffix = range.upperBound == text.endIndex
                || text[range.upperBound].isWhitespace
                || "，。！？,.;；".contains(text[range.upperBound])
            if hasValidPrefix && hasValidSuffix {
                return true
            }
            searchStart = range.upperBound
        }
        return false
    }
}

public enum SubscriptionTier: String, CaseIterable, Codable, Identifiable, Sendable {
    case light
    case advanced
    case flagship

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .light: "轻量版"
        case .advanced: "高级版"
        case .flagship: "旗舰版"
        }
    }

    public var subtitle: String {
        switch self {
        case .light: "适合建立小规模研究池"
        case .advanced: "适合多标的、多技能研究"
        case .flagship: "适合高频研究与团队级能力"
        }
    }

    public var features: [String] {
        switch self {
        case .light:
            ["基础标的池额度", "选股研究技能", "标准模型档位", "按套餐周期替换标的"]
        case .advanced:
            ["扩展标的池额度", "全部研究技能", "深度模型档位", "更短的标的替换周期"]
        case .flagship:
            ["最高标的池额度", "全部研究技能", "优先模型路由", "最短的标的替换周期"]
        }
    }
}

public enum PaymentChannel: String, CaseIterable, Codable, Identifiable, Sendable {
    case wechat
    case alipay
    case douyin

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .wechat: "微信支付"
        case .alipay: "支付宝支付"
        case .douyin: "抖音支付"
        }
    }

    public var systemImage: String {
        switch self {
        case .wechat: "message.fill"
        case .alipay: "a.circle.fill"
        case .douyin: "music.note"
        }
    }
}

public enum ResearchEntitlementStatus: String, Codable, Sendable {
    case unavailable
    case active
    case expired
}

public struct ResearchPoolEntitlement: Codable, Equatable, Sendable {
    public let status: ResearchEntitlementStatus
    public let planName: String?
    public let poolLimit: Int
    public let replacementIntervalDays: Int?
    public let nextReplacementAt: Date?

    public init(
        status: ResearchEntitlementStatus,
        planName: String?,
        poolLimit: Int,
        replacementIntervalDays: Int?,
        nextReplacementAt: Date?
    ) {
        self.status = status
        self.planName = planName
        self.poolLimit = max(0, poolLimit)
        self.replacementIntervalDays = replacementIntervalDays
        self.nextReplacementAt = nextReplacementAt
    }

    public static let unavailable = ResearchPoolEntitlement(
        status: .unavailable,
        planName: nil,
        poolLimit: 0,
        replacementIntervalDays: nil,
        nextReplacementAt: nil
    )
}

public struct ResearchPoolItem: Codable, Equatable, Identifiable, Sendable {
    public let symbol: String
    public let displayName: String
    public let lockedUntil: Date?

    public var id: String { symbol }

    public init(symbol: String, displayName: String, lockedUntil: Date?) {
        self.symbol = symbol
        self.displayName = displayName
        self.lockedUntil = lockedUntil
    }
}

public enum BrokerSearchMode: String, Codable, Sendable {
    case fuzzy = "FUZZY"
    case exactCode = "EXACT_CODE"
}

public enum BrokerMarket: String, CaseIterable, Codable, Sendable {
    case us = "US"
    case hk = "HK"
    case cn = "CN"
    case sg = "SG"
}

public enum BrokerInstrumentType: String, CaseIterable, Codable, Sendable {
    case stock = "STOCK"
    case etf = "ETF"
    case option = "OPTION"
}

public enum BrokerOptionType: String, Codable, Sendable {
    case call = "CALL"
    case put = "PUT"
}

public struct BrokerCapability: Codable, Equatable, Sendable {
    public let providerId: String
    public let searchMode: BrokerSearchMode
    public let supportedMarkets: [BrokerMarket]
    public let supportedInstrumentTypes: [BrokerInstrumentType]
    public let supportsOptionChain: Bool

    public init(
        providerId: String,
        searchMode: BrokerSearchMode,
        supportedMarkets: [BrokerMarket],
        supportedInstrumentTypes: [BrokerInstrumentType],
        supportsOptionChain: Bool
    ) {
        self.providerId = providerId
        self.searchMode = searchMode
        self.supportedMarkets = supportedMarkets
        self.supportedInstrumentTypes = supportedInstrumentTypes
        self.supportsOptionChain = supportsOptionChain
    }
}

public struct BrokerInstrumentSearchRequest: Codable, Equatable, Sendable {
    public let query: String
    public let markets: [BrokerMarket]
    public let instrumentTypes: [BrokerInstrumentType]
    public let limit: Int

    public init(
        query: String,
        markets: [BrokerMarket],
        instrumentTypes: [BrokerInstrumentType],
        limit: Int = 100
    ) {
        self.query = query
        self.markets = markets
        self.instrumentTypes = instrumentTypes
        self.limit = limit
    }
}

public struct BrokerInstrument: Codable, Equatable, Identifiable, Sendable {
    public let providerId: String
    public let providerSymbol: String
    public let canonicalSymbol: String
    public let displayName: String
    public let market: BrokerMarket
    public let instrumentType: BrokerInstrumentType
    public let currency: String
    public let addable: Bool
    public let unavailableReason: String?

    public var id: String { "\(providerId):\(providerSymbol)" }

    public init(
        providerId: String,
        providerSymbol: String,
        canonicalSymbol: String,
        displayName: String,
        market: BrokerMarket,
        instrumentType: BrokerInstrumentType,
        currency: String,
        addable: Bool,
        unavailableReason: String?
    ) {
        self.providerId = providerId
        self.providerSymbol = providerSymbol
        self.canonicalSymbol = canonicalSymbol
        self.displayName = displayName
        self.market = market
        self.instrumentType = instrumentType
        self.currency = currency
        self.addable = addable
        self.unavailableReason = unavailableReason
    }
}

public struct BrokerInstrumentSearchResponse: Codable, Equatable, Sendable {
    public let providerId: String
    public let query: String
    public let queryMode: BrokerSearchMode
    public let results: [BrokerInstrument]
    public let fetchedAt: String

    public init(
        providerId: String,
        query: String,
        queryMode: BrokerSearchMode,
        results: [BrokerInstrument],
        fetchedAt: String
    ) {
        self.providerId = providerId
        self.query = query
        self.queryMode = queryMode
        self.results = results
        self.fetchedAt = fetchedAt
    }
}

public struct BrokerOptionRequest: Codable, Equatable, Sendable {
    public let underlyingSymbol: String
    public let expiryDate: String?

    public init(underlyingSymbol: String, expiryDate: String? = nil) {
        self.underlyingSymbol = underlyingSymbol
        self.expiryDate = expiryDate
    }
}

public struct BrokerOptionExpiry: Codable, Equatable, Identifiable, Sendable {
    public let underlyingSymbol: String
    public let expiryDate: String

    public var id: String { "\(underlyingSymbol):\(expiryDate)" }

    public init(underlyingSymbol: String, expiryDate: String) {
        self.underlyingSymbol = underlyingSymbol
        self.expiryDate = expiryDate
    }
}

public struct BrokerOptionExpiryResponse: Codable, Equatable, Sendable {
    public let providerId: String
    public let underlyingSymbol: String
    public let expiries: [BrokerOptionExpiry]
    public let fetchedAt: String

    public init(
        providerId: String,
        underlyingSymbol: String,
        expiries: [BrokerOptionExpiry],
        fetchedAt: String
    ) {
        self.providerId = providerId
        self.underlyingSymbol = underlyingSymbol
        self.expiries = expiries
        self.fetchedAt = fetchedAt
    }
}

public struct BrokerOptionContract: Codable, Equatable, Identifiable, Sendable {
    public let providerId: String
    public let providerSymbol: String
    public let canonicalSymbol: String
    public let displayName: String
    public let market: BrokerMarket
    public let instrumentType: BrokerInstrumentType
    public let optionType: BrokerOptionType
    public let underlyingSymbol: String
    public let expiryDate: String
    public let strikePrice: String
    public let currency: String
    public let contractMultiplier: String
    public let addable: Bool
    public let unavailableReason: String?

    public var id: String { "\(providerId):\(providerSymbol)" }

    public init(
        providerId: String,
        providerSymbol: String,
        canonicalSymbol: String,
        displayName: String,
        market: BrokerMarket,
        instrumentType: BrokerInstrumentType,
        optionType: BrokerOptionType,
        underlyingSymbol: String,
        expiryDate: String,
        strikePrice: String,
        currency: String,
        contractMultiplier: String,
        addable: Bool,
        unavailableReason: String?
    ) {
        self.providerId = providerId
        self.providerSymbol = providerSymbol
        self.canonicalSymbol = canonicalSymbol
        self.displayName = displayName
        self.market = market
        self.instrumentType = instrumentType
        self.optionType = optionType
        self.underlyingSymbol = underlyingSymbol
        self.expiryDate = expiryDate
        self.strikePrice = strikePrice
        self.currency = currency
        self.contractMultiplier = contractMultiplier
        self.addable = addable
        self.unavailableReason = unavailableReason
    }
}

public struct BrokerOptionChainResponse: Codable, Equatable, Sendable {
    public let providerId: String
    public let underlyingSymbol: String
    public let expiryDate: String
    public let contracts: [BrokerOptionContract]
    public let fetchedAt: String

    public init(
        providerId: String,
        underlyingSymbol: String,
        expiryDate: String,
        contracts: [BrokerOptionContract],
        fetchedAt: String
    ) {
        self.providerId = providerId
        self.underlyingSymbol = underlyingSymbol
        self.expiryDate = expiryDate
        self.contracts = contracts
        self.fetchedAt = fetchedAt
    }
}
