import Foundation

public struct AutoSubmitPreferenceScope: Equatable, Sendable {
    public let backend: String
    public let user: String
    public let provider: String

    public init(backend: String, user: String, provider: String) {
        self.backend = backend
        self.user = user
        self.provider = provider.uppercased()
    }
}

public final class AutoSubmitPreferenceStore {
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func value(for scope: AutoSubmitPreferenceScope) -> Bool? {
        defaults.object(forKey: key(for: scope)) as? Bool
    }

    public func set(_ enabled: Bool, for scope: AutoSubmitPreferenceScope) {
        defaults.set(enabled, forKey: key(for: scope))
    }

    private func key(for scope: AutoSubmitPreferenceScope) -> String {
        [
            "live-trading.auto-submit",
            encoded(scope.backend),
            encoded(scope.user),
            encoded(scope.provider)
        ].joined(separator: ".")
    }

    private func encoded(_ value: String) -> String {
        Data(value.utf8).base64EncodedString()
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "=", with: "")
    }
}

public enum LiveTradingBrokerRefreshPolicy {
    public static let minimumSnapshotInterval: TimeInterval = 10
    public static let rateLimitBackoff: TimeInterval = 31

    public static func shouldRefreshSnapshot(
        lastUpdatedAt: Date?,
        blockedUntil: Date?,
        now: Date = Date(),
        force: Bool = false
    ) -> Bool {
        if let blockedUntil, blockedUntil > now {
            return false
        }
        if force {
            return true
        }
        guard let lastUpdatedAt else {
            return true
        }
        return now.timeIntervalSince(lastUpdatedAt) >= minimumSnapshotInterval
    }

    public static func supervisorNeedsSnapshot(
        hasPendingActions: Bool,
        hasManagedOrders: Bool
    ) -> Bool {
        hasPendingActions || hasManagedOrders
    }
}
