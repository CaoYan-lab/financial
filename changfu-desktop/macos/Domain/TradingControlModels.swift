import Foundation

public struct TradingCatalog: Codable, Equatable, Sendable {
    public let catalogVersion: String
    public let publishedAt: String
    public let models: [Model]
    public let strategies: [Strategy]
    public let prompts: [PromptSummary]
    public let riskPolicies: [RiskPolicy]

    public struct Model: Codable, Equatable, Identifiable, Sendable {
        public let id: String
        public let name: String
        public let roles: [String]
        public let capabilities: [String]
        public let latencyTier: String
        public let plans: [String]
    }

    public struct Strategy: Codable, Equatable, Identifiable, Sendable {
        public let id: String
        public let name: String
        public let version: String
        public let providers: [String]
        public let markets: [String]
        public let instrumentTypes: [String]
    }

    public struct PromptSummary: Codable, Equatable, Identifiable, Sendable {
        public let id: String
        public let name: String
        public let version: String
        public let role: String
        public let summary: String
        public let constraints: [String]
        public let outputFields: [String]
        public let publishedAt: String
        public let contentHash: String
    }

    public struct RiskPolicy: Codable, Equatable, Identifiable, Sendable {
        public let id: String
        public let name: String
        public let version: String
    }
}

public struct TradingConfiguration: Codable, Equatable, Sendable {
    public let brokerConnectionId: String
    public let provider: String
    public let version: Int
    public let catalogVersion: String
    public let executionMode: String
    public let confirmationMode: String
    public let models: Models
    public let strategyId: String
    public let singlePromptId: String
    public let portfolioPromptId: String
    public let managedOrderPromptId: String
    public let scanIntervalSeconds: Int
    public let portfolioReviewIntervalSeconds: Int
    public let candidateTtlSeconds: Int
    public let maxConcurrency: Int
    public let disableUsOvernightEvaluation: Bool
    public let riskPolicyId: String

    public struct Models: Codable, Equatable, Sendable {
        public let singleDecision: String
        public let portfolioReview: String
        public let managedOrderReview: String
    }
}

public struct SaveTradingConfigurationRequest: Codable, Equatable, Sendable {
    public let expectedVersion: Int
    public let catalogVersion: String
    public let executionMode: String
    public let confirmationMode: String
    public let models: TradingConfiguration.Models
    public let strategyId: String
    public let singlePromptId: String
    public let portfolioPromptId: String
    public let managedOrderPromptId: String
    public let scanIntervalSeconds: Int
    public let portfolioReviewIntervalSeconds: Int
    public let candidateTtlSeconds: Int
    public let maxConcurrency: Int
    public let disableUsOvernightEvaluation: Bool
    public let riskPolicyId: String

    public static func shadowDefault(
        catalog: TradingCatalog,
        provider: String
    ) throws -> Self {
        func model(for role: String) -> String? {
            catalog.models.first { $0.roles.contains(role) }?.id
        }
        func prompt(for role: String) -> String? {
            catalog.prompts.first { $0.role == role }?.id
        }
        guard let singleModel = model(for: "SINGLE_DECISION"),
              let portfolioModel = model(for: "PORTFOLIO_REVIEW"),
              let managedOrderModel = model(for: "MANAGED_ORDER_REVIEW"),
              let strategy = catalog.strategies.first(where: {
                  $0.providers.contains(provider)
              }),
              let singlePrompt = prompt(for: "SINGLE_DECISION"),
              let portfolioPrompt = prompt(for: "PORTFOLIO_REVIEW"),
              let managedOrderPrompt = prompt(for: "MANAGED_ORDER_REVIEW"),
              let riskPolicy = catalog.riskPolicies.first else {
            throw TradingConfigurationError.incompleteCatalog
        }
        return Self(
            expectedVersion: 0,
            catalogVersion: catalog.catalogVersion,
            executionMode: "DIRECT",
            confirmationMode: "MANUAL_CONFIRM",
            models: TradingConfiguration.Models(
                singleDecision: singleModel,
                portfolioReview: portfolioModel,
                managedOrderReview: managedOrderModel
            ),
            strategyId: strategy.id,
            singlePromptId: singlePrompt,
            portfolioPromptId: portfolioPrompt,
            managedOrderPromptId: managedOrderPrompt,
            scanIntervalSeconds: 60,
            portfolioReviewIntervalSeconds: 300,
            candidateTtlSeconds: 900,
            maxConcurrency: 2,
            disableUsOvernightEvaluation: true,
            riskPolicyId: riskPolicy.id
        )
    }

    public static func updating(
        _ configuration: TradingConfiguration,
        confirmationMode: String
    ) -> Self {
        Self(
            expectedVersion: configuration.version,
            catalogVersion: configuration.catalogVersion,
            executionMode: configuration.executionMode,
            confirmationMode: confirmationMode,
            models: configuration.models,
            strategyId: configuration.strategyId,
            singlePromptId: configuration.singlePromptId,
            portfolioPromptId: configuration.portfolioPromptId,
            managedOrderPromptId: configuration.managedOrderPromptId,
            scanIntervalSeconds: configuration.scanIntervalSeconds,
            portfolioReviewIntervalSeconds: configuration.portfolioReviewIntervalSeconds,
            candidateTtlSeconds: configuration.candidateTtlSeconds,
            maxConcurrency: configuration.maxConcurrency,
            disableUsOvernightEvaluation: configuration.disableUsOvernightEvaluation,
            riskPolicyId: configuration.riskPolicyId
        )
    }
}

public enum TradingConfigurationError: LocalizedError, Sendable {
    case incompleteCatalog

    public var errorDescription: String? {
        "交易目录缺少创建影子评估配置所需的模型、策略、提示词或风控策略"
    }
}

public struct ServerResearchPool: Codable, Equatable, Sendable {
    public let entitlement: Entitlement
    public let version: Int
    public let items: [Item]
    public let updatedAt: String

    public struct Entitlement: Codable, Equatable, Sendable {
        public let status: String
        public let planName: String?
        public let capacity: Int
        public let replacementLimit: Int
        public let replacementUsed: Int
        public let renewsAt: String?
    }

    public struct Item: Codable, Equatable, Identifiable, Sendable {
        public var id: String { symbol }
        public let symbol: String
        public let market: String
        public let instrumentType: String
        public let addedAt: String
    }
}

public struct TradingSignal: Codable, Equatable, Identifiable, Sendable {
    public var id: String { signalId }
    public let signalId: String
    public let requestId: String
    public let brokerConnectionId: String
    public let symbol: String
    public let action: String
    public let evidenceSummary: EvidenceSummary
    public let riskSummary: RiskSummary
    public let exitCondition: String?
    public let createdAt: String

    public struct EvidenceSummary: Codable, Equatable, Sendable {
        public let confidence: Double?
        public let intent: String?
        public let evidence: [ModelResult.Evidence]?
        public let counterEvidence: [ModelResult.Evidence]?
        public let sourceValidUntil: String?
    }

    public struct RiskSummary: Codable, Equatable, Sendable {
        public let risks: [String]?
        public let dataGaps: [String]?
        public let strategyId: String?
        public let riskPolicyId: String?
    }
}

public struct TradingCandidate: Codable, Equatable, Identifiable, Sendable {
    public var id: String { candidateId }
    public let candidateId: String
    public let brokerConnectionId: String
    public let signalId: String
    public let symbol: String
    public let side: String
    public let status: String
    public let rank: Int?
    public let poolVersion: Int
    public let configVersion: Int
    public let createdAt: String
    public let expiresAt: String
    public let updatedAt: String?
}

public struct ModelRunSummary: Codable, Equatable, Identifiable, Sendable {
    public var id: String { requestId }
    public let requestId: String
    public let brokerConnectionId: String
    public let purpose: String
    public let model: String
    public let promptVersion: String
    public let status: String
    public let requestedSymbols: [String]?
    public let result: ModelResult?
    public let errorCode: String?
    public let capturedAt: String
    public let sourceExpiresAt: String
    public let startedAt: String
    public let finishedAt: String?
}

public struct ModelRunPage: Codable, Equatable, Sendable {
    public let items: [ModelRunSummary]
    public let total: Int
    public let limit: Int
    public let offset: Int
}
