import Foundation

public struct ModelResult: Codable, Equatable, Sendable {
    public let schemaVersion: String
    public let requestId: String
    public let status: String
    public let responseType: String
    public let summary: String
    public let evidence: [Evidence]
    public let counterEvidence: [Evidence]
    public let risks: [String]
    public let dataGaps: [String]
    public let exitCondition: String?
    public let sourceValidUntil: String?
    public let orderIntent: SignedOrderIntent?
    public let signal: Signal?
    public let candidate: TradingCandidate?
    public let portfolioReview: [PortfolioDecision]?
    public let managedOrderReview: [ManagedOrderDecision]?

    public struct Evidence: Codable, Equatable, Identifiable, Sendable {
        public let id: String
        public let kind: String
        public let summary: String
        public let sourceAt: String?
    }

    public struct Signal: Codable, Equatable, Sendable {
        public let symbol: String
        public let action: String
        public let intent: String?
        public let confidence: Double
    }

    public struct PortfolioDecision: Codable, Equatable, Sendable {
        public let candidateId: String
        public let status: String
        public let rank: Int?
        public let reason: String
    }

    public struct ManagedOrderDecision: Codable, Equatable, Sendable {
        public let intentId: String
        public let action: String
        public let reason: String
    }
}

public struct ModelRunEvent: Codable, Sendable {
    public let type: String
    public let requestId: String
    public let occurredAt: String
    public let stage: String?
    public let percent: Int?
    public let result: ModelResult?
    public let error: Failure?

    public struct Failure: Codable, Sendable {
        public let code: String
        public let message: String
    }
}
