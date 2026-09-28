import Foundation

public enum MarketEventGroup: String, Codable, CaseIterable, Sendable {
    case usMacro = "US_MACRO"
    case watchlist = "WATCHLIST"
    case breakingRisk = "BREAKING_RISK"
}

public enum MarketEventImportance: String, Codable, CaseIterable, Sendable {
    case critical = "CRITICAL"
    case high = "HIGH"
    case medium = "MEDIUM"
    case low = "LOW"
}

public enum MarketIntelligenceAvailability: String, Codable, Sendable {
    case available = "AVAILABLE"
    case partial = "PARTIAL"
    case unavailable = "UNAVAILABLE"
    case providerUnsupported = "PROVIDER_UNSUPPORTED"
}

public struct MarketEvent: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let group: MarketEventGroup
    public let category: String
    public let title: String
    public let source: String
    public let publishedAt: String
    public let fetchedAt: String
    public let relatedSymbols: [String]
    public let importance: MarketEventImportance
    public let validUntil: String
    public let url: String?
    public let previous: String?
    public let consensus: String?
    public let actual: String?
    public let detail: String?

    public init(
        id: String,
        group: MarketEventGroup,
        category: String,
        title: String,
        source: String,
        publishedAt: String,
        fetchedAt: String,
        relatedSymbols: [String] = [],
        importance: MarketEventImportance,
        validUntil: String,
        url: String? = nil,
        previous: String? = nil,
        consensus: String? = nil,
        actual: String? = nil,
        detail: String? = nil
    ) {
        self.id = id
        self.group = group
        self.category = category
        self.title = title
        self.source = source
        self.publishedAt = publishedAt
        self.fetchedAt = fetchedAt
        self.relatedSymbols = relatedSymbols
        self.importance = importance
        self.validUntil = validUntil
        self.url = url
        self.previous = previous
        self.consensus = consensus
        self.actual = actual
        self.detail = detail
    }
}

public struct MarketIntelligenceSection: Codable, Equatable, Identifiable, Sendable {
    public var id: MarketEventGroup { group }
    public let group: MarketEventGroup
    public let availability: MarketIntelligenceAvailability
    public let message: String?
    public let events: [MarketEvent]

    public init(
        group: MarketEventGroup,
        availability: MarketIntelligenceAvailability,
        message: String? = nil,
        events: [MarketEvent] = []
    ) {
        self.group = group
        self.availability = availability
        self.message = message
        self.events = events
    }
}

public struct MarketIntelligenceSnapshot: Codable, Equatable, Sendable {
    public let providerId: String
    public let fetchedAt: String
    public let sections: [MarketIntelligenceSection]

    public init(
        providerId: String,
        fetchedAt: String,
        sections: [MarketIntelligenceSection]
    ) {
        self.providerId = providerId
        self.fetchedAt = fetchedAt
        self.sections = sections
    }

    public func section(_ group: MarketEventGroup) -> MarketIntelligenceSection {
        sections.first { $0.group == group }
            ?? MarketIntelligenceSection(
                group: group,
                availability: .unavailable,
                message: "数据组未返回"
            )
    }
}

public struct MarketIntelligenceRequest: Codable, Equatable, Sendable {
    public let symbols: [String]

    public init(symbols: [String]) {
        self.symbols = Array(Set(symbols)).sorted()
    }
}
