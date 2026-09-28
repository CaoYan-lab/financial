import Foundation

public enum BackendEnvironment: Equatable, Sendable {
    case cloud(baseURL: URL)
    case debugLocal

    public static let defaultCloudURL = URL(
        string: "https://s1t8is7jgm85sfs523g5l.apigateway-cn-beijing.volceapi.com"
    )!
    public static let debugLocalURL = URL(string: "http://127.0.0.1:4310")!

    public static func configuredCloud(
        processInfo: ProcessInfo = .processInfo,
        bundle: Bundle = .main
    ) -> BackendEnvironment {
        let bundleOrigin = bundle.object(
            forInfoDictionaryKey: "ChangFuPublicAPIOrigin"
        ) as? String
        let configured = processInfo.environment["CHANGFU_PUBLIC_API_ORIGIN"]
            ?? bundleOrigin
            ?? defaultCloudURL.absoluteString
        guard let url = URL(string: configured) else {
            return .cloud(baseURL: defaultCloudURL)
        }
        return .cloud(baseURL: url)
    }

    public var baseURL: URL {
        switch self {
        case .cloud(let baseURL):
            baseURL
        case .debugLocal:
            Self.debugLocalURL
        }
    }

    public var credentialAccount: String {
        switch self {
        case .cloud:
            "refresh-token.cloud"
        case .debugLocal:
            "refresh-token.debug-local"
        }
    }

    public var isDebug: Bool {
        if case .debugLocal = self { return true }
        return false
    }
}
