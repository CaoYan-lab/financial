import Foundation

public enum BrokerSymbolNormalizer {
    public static func normalize(_ symbol: String) -> String {
        var normalized = symbol
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .uppercased()
        for prefix in BrokerMarket.allCases.map(\.rawValue) {
            let duplicatedPrefix = "\(prefix).\(prefix)."
            while normalized.hasPrefix(duplicatedPrefix) {
                normalized.removeFirst(prefix.count + 1)
            }
        }
        return normalized
    }

    public static func prefixed(_ symbol: String, market: BrokerMarket) -> String {
        let normalized = normalize(symbol)
        let prefix = "\(market.rawValue)."
        return normalized.hasPrefix(prefix) ? normalized : prefix + normalized
    }
}
