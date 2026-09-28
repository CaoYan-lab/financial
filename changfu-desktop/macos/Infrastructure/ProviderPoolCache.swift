import ChangFuDomain
import Foundation

public actor ProviderPoolCache {
    private let directoryURL: URL
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    public init(fileManager: FileManager = .default) {
        let applicationSupport = fileManager.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first
            ?? fileManager.temporaryDirectory
        directoryURL = applicationSupport
            .appending(path: "com.changfu.desktop", directoryHint: .isDirectory)
            .appending(path: "provider-pools", directoryHint: .isDirectory)
        encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
    }

    public func load(namespace: String) -> ProviderPoolCacheSnapshot? {
        let url = snapshotURL(namespace: namespace)
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? decoder.decode(ProviderPoolCacheSnapshot.self, from: data)
    }

    public func save(_ snapshot: ProviderPoolCacheSnapshot, namespace: String) throws {
        try FileManager.default.createDirectory(
            at: directoryURL,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        let data = try encoder.encode(snapshot)
        let url = snapshotURL(namespace: namespace)
        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o600],
            ofItemAtPath: url.path
        )
    }

    public func remove(namespace: String) {
        try? FileManager.default.removeItem(at: snapshotURL(namespace: namespace))
    }

    private func snapshotURL(namespace: String) -> URL {
        let safeNamespace = namespace.filter { $0.isASCII && ($0.isLetter || $0.isNumber) }
        return directoryURL.appending(path: "\(safeNamespace).json")
    }
}
