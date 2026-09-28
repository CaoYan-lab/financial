import Foundation

public struct QuantEvaluationMarketDecision: Equatable, Sendable {
    public let shouldEvaluate: Bool
    public let sessionLabel: String?
    public let reason: String

    public init(shouldEvaluate: Bool, sessionLabel: String?, reason: String) {
        self.shouldEvaluate = shouldEvaluate
        self.sessionLabel = sessionLabel
        self.reason = reason
    }
}

public enum QuantEvaluationReadinessState: Equatable, Sendable {
    case ready
    case waiting
}

public struct QuantEvaluationReadinessDecision: Equatable, Sendable {
    public let state: QuantEvaluationReadinessState
    public let sessionLabel: String?
    public let reason: String

    public var shouldEvaluate: Bool { state == .ready }
}

public enum QuantEvaluationReadiness {
    public static func decide(
        market: BrokerMarket,
        marketState: String?,
        hasQuote: Bool,
        minuteBarCount: Int
    ) -> QuantEvaluationReadinessDecision {
        let session = QuantEvaluationMarketGate.decide(
            market: market,
            marketState: marketState
        )
        guard session.shouldEvaluate else {
            return QuantEvaluationReadinessDecision(
                state: .waiting,
                sessionLabel: session.sessionLabel,
                reason: session.reason
            )
        }
        guard hasQuote else {
            return QuantEvaluationReadinessDecision(
                state: .waiting,
                sessionLabel: session.sessionLabel,
                reason: "关键报价暂不可用，本轮不发送模型请求"
            )
        }
        guard minuteBarCount >= 5 else {
            return QuantEvaluationReadinessDecision(
                state: .waiting,
                sessionLabel: session.sessionLabel,
                reason: "分钟趋势数据不足（当前 \(minuteBarCount) 根，至少 5 根），本轮不发送模型请求"
            )
        }
        return QuantEvaluationReadinessDecision(
            state: .ready,
            sessionLabel: session.sessionLabel,
            reason: "\(session.sessionLabel ?? market.rawValue)数据就绪，等待本轮评估"
        )
    }
}

public enum QuantEvaluationMarketGate {
    public static func decide(
        market: BrokerMarket,
        marketState: String?
    ) -> QuantEvaluationMarketDecision {
        let state = normalized(marketState)
        switch market {
        case .hk:
            guard isRegularSession(state) else {
                return blocked(market: "港股", state: marketState)
            }
            return allowed("港股盘中")
        case .us:
            if isPreMarket(state) { return allowed("美股盘前") }
            if isRegularSession(state) { return allowed("美股盘中") }
            if isAfterHours(state) { return allowed("美股盘后") }
            return blocked(market: "美股", state: marketState)
        case .cn, .sg:
            return QuantEvaluationMarketDecision(
                shouldEvaluate: false,
                sessionLabel: nil,
                reason: "\(market.rawValue) 当前不在量化评估市场范围"
            )
        }
    }

    private static func allowed(_ session: String) -> QuantEvaluationMarketDecision {
        QuantEvaluationMarketDecision(
            shouldEvaluate: true,
            sessionLabel: session,
            reason: "\(session)允许量化评估"
        )
    }

    private static func blocked(
        market: String,
        state: String?
    ) -> QuantEvaluationMarketDecision {
        let label = state?.trimmingCharacters(in: .whitespacesAndNewlines)
        return QuantEvaluationMarketDecision(
            shouldEvaluate: false,
            sessionLabel: nil,
            reason: "\(market)当前状态\(label?.isEmpty == false ? "“\(label!)”" : "不可用")，跳过量化评估"
        )
    }

    private static func normalized(_ state: String?) -> String {
        let raw = state?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        switch raw {
        case "盘前": return "PREMARKET"
        case "盘中", "交易中": return "REGULAR"
        case "盘后": return "AFTERHOURS"
        case "夜盘": return "OVERNIGHT"
        default:
            return raw.uppercased().filter { $0.isLetter || $0.isNumber }
        }
    }

    private static func isPreMarket(_ state: String) -> Bool {
        state.contains("PREMARKET")
    }

    private static func isRegularSession(_ state: String) -> Bool {
        ["REGULAR", "RTH", "TRADING", "NORMAL", "MORNING", "AFTERNOON"]
            .contains(state)
    }

    private static func isAfterHours(_ state: String) -> Bool {
        state.contains("AFTERHOURS") || state.contains("POSTMARKET")
    }

}
