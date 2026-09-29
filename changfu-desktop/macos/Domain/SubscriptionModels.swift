import Foundation

public enum SubscriptionPlanCode: String, Codable, Sendable {
    case lite = "LITE"
    case pro = "PRO"
    case flagship = "FLAGSHIP"
}

public enum SubscriptionBillingPeriod: String, CaseIterable, Codable, Identifiable, Sendable {
    case monthly = "MONTHLY"
    case quarterly = "QUARTERLY"
    case yearly = "YEARLY"

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .monthly: "月付"
        case .quarterly: "季付"
        case .yearly: "年付"
        }
    }
}

public struct SubscriptionProvider: Codable, Equatable, Identifiable, Sendable {
    public let providerId: String
    public let displayName: String
    public let status: String
    public let supportedMarkets: [BrokerMarket]
    public let supportedInstrumentTypes: [BrokerInstrumentType]

    public var id: String { providerId }
}

public struct SubscriptionPrice: Codable, Equatable, Identifiable, Sendable {
    public let priceId: String
    public let billingPeriod: SubscriptionBillingPeriod
    public let durationMonths: Int
    public let currency: String
    public let amountMinor: Int

    public var id: String { priceId }
    public var displayPrice: String {
        String(format: "¥%.2f", Double(amountMinor) / 100)
    }
}

public struct SubscriptionPlanFeatures: Codable, Equatable, Sendable {
    public let batchSize: Int
    public let optionResearch: Bool
    public let optionTrading: Bool
    public let poolCapacityProtectionLimit: Int?
}

public struct SubscriptionPlan: Codable, Equatable, Identifiable, Sendable {
    public let planVersionId: String
    public let planCode: SubscriptionPlanCode
    public let version: Int
    public let displayName: String
    public let status: String
    public let effectiveFrom: String
    public let brokerSlotLimit: Int
    public let poolCapacityPerProvider: Int?
    public let monthlyReplacementLimit: Int?
    public let features: SubscriptionPlanFeatures
    public let prices: [SubscriptionPrice]

    public var id: String { planVersionId }
}

public struct PaymentChannelAvailability: Codable, Equatable, Identifiable, Sendable {
    public let channel: SubscriptionPaymentChannel
    public let displayName: String
    public let available: Bool
    public let unavailableReason: String?

    public var id: String { channel.rawValue }
}

public struct SubscriptionCatalog: Codable, Equatable, Sendable {
    public let catalogVersion: String
    public let publishedAt: String
    public let currency: String
    public let providers: [SubscriptionProvider]
    public let plans: [SubscriptionPlan]
    public let paymentChannels: [PaymentChannelAvailability]
}

public struct SubscriptionBrokerSlot: Codable, Equatable, Identifiable, Sendable {
    public let slotId: String
    public let slotOrdinal: Int
    public let providerId: String?
    public let status: String
    public let boundAt: String?
    public let nextRebindAt: String?
    public let version: Int

    public var id: String { slotId }
}

public struct PendingSubscriptionChange: Codable, Equatable, Sendable {
    public let planVersionId: String
    public let planCode: SubscriptionPlanCode
    public let billingPeriod: SubscriptionBillingPeriod
    public let effectiveAt: String
    public let retainedProviderIds: [String]
}

public struct UserSubscription: Codable, Equatable, Identifiable, Sendable {
    public let subscriptionId: String
    public let planVersionId: String
    public let planCode: SubscriptionPlanCode
    public let planName: String
    public let billingPeriod: SubscriptionBillingPeriod
    public let status: String
    public let version: Int
    public let purchasedAt: String
    public let startsAt: String
    public let currentPeriodStart: String
    public let expiresAt: String
    public let remainingDays: Int
    public let pendingChange: PendingSubscriptionChange?
    public let slots: [SubscriptionBrokerSlot]

    public var id: String { subscriptionId }

    public func grantsResearchAccess(
        to providerId: String,
        at now: Date = Date()
    ) -> Bool {
        isActive(at: now) && hasActiveSlot(for: providerId)
    }

    public func isActive(at now: Date = Date()) -> Bool {
        guard status == "ACTIVE",
              let startsAt = Self.parseTimestamp(startsAt),
              let expiresAt = Self.parseTimestamp(expiresAt) else { return false }
        return startsAt <= now && now < expiresAt
    }

    public func hasActiveSlot(for providerId: String) -> Bool {
        return slots.contains {
            $0.status == "ACTIVE" && $0.providerId == providerId
        }
    }

    private static func parseTimestamp(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}

public struct SubscriptionCurrentEnvelope: Codable, Equatable, Sendable {
    public let subscription: UserSubscription?
}

public enum SubscriptionOrderType: String, Codable, Sendable {
    case new = "NEW"
    case renew = "RENEW"
    case upgrade = "UPGRADE"
}

public enum SubscriptionPaymentChannel: String, CaseIterable, Codable, Identifiable, Sendable {
    case wechat = "WECHAT"
    case alipay = "ALIPAY"
    case douyin = "DOUYIN"

    public var id: String { rawValue }
}

public struct SubscriptionProviderSelection: Codable, Equatable, Sendable {
    public let slotOrdinal: Int
    public let providerId: String

    public init(slotOrdinal: Int, providerId: String) {
        self.slotOrdinal = slotOrdinal
        self.providerId = providerId
    }
}

public struct SubscriptionPayment: Codable, Equatable, Sendable {
    public let channel: SubscriptionPaymentChannel
    public let paymentUrl: String?
    public let qrCodePayload: String?
    public let expiresAt: String
}

public struct SubscriptionOrder: Codable, Equatable, Identifiable, Sendable {
    public let orderId: String
    public let businessOrderNo: String
    public let orderType: SubscriptionOrderType
    public let planVersionId: String
    public let planCode: SubscriptionPlanCode
    public let billingPeriod: SubscriptionBillingPeriod
    public let currency: String
    public let originalAmountMinor: Int
    public let creditAmountMinor: Int
    public let payableAmountMinor: Int
    public let status: String
    public let providerSelections: [SubscriptionProviderSelection]
    public let quoteExpiresAt: String
    public let createdAt: String
    public let paidAt: String?
    public let payment: SubscriptionPayment?

    public var id: String { orderId }
    public var displayPayableAmount: String {
        String(format: "¥%.2f", Double(payableAmountMinor) / 100)
    }
}

public struct CreateSubscriptionOrderRequest: Encodable, Sendable {
    public let orderType: SubscriptionOrderType
    public let planVersionId: String
    public let billingPeriod: SubscriptionBillingPeriod
    public let providerSelections: [SubscriptionProviderSelection]

    public init(
        orderType: SubscriptionOrderType,
        planVersionId: String,
        billingPeriod: SubscriptionBillingPeriod,
        providerSelections: [SubscriptionProviderSelection]
    ) {
        self.orderType = orderType
        self.planVersionId = planVersionId
        self.billingPeriod = billingPeriod
        self.providerSelections = providerSelections
    }
}

public struct StartSubscriptionPaymentRequest: Encodable, Sendable {
    public let channel: SubscriptionPaymentChannel

    public init(channel: SubscriptionPaymentChannel) {
        self.channel = channel
    }
}

public struct ScheduleSubscriptionChangeRequest: Encodable, Sendable {
    public let planVersionId: String
    public let billingPeriod: SubscriptionBillingPeriod
    public let retainedProviderIds: [String]
    public let expectedVersion: Int

    public init(
        planVersionId: String,
        billingPeriod: SubscriptionBillingPeriod,
        retainedProviderIds: [String],
        expectedVersion: Int
    ) {
        self.planVersionId = planVersionId
        self.billingPeriod = billingPeriod
        self.retainedProviderIds = retainedProviderIds
        self.expectedVersion = expectedVersion
    }
}

public struct BindSubscriptionBrokerSlotRequest: Encodable, Sendable {
    public let providerId: String
    public let expectedVersion: Int

    public init(providerId: String, expectedVersion: Int) {
        self.providerId = providerId
        self.expectedVersion = expectedVersion
    }
}
