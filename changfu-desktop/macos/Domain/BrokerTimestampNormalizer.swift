import Foundation

public enum BrokerTimestampNormalizer {
    public static func date(from raw: String?, symbol: String) -> Date? {
        guard let raw = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty else {
            return nil
        }

        let fractionalISO8601 = ISO8601DateFormatter()
        fractionalISO8601.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let value = fractionalISO8601.date(from: raw)
            ?? ISO8601DateFormatter().date(from: raw) {
            return value
        }

        guard let timeZone = marketTimeZone(for: symbol) else {
            return nil
        }
        for format in ["yyyy-MM-dd HH:mm:ss.SSS", "yyyy-MM-dd HH:mm:ss"] {
            let formatter = DateFormatter()
            formatter.calendar = Calendar(identifier: .gregorian)
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.timeZone = timeZone
            formatter.dateFormat = format
            if let value = formatter.date(from: raw) {
                return value
            }
        }
        return nil
    }

    public static func iso8601UTC(from raw: String?, symbol: String) -> String? {
        guard let value = date(from: raw, symbol: symbol) else {
            return nil
        }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter.string(from: value)
    }

    public static func isFresh(
        _ raw: String?,
        symbol: String,
        relativeTo reference: Date = Date(),
        maximumAge: TimeInterval
    ) -> Bool {
        guard let value = date(from: raw, symbol: symbol) else {
            return false
        }
        return abs(reference.timeIntervalSince(value)) <= maximumAge
    }

    private static func marketTimeZone(for symbol: String) -> TimeZone? {
        let normalized = symbol.uppercased()
        let identifier: String
        if normalized.hasPrefix("HK.") || normalized.hasSuffix(".HK") {
            identifier = "Asia/Hong_Kong"
        } else if normalized.hasPrefix("SH.")
                    || normalized.hasPrefix("SZ.")
                    || normalized.hasSuffix(".SH")
                    || normalized.hasSuffix(".SZ") {
            identifier = "Asia/Shanghai"
        } else if normalized.hasPrefix("SG.") || normalized.hasSuffix(".SG") {
            identifier = "Asia/Singapore"
        } else if normalized.hasPrefix("US.") || normalized.hasSuffix(".US") {
            identifier = "America/New_York"
        } else {
            return nil
        }
        return TimeZone(identifier: identifier)
    }
}
