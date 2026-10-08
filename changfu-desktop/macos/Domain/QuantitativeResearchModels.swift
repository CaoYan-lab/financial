import Foundation

public enum QuantitativeEvidenceValue: Codable, Equatable, Sendable {
    case string(String)
    case number(Double)
    case boolean(Bool)
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .boolean(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else {
            self = .string(try container.decode(String.self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .boolean(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    public var displayText: String {
        switch self {
        case .string(let value): value
        case .number(let value): String(format: "%.4f", value)
        case .boolean(let value): value ? "是" : "否"
        case .null: "不可用"
        }
    }
}

public enum QuantitativeEvidenceLayer: String, Codable, CaseIterable, Sendable {
    case fundamentals
    case filings
    case shortActivity
    case priceTrend
    case macroFit

    public var displayName: String {
        switch self {
        case .fundamentals: "基本面质量与成长"
        case .filings: "申报与公司事件"
        case .shortActivity: "卖空拥挤度"
        case .priceTrend: "价格趋势与风险"
        case .macroFit: "宏观适配"
        }
    }
}

public enum QuantitativeAvailability: String, Codable, Sendable {
    case available = "AVAILABLE"
    case partial = "PARTIAL"
    case unavailable = "UNAVAILABLE"

    public var displayName: String {
        switch self {
        case .available: "可用"
        case .partial: "部分可用"
        case .unavailable: "不可用"
        }
    }
}

public struct QuantitativeEvidence: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let layer: QuantitativeEvidenceLayer
    public let source: String
    public let title: String
    public let capturedAt: String
    public let asOf: String?
    public let value: QuantitativeEvidenceValue
    public let metadata: [String: QuantitativeEvidenceValue]?

    public init(
        id: String,
        layer: QuantitativeEvidenceLayer,
        source: String,
        title: String,
        capturedAt: String,
        asOf: String?,
        value: QuantitativeEvidenceValue,
        metadata: [String: QuantitativeEvidenceValue]? = nil
    ) {
        self.id = id
        self.layer = layer
        self.source = source
        self.title = title
        self.capturedAt = capturedAt
        self.asOf = asOf
        self.value = value
        self.metadata = metadata
    }
}

public struct QuantitativeBrokerObservationRequest: Codable, Equatable, Sendable {
    public let requestId: String
    public let rank: Int
    public let symbol: String
    public let ticker: String
    public let displayName: String

    public init(
        requestId: String,
        rank: Int,
        symbol: String,
        ticker: String,
        displayName: String
    ) {
        self.requestId = requestId
        self.rank = rank
        self.symbol = symbol
        self.ticker = ticker
        self.displayName = displayName
    }
}

public struct QuantitativeBrokerObservation: Codable, Equatable, Sendable {
    public let requestId: String
    public let rank: Int
    public let symbol: String
    public let ticker: String
    public let displayName: String
    public let providerId: String
    public let capturedAt: String
    public let currentPrice: Double?
    public let quoteFreshness: String
    public let adjustedDailyBarCount: Int
    public let evidence: [QuantitativeEvidence]
    public let dataGaps: [String]

    public init(
        requestId: String,
        rank: Int,
        symbol: String,
        ticker: String,
        displayName: String,
        providerId: String,
        capturedAt: String,
        currentPrice: Double?,
        quoteFreshness: String,
        adjustedDailyBarCount: Int,
        evidence: [QuantitativeEvidence],
        dataGaps: [String]
    ) {
        self.requestId = requestId
        self.rank = rank
        self.symbol = symbol
        self.ticker = ticker
        self.displayName = displayName
        self.providerId = providerId
        self.capturedAt = capturedAt
        self.currentPrice = currentPrice
        self.quoteFreshness = quoteFreshness
        self.adjustedDailyBarCount = adjustedDailyBarCount
        self.evidence = evidence
        self.dataGaps = dataGaps
    }
}

public struct QuantitativeMacroSnapshot: Codable, Equatable, Sendable {
    public let providerId: String
    public let capturedAt: String
    public let evidence: [QuantitativeEvidence]
    public let dataGaps: [String]

    public init(
        providerId: String,
        capturedAt: String,
        evidence: [QuantitativeEvidence],
        dataGaps: [String]
    ) {
        self.providerId = providerId
        self.capturedAt = capturedAt
        self.evidence = evidence
        self.dataGaps = dataGaps
    }
}

public protocol QuantitativeResearchBrokerClient: AnyObject {
    @MainActor
    func prepareQuantitativeResearch(symbols: [String]) async throws

    @MainActor
    func quantitativeResearchObservation(
        _ request: QuantitativeBrokerObservationRequest
    ) async throws -> QuantitativeBrokerObservation
}

public struct QuantitativePoolItem: Codable, Equatable, Identifiable, Sendable {
    public let itemId: String
    public let rank: Int
    public let ticker: String
    public let symbol: String
    public let displayName: String
    public let marketCap: String

    public var id: String { itemId }
}

public struct QuantitativePool: Codable, Equatable, Sendable {
    public let providerId: String
    public let version: Int
    public let capacity: Int
    public let universeSource: String
    public let universeAccessedAt: String
    public let updatedAt: String
    public let items: [QuantitativePoolItem]
}

public struct StartQuantitativeRunRequest: Encodable, Sendable {
    public let providerId: String
    public let poolVersion: Int
    public let modelProfile: String

    public init(providerId: String, poolVersion: Int, modelProfile: String) {
        self.providerId = providerId
        self.poolVersion = poolVersion
        self.modelProfile = modelProfile
    }
}

public struct QuantitativeRunItem: Codable, Equatable, Identifiable, Sendable {
    public let requestId: String
    public let rank: Int
    public let symbol: String
    public let ticker: String
    public let displayName: String
    public let status: String

    public var id: String { requestId }

    public init(
        requestId: String,
        rank: Int,
        symbol: String,
        ticker: String,
        displayName: String,
        status: String
    ) {
        self.requestId = requestId
        self.rank = rank
        self.symbol = symbol
        self.ticker = ticker
        self.displayName = displayName
        self.status = status
    }
}

public struct QuantitativeRun: Codable, Equatable, Sendable {
    public let runId: String
    public let providerId: String
    public let poolVersion: Int
    public let promptVersion: String
    public let scoringVersion: String
    public let status: String
    public let symbolCount: Int
    public let terminalCount: Int
    public let items: [QuantitativeRunItem]
}

public struct SubmitQuantitativeObservationRequest: Encodable, Sendable {
    public let providerId: String
    public let observation: QuantitativeBrokerObservation

    public init(providerId: String, observation: QuantitativeBrokerObservation) {
        self.providerId = providerId
        self.observation = observation
    }
}

public struct FinalizeQuantitativeRunRequest: Encodable, Sendable {
    public let providerId: String

    public init(providerId: String) {
        self.providerId = providerId
    }
}

public struct QuantitativeRunProgress: Codable, Equatable, Sendable {
    public let terminalCount: Int
    public let completedCount: Int
    public let rejectedCount: Int
    public let unavailableCount: Int
}

public struct QuantitativeItemSubmission: Codable, Equatable, Sendable {
    public let analysis: QuantitativeItemAnalysis
    public let progress: QuantitativeRunProgress
}

public struct QuantitativeDimensionScore: Codable, Equatable, Sendable {
    public let score: Int?
    public let availability: QuantitativeAvailability
}

public struct QuantitativeDimensions: Codable, Equatable, Sendable {
    public let fundamentals: QuantitativeDimensionScore
    public let filings: QuantitativeDimensionScore
    public let shortActivity: QuantitativeDimensionScore
    public let priceTrend: QuantitativeDimensionScore
    public let macroFit: QuantitativeDimensionScore

    public func score(for layer: QuantitativeEvidenceLayer) -> QuantitativeDimensionScore {
        switch layer {
        case .fundamentals: fundamentals
        case .filings: filings
        case .shortActivity: shortActivity
        case .priceTrend: priceTrend
        case .macroFit: macroFit
        }
    }
}

public struct QuantitativeItemAnalysis: Codable, Equatable, Identifiable, Sendable {
    public let requestId: String
    public let rank: Int
    public let finalRank: Int?
    public let symbol: String
    public let ticker: String
    public let displayName: String
    public let providerId: String
    public let status: String
    public let candidateStatus: String
    public let totalScore: Int?
    public let coverageWeight: Int
    public let dimensions: QuantitativeDimensions?
    public let summary: String
    public let evidenceIds: [String]
    public let counterEvidenceIds: [String]
    public let risks: [String]
    public let dataGaps: [String]
    public let invalidationConditions: [String]
    public let capturedAt: String
    public let rejectionReason: String?

    public var id: String { requestId }
}

public struct QuantitativeReportItem: Codable, Equatable, Identifiable, Sendable {
    public let requestId: String
    public let symbol: String
    public let ticker: String
    public let displayName: String?
    public let rank: Int
    public let status: String
    public let brokerObservation: QuantitativeBrokerObservation?
    public let officialEvidence: [QuantitativeEvidence]?
    public let analysis: QuantitativeItemAnalysis?
    public let errorCode: String?
    public let attempts: Int
    public let updatedAt: String

    public var id: String { requestId }
}

public struct QuantitativeRunCancelled: Codable, Equatable, Sendable {
    public let runId: String
    public let status: String
}

public struct QuantitativeReportSummaryPayload: Codable, Equatable, Sendable {
    public let generatedAt: String
    public let topFive: [QuantitativeItemAnalysis]
    public let watchlist: [QuantitativeItemAnalysis]
    public let bottomFive: [QuantitativeItemAnalysis]
    public let insufficient: [QuantitativeItemAnalysis]
}

public struct QuantitativeReport: Codable, Equatable, Identifiable, Sendable {
    public let runId: String
    public let providerId: String
    public let poolVersion: Int
    public let promptVersion: String
    public let scoringVersion: String
    public let modelProfile: String?
    public let status: String
    public let symbolCount: Int
    public let terminalCount: Int
    public let completedCount: Int
    public let rejectedCount: Int
    public let unavailableCount: Int
    public let candidateCount: Int
    public let dataGapCount: Int
    public let summary: QuantitativeReportSummaryPayload?
    public let markdown: String?
    public let errorCode: String?
    public let startedAt: String
    public let finishedAt: String?
    public let items: [QuantitativeReportItem]

    public var id: String { runId }
}

public struct QuantitativeReportHistoryItem: Codable, Equatable, Identifiable, Sendable {
    public let runId: String
    public let providerId: String
    public let poolVersion: Int
    public let promptVersion: String
    public let scoringVersion: String
    public let modelProfile: String?
    public let status: String
    public let symbolCount: Int
    public let terminalCount: Int
    public let candidateCount: Int
    public let dataGapCount: Int
    public let startedAt: String
    public let finishedAt: String?

    public var id: String { runId }
}

public struct QuantitativeReportHistoryPage: Codable, Equatable, Sendable {
    public let items: [QuantitativeReportHistoryItem]
    public let page: Int
    public let pageSize: Int
    public let total: Int
    public let totalPages: Int
}

public struct QuantitativeComparisonItem: Codable, Equatable, Identifiable, Sendable {
    public let ticker: String
    public let left: QuantitativeItemAnalysis?
    public let right: QuantitativeItemAnalysis?
    public let totalScoreDifference: Int?
    public let finalRankDifference: Int?

    public var id: String { ticker }
}

public struct QuantitativeReportComparison: Codable, Equatable, Sendable {
    public let leftRunId: String
    public let rightRunId: String
    public let versionWarning: Bool
    public let commonTickers: [String]
    public let leftOnlyTickers: [String]
    public let rightOnlyTickers: [String]
    public let topFiveOverlap: [String]
    public let topFiveOverlapRatio: Double
    public let spearmanRankCorrelation: Double?
    public let maximumRankDifference: Int?
    public let items: [QuantitativeComparisonItem]
}
