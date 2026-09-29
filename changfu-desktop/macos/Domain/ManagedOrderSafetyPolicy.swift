import Foundation

public struct ManagedOrderSafetyInput: Equatable, Sendable {
    public let now: Date
    public let signalValidUntil: Date
    public let intentExpiresAt: Date
    public let submittedAt: Date
    public let orderType: String
    public let limitPrice: Decimal
    public let latestReferencePrice: Decimal?
    public let marketDataFresh: Bool
    public let marketSessionOpen: Bool
    public let securityHalted: Bool
    public let brokerMarketable: Bool
    public let accountRiskValid: Bool
    public let leaseValid: Bool
    public let connectionActive: Bool
    public let filledQuantity: Decimal
    public let lastFilledQuantity: Decimal
    public let lastFillProgressAt: Date?

    public init(
        now: Date,
        signalValidUntil: Date,
        intentExpiresAt: Date,
        submittedAt: Date,
        orderType: String,
        limitPrice: Decimal,
        latestReferencePrice: Decimal?,
        marketDataFresh: Bool,
        marketSessionOpen: Bool,
        securityHalted: Bool,
        brokerMarketable: Bool,
        accountRiskValid: Bool,
        leaseValid: Bool,
        connectionActive: Bool,
        filledQuantity: Decimal,
        lastFilledQuantity: Decimal,
        lastFillProgressAt: Date?
    ) {
        self.now = now
        self.signalValidUntil = signalValidUntil
        self.intentExpiresAt = intentExpiresAt
        self.submittedAt = submittedAt
        self.orderType = orderType
        self.limitPrice = limitPrice
        self.latestReferencePrice = latestReferencePrice
        self.marketDataFresh = marketDataFresh
        self.marketSessionOpen = marketSessionOpen
        self.securityHalted = securityHalted
        self.brokerMarketable = brokerMarketable
        self.accountRiskValid = accountRiskValid
        self.leaseValid = leaseValid
        self.connectionActive = connectionActive
        self.filledQuantity = filledQuantity
        self.lastFilledQuantity = lastFilledQuantity
        self.lastFillProgressAt = lastFillProgressAt
    }
}

public enum ManagedOrderSafetyPolicy {
    public static func cancellationReason(
        _ input: ManagedOrderSafetyInput
    ) -> String? {
        if input.signalValidUntil <= input.now { return "SIGNAL_EXPIRED" }
        if input.intentExpiresAt <= input.now { return "INTENT_EXPIRED" }
        if !input.leaseValid { return "LEASE_LOST" }
        if !input.connectionActive { return "CONNECTION_DISABLED" }
        if !input.marketSessionOpen { return "SESSION_ENDED" }
        if input.securityHalted { return "SECURITY_HALTED" }
        if !input.brokerMarketable { return "BROKER_NOT_MARKETABLE" }
        if !input.accountRiskValid { return "ACCOUNT_RISK_CHANGED" }
        guard input.marketDataFresh, let reference = input.latestReferencePrice,
              input.limitPrice > 0 else {
            return "MARKET_DATA_STALE"
        }
        let drift = abs(
            NSDecimalNumber(
                decimal: (reference - input.limitPrice) / input.limitPrice * 10_000
            ).doubleValue
        )
        if !drift.isFinite || drift > 15 { return "PRICE_DRIFT" }

        let timeout: TimeInterval = input.orderType == "MARKETABLE_LIMIT" ? 90 : 600
        if input.now.timeIntervalSince(input.submittedAt) >= timeout {
            return "FILL_TIMEOUT"
        }
        if input.filledQuantity > 0,
           input.filledQuantity == input.lastFilledQuantity,
           let progressAt = input.lastFillProgressAt,
           input.now.timeIntervalSince(progressAt) >= timeout {
            return "NO_FILL_PROGRESS"
        }
        return nil
    }
}
