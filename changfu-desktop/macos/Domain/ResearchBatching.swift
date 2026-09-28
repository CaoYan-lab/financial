import Foundation

public enum ResearchBatching {
    public static let maximumSymbolsPerRequest = 100

    public static func conversationBatches(_ symbols: [String]) -> [[String]] {
        guard !symbols.isEmpty else { return [[]] }
        return stride(
            from: 0,
            to: symbols.count,
            by: maximumSymbolsPerRequest
        ).map { start in
            Array(
                symbols[
                    start..<min(start + maximumSymbolsPerRequest, symbols.count)
                ]
            )
        }
    }
}
