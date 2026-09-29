import ChangFuDomain
import CryptoKit
import Foundation
import Security

public enum SecureCredentialError: LocalizedError {
    case keychain(OSStatus)
    case invalidDeviceKey
    case incompleteLongbridgeCredentials

    public var errorDescription: String? {
        switch self {
        case .keychain(let status): "系统钥匙串操作失败（\(status)）"
        case .invalidDeviceKey: "设备签名密钥损坏"
        case .incompleteLongbridgeCredentials: "请完整填写 App Key、App Secret 和 Access Token"
        }
    }
}

public struct DeviceIdentity: Sendable {
    public let deviceId: String
    public let fingerprint: String
    public let displayName: String
    public let publicKeyPEM: String
    public let privateKey: Curve25519.Signing.PrivateKey
}

public struct LongbridgeCredentials: Codable, Equatable, Sendable {
    public let appKey: String
    public let appSecret: String
    public let accessToken: String

    public init(appKey: String, appSecret: String, accessToken: String) {
        self.appKey = appKey.trimmingCharacters(in: .whitespacesAndNewlines)
        self.appSecret = appSecret.trimmingCharacters(in: .whitespacesAndNewlines)
        self.accessToken = accessToken.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public var isComplete: Bool {
        !appKey.isEmpty && !appSecret.isEmpty && !accessToken.isEmpty
    }
}

public final class SecureCredentialStore: @unchecked Sendable {
    private let service: String

    public init(service: String = "com.changfu.desktop") {
        self.service = service
    }

    public func refreshToken(for environment: BackendEnvironment) throws -> String? {
        if let data = try read(account: environment.credentialAccount) {
            return String(data: data, encoding: .utf8)
        }
        guard !environment.isDebug,
              let legacy = try read(account: "refresh-token") else {
            return nil
        }
        try save(legacy, account: environment.credentialAccount)
        try delete(account: "refresh-token")
        guard !legacy.isEmpty else { return nil }
        return String(data: legacy, encoding: .utf8)
    }

    public func saveRefreshToken(
        _ token: String,
        for environment: BackendEnvironment
    ) throws {
        try save(Data(token.utf8), account: environment.credentialAccount)
    }

    public func clearRefreshToken(for environment: BackendEnvironment) throws {
        try delete(account: environment.credentialAccount)
    }

    public func longbridgeCredentials() throws -> LongbridgeCredentials? {
        guard let data = try read(account: "longbridge-legacy-credentials") else {
            return nil
        }
        return try JSONDecoder().decode(LongbridgeCredentials.self, from: data)
    }

    public func saveLongbridgeCredentials(_ credentials: LongbridgeCredentials) throws {
        guard credentials.isComplete else {
            throw SecureCredentialError.incompleteLongbridgeCredentials
        }
        try save(
            JSONEncoder().encode(credentials),
            account: "longbridge-legacy-credentials"
        )
    }

    public func clearLongbridgeCredentials() throws {
        try delete(account: "longbridge-legacy-credentials")
    }

    public func deviceIdentity(
        for environment: BackendEnvironment? = nil,
        username: String? = nil
    ) throws -> DeviceIdentity {
        let legacyDeviceId = try stableString(account: "device-id") {
            UUID().uuidString.lowercased()
        }
        let deviceId: String
        if let environment,
           let username,
           !username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            deviceId = try stableString(
                account: Self.scopedDeviceAccount(for: environment, username: username)
            ) {
                UUID().uuidString.lowercased()
            }
        } else if let environment,
                  let active = try read(
                    account: "active-device-id.\(environment.credentialAccount)"
                  ).flatMap({ String(data: $0, encoding: .utf8) }),
                  !active.isEmpty {
            deviceId = active
        } else {
            deviceId = legacyDeviceId
        }
        let fingerprint = try stableString(account: "device-fingerprint") {
            Data((0..<32).map { _ in UInt8.random(in: .min ... .max) }).base64EncodedString()
        }
        let privateKey: Curve25519.Signing.PrivateKey
        if let raw = try read(account: "device-signing-key") {
            guard let restored = try? Curve25519.Signing.PrivateKey(rawRepresentation: raw) else {
                throw SecureCredentialError.invalidDeviceKey
            }
            privateKey = restored
        } else {
            privateKey = Curve25519.Signing.PrivateKey()
            try save(privateKey.rawRepresentation, account: "device-signing-key")
        }

        return DeviceIdentity(
            deviceId: deviceId,
            fingerprint: fingerprint,
            displayName: Host.current().localizedName ?? "Mac",
            publicKeyPEM: pemPublicKey(privateKey.publicKey.rawRepresentation),
            privateKey: privateKey
        )
    }

    public static func scopedDeviceAccount(
        for environment: BackendEnvironment,
        username: String
    ) -> String {
        let normalized = username.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let scope = "\(environment.credentialAccount):\(normalized)"
        let digest = SHA256.hash(data: Data(scope.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
        return "device-id.user.\(digest)"
    }

    public func activateDeviceIdentity(
        _ identity: DeviceIdentity,
        for environment: BackendEnvironment
    ) throws {
        try activateDeviceIdentity(identity.deviceId, for: environment)
    }

    public func activateDeviceIdentity(
        _ deviceId: String,
        for environment: BackendEnvironment
    ) throws {
        try save(
            Data(deviceId.utf8),
            account: "active-device-id.\(environment.credentialAccount)"
        )
    }

    private func stableString(account: String, create: () -> String) throws -> String {
        if let data = try read(account: account),
           let value = String(data: data, encoding: .utf8),
           !value.isEmpty {
            return value
        }
        let value = create()
        try save(Data(value.utf8), account: account)
        return value
    }

    private func read(account: String) throws -> Data? {
        var query = baseQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw SecureCredentialError.keychain(status) }
        return result as? Data
    }

    private func save(_ data: Data, account: String) throws {
        let query = baseQuery(account: account)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess { return }
        guard updateStatus == errSecItemNotFound else {
            throw SecureCredentialError.keychain(updateStatus)
        }
        var insertion = query
        for (key, value) in attributes {
            insertion[key] = value
        }
        let addStatus = SecItemAdd(insertion as CFDictionary, nil)
        guard addStatus == errSecSuccess else { throw SecureCredentialError.keychain(addStatus) }
    }

    private func delete(account: String) throws {
        let status = SecItemDelete(baseQuery(account: account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw SecureCredentialError.keychain(status)
        }
    }

    private func baseQuery(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
    }

    private func pemPublicKey(_ rawKey: Data) -> String {
        let subjectPublicKeyInfoPrefix = Data([
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03,
            0x2b, 0x65, 0x70, 0x03, 0x21, 0x00
        ])
        let encoded = (subjectPublicKeyInfoPrefix + rawKey).base64EncodedString()
        return """
        -----BEGIN PUBLIC KEY-----
        \(encoded)
        -----END PUBLIC KEY-----
        """
    }
}
