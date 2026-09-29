import Foundation

public struct AuthenticationSession: Equatable, Sendable {
    public let accessToken: String
    public let accessExpiresAt: Date
    public let refreshExpiresAt: Date

    public init(
        accessToken: String,
        accessExpiresAt: Date,
        refreshExpiresAt: Date
    ) {
        self.accessToken = accessToken
        self.accessExpiresAt = accessExpiresAt
        self.refreshExpiresAt = refreshExpiresAt
    }
}

public struct TokenPair: Decodable, Sendable {
    public let accessToken: String
    public let accessExpiresAt: Date
    public let refreshToken: String
    public let refreshExpiresAt: Date
    public let deviceId: String?
    public let mustChangePassword: Bool?

    public init(
        accessToken: String,
        accessExpiresAt: Date,
        refreshToken: String,
        refreshExpiresAt: Date,
        deviceId: String? = nil,
        mustChangePassword: Bool? = nil
    ) {
        self.accessToken = accessToken
        self.accessExpiresAt = accessExpiresAt
        self.refreshToken = refreshToken
        self.refreshExpiresAt = refreshExpiresAt
        self.deviceId = deviceId
        self.mustChangePassword = mustChangePassword
    }

    public var session: AuthenticationSession {
        AuthenticationSession(
            accessToken: accessToken,
            accessExpiresAt: accessExpiresAt,
            refreshExpiresAt: refreshExpiresAt
        )
    }
}

public struct PasswordChangeRequest: Encodable, Sendable {
    public let nextPassword: String

    public init(nextPassword: String) {
        self.nextPassword = nextPassword
    }
}

public struct DesktopLoginRequest: Encodable, Sendable {
    public let username: String
    public let password: String
    public let deviceId: String
    public let deviceFingerprint: String
    public let displayName: String
    public let platform: String
    public let appVersion: String
    public let publicKey: String

    public init(
        username: String,
        password: String,
        deviceId: String,
        deviceFingerprint: String,
        displayName: String,
        platform: String,
        appVersion: String,
        publicKey: String
    ) {
        self.username = username
        self.password = password
        self.deviceId = deviceId
        self.deviceFingerprint = deviceFingerprint
        self.displayName = displayName
        self.platform = platform
        self.appVersion = appVersion
        self.publicKey = publicKey
    }
}
