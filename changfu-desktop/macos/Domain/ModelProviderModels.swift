import Foundation

public enum ModelRoute {
    public static let official = "OFFICIAL"
}

public struct ConversationModelOption: Identifiable, Equatable, Sendable {
    public let id: String
    public let displayName: String
    public let detail: String

    public init(id: String, displayName: String, detail: String) {
        self.id = id
        self.displayName = displayName
        self.detail = detail
    }
}

public enum ModelProviderProtocol: String, CaseIterable, Codable, Hashable, Identifiable, Sendable {
    case responses = "OPENAI_RESPONSES"
    case chatCompletions = "OPENAI_CHAT_COMPLETIONS"

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .responses: "Responses API"
        case .chatCompletions: "Chat Completions"
        }
    }
}

public struct ThirdPartyModelConfiguration: Codable, Equatable, Sendable {
    public let configId: String
    public let displayName: String
    public let `protocol`: ModelProviderProtocol
    public let endpoint: String
    public let model: String
    public let enabled: Bool
    public let keyConfigured: Bool
    public let keyLastFour: String
    public let updatedAt: String
}

public struct ThirdPartyModelConfigurationEnvelope: Codable, Equatable, Sendable {
    public let eligible: Bool
    public let planCode: SubscriptionPlanCode?
    public let config: ThirdPartyModelConfiguration?
}

public struct SaveThirdPartyModelConfigurationRequest: Encodable, Sendable {
    public let displayName: String
    public let `protocol`: ModelProviderProtocol
    public let endpoint: String
    public let model: String
    public let apiKey: String?
    public let enabled: Bool

    public init(
        displayName: String,
        protocol: ModelProviderProtocol,
        endpoint: String,
        model: String,
        apiKey: String?,
        enabled: Bool
    ) {
        self.displayName = displayName
        self.protocol = `protocol`
        self.endpoint = endpoint
        self.model = model
        self.apiKey = apiKey
        self.enabled = enabled
    }
}
