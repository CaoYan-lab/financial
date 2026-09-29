import Foundation

public struct ProviderPoolSummary: Codable, Equatable, Identifiable, Sendable {
    public let providerId: String
    public let status: String
    public let version: Int
    public let used: Int
    public let capacity: Int?
    public let updatedAt: String

    public var id: String { providerId }
}

public struct ProviderPoolEntitlement: Codable, Equatable, Sendable {
    public let active: Bool
    public let capacity: Int?
    public let used: Int
    public let replacementLimit: Int?
    public let replacementUsed: Int
    public let replacementWindowStart: String?
    public let replacementWindowEnd: String?

    public init(
        active: Bool,
        capacity: Int?,
        used: Int,
        replacementLimit: Int?,
        replacementUsed: Int,
        replacementWindowStart: String?,
        replacementWindowEnd: String?
    ) {
        self.active = active
        self.capacity = capacity
        self.used = used
        self.replacementLimit = replacementLimit
        self.replacementUsed = replacementUsed
        self.replacementWindowStart = replacementWindowStart
        self.replacementWindowEnd = replacementWindowEnd
    }
}

public struct ProviderPoolItem: Codable, Equatable, Identifiable, Sendable {
    public let itemId: String
    public let providerId: String
    public let providerSymbol: String
    public let canonicalSymbol: String
    public let displayName: String
    public let market: BrokerMarket
    public let instrumentType: BrokerInstrumentType
    public let optionType: BrokerOptionType?
    public let underlyingSymbol: String?
    public let expiryDate: String?
    public let strikePrice: String?
    public let currency: String
    public let contractMultiplier: String?
    public let status: String
    public let addedAt: String

    public var id: String { itemId }

    private enum CodingKeys: String, CodingKey {
        case itemId
        case providerId
        case providerSymbol
        case canonicalSymbol
        case displayName
        case market
        case instrumentType
        case optionType
        case underlyingSymbol
        case expiryDate
        case strikePrice
        case currency
        case contractMultiplier
        case status
        case addedAt
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        itemId = try values.decode(String.self, forKey: .itemId)
        providerId = try values.decode(String.self, forKey: .providerId)
        market = try values.decode(BrokerMarket.self, forKey: .market)
        providerSymbol = BrokerSymbolNormalizer.normalize(
            try values.decode(String.self, forKey: .providerSymbol)
        )
        canonicalSymbol = BrokerSymbolNormalizer.normalize(
            try values.decode(String.self, forKey: .canonicalSymbol)
        )
        displayName = try values.decode(String.self, forKey: .displayName)
        instrumentType = try values.decode(BrokerInstrumentType.self, forKey: .instrumentType)
        optionType = try values.decodeIfPresent(BrokerOptionType.self, forKey: .optionType)
        underlyingSymbol = try values.decodeIfPresent(String.self, forKey: .underlyingSymbol)
            .map(BrokerSymbolNormalizer.normalize)
        expiryDate = try values.decodeIfPresent(String.self, forKey: .expiryDate)
        strikePrice = try values.decodeIfPresent(String.self, forKey: .strikePrice)
        currency = try values.decode(String.self, forKey: .currency)
        contractMultiplier = try values.decodeIfPresent(
            String.self,
            forKey: .contractMultiplier
        )
        status = try values.decode(String.self, forKey: .status)
        addedAt = try values.decode(String.self, forKey: .addedAt)
    }
}

public struct ProviderPool: Codable, Equatable, Identifiable, Sendable {
    public let providerId: String
    public let status: String
    public let frozenReason: String?
    public let version: Int
    public let entitlement: ProviderPoolEntitlement
    public let items: [ProviderPoolItem]
    public let nextCursor: String?
    public let updatedAt: String

    public var id: String { providerId }

    public func appending(_ page: ProviderPool) -> ProviderPool {
        ProviderPool(
            providerId: providerId,
            status: page.status,
            frozenReason: page.frozenReason,
            version: page.version,
            entitlement: page.entitlement,
            items: items + page.items,
            nextCursor: page.nextCursor,
            updatedAt: page.updatedAt
        )
    }

    public init(
        providerId: String,
        status: String,
        frozenReason: String?,
        version: Int,
        entitlement: ProviderPoolEntitlement,
        items: [ProviderPoolItem],
        nextCursor: String?,
        updatedAt: String
    ) {
        self.providerId = providerId
        self.status = status
        self.frozenReason = frozenReason
        self.version = version
        self.entitlement = entitlement
        self.items = items
        self.nextCursor = nextCursor
        self.updatedAt = updatedAt
    }
}

public struct AddProviderPoolItemRequest: Encodable, Sendable {
    public let providerSymbol: String
    public let canonicalSymbol: String
    public let displayName: String
    public let market: BrokerMarket
    public let instrumentType: BrokerInstrumentType
    public let optionType: BrokerOptionType?
    public let underlyingSymbol: String?
    public let expiryDate: String?
    public let strikePrice: String?
    public let currency: String
    public let contractMultiplier: String?
    public let sourceVerifiedAt: String

    public init(instrument: BrokerInstrument, sourceVerifiedAt: String) {
        providerSymbol = BrokerSymbolNormalizer.normalize(instrument.providerSymbol)
        canonicalSymbol = BrokerSymbolNormalizer.normalize(instrument.canonicalSymbol)
        displayName = instrument.displayName
        market = instrument.market
        instrumentType = instrument.instrumentType
        optionType = nil
        underlyingSymbol = nil
        expiryDate = nil
        strikePrice = nil
        currency = instrument.currency
        contractMultiplier = nil
        self.sourceVerifiedAt = sourceVerifiedAt
    }

    public init(contract: BrokerOptionContract, sourceVerifiedAt: String) {
        providerSymbol = BrokerSymbolNormalizer.normalize(contract.providerSymbol)
        canonicalSymbol = BrokerSymbolNormalizer.normalize(contract.canonicalSymbol)
        displayName = contract.displayName
        market = contract.market
        instrumentType = contract.instrumentType
        optionType = contract.optionType
        underlyingSymbol = BrokerSymbolNormalizer.normalize(contract.underlyingSymbol)
        expiryDate = contract.expiryDate
        strikePrice = contract.strikePrice
        currency = contract.currency
        contractMultiplier = contract.contractMultiplier
        self.sourceVerifiedAt = sourceVerifiedAt
    }

    private enum CodingKeys: String, CodingKey {
        case providerSymbol
        case canonicalSymbol
        case displayName
        case market
        case instrumentType
        case optionType
        case underlyingSymbol
        case expiryDate
        case strikePrice
        case currency
        case contractMultiplier
        case sourceVerifiedAt
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(providerSymbol, forKey: .providerSymbol)
        try container.encode(canonicalSymbol, forKey: .canonicalSymbol)
        try container.encode(displayName, forKey: .displayName)
        try container.encode(market, forKey: .market)
        try container.encode(instrumentType, forKey: .instrumentType)
        try container.encode(optionType, forKey: .optionType)
        try container.encode(underlyingSymbol, forKey: .underlyingSymbol)
        try container.encode(expiryDate, forKey: .expiryDate)
        try container.encode(strikePrice, forKey: .strikePrice)
        try container.encode(currency, forKey: .currency)
        try container.encode(contractMultiplier, forKey: .contractMultiplier)
        try container.encode(sourceVerifiedAt, forKey: .sourceVerifiedAt)
    }
}

public struct ProviderPoolCacheSnapshot: Codable, Equatable, Sendable {
    public let listETag: String?
    public let summaries: [ProviderPoolSummary]
    public let poolETags: [String: String]
    public let pools: [String: ProviderPool]
    public let cachedAt: Date

    public init(
        listETag: String?,
        summaries: [ProviderPoolSummary],
        poolETags: [String: String],
        pools: [String: ProviderPool],
        cachedAt: Date = Date()
    ) {
        self.listETag = listETag
        self.summaries = summaries
        self.poolETags = poolETags
        self.pools = pools
        self.cachedAt = cachedAt
    }

    public static let empty = ProviderPoolCacheSnapshot(
        listETag: nil,
        summaries: [],
        poolETags: [:],
        pools: [:]
    )
}
