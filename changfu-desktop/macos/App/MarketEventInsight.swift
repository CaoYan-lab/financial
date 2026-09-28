import ChangFuDomain
import Foundation

enum MarketTechnologyImpact: String {
    case positive
    case negative
    case mixed
    case limited
    case pending

    var title: String {
        switch self {
        case .positive: "偏利好"
        case .negative: "偏利空"
        case .mixed: "双向影响"
        case .limited: "影响有限"
        case .pending: "待观察"
        }
    }
}

enum MarketTechnologyRelevanceTier: Int {
    case excluded = 0
    case low = 1
    case significant = 2
    case high = 3
}

struct MarketTechnologyRelevance {
    let tier: MarketTechnologyRelevanceTier
    let reason: String

    var isVisible: Bool {
        tier == .high || tier == .significant
    }

    var isModelEligible: Bool {
        tier == .high
    }
}

enum MarketEventRelevance {
    static func evaluate(_ event: MarketEvent) -> MarketTechnologyRelevance {
        let text = [
            event.category,
            event.title,
            event.detail ?? ""
        ].joined(separator: " ").lowercased()

        if contains(text, hardExclusions) {
            return MarketTechnologyRelevance(
                tier: .excluded,
                reason: "通用经济噪声，与科技股缺少直接传导"
            )
        }

        switch event.group {
        case .usMacro:
            return macroRelevance(text)
        case .watchlist:
            return watchlistRelevance(event: event, text: text)
        case .breakingRisk:
            return breakingRiskRelevance(text)
        }
    }

    static func displayEvents(
        _ events: [MarketEvent],
        group: MarketEventGroup
    ) -> [MarketEvent] {
        let limit: Int
        switch group {
        case .usMacro: limit = 6
        case .watchlist: limit = 8
        case .breakingRisk: limit = 6
        }
        return Array(
            events
                .filter { evaluate($0).isVisible }
                .sorted(by: rankedBefore)
                .prefix(limit)
        )
    }

    static func modelEvents(_ events: [MarketEvent], limit: Int) -> [MarketEvent] {
        Array(
            events
                .filter {
                    evaluate($0).isModelEligible
                        && ($0.importance == .critical || $0.importance == .high)
                }
                .sorted(by: rankedBefore)
                .prefix(limit)
        )
    }

    private static let hardExclusions = [
        "drilling rig", "rig count", "wells drilled", "钻井井数", "钻井总数",
        "oil inventory", "gas inventory", "原油库存", "天然气库存",
        "three-month treasury", "3-month treasury", "3 month treasury",
        "6-month treasury", "6 month treasury", "三个月期国债", "六个月期国债",
        "bid multiple", "allocation ratio", "投标倍数", "分配比例",
        "red book", "红皮书零售"
    ]

    private static func macroRelevance(_ text: String) -> MarketTechnologyRelevance {
        if contains(text, [
            "fomc", "fedwatch", "federal funds", "interest rate decision",
            "powell", "美联储", "联邦基金", "议息"
        ]) {
            return high("直接改变利率路径与科技股估值折现率")
        }
        if contains(text, [
            "core cpi", "cpi", "core pce", "pce", "consumer price",
            "通胀", "消费者价格"
        ]) {
            return high("核心通胀直接影响降息预期与成长股估值")
        }
        if contains(text, [
            "nonfarm", "unemployment rate", "initial jobless", "jobless claims",
            "非农", "失业率", "初请失业金"
        ]) {
            return high("就业强弱同时影响盈利预期与美联储政策路径")
        }
        if contains(text, [
            "gross domestic product", "gdp", "ism", "pmi",
            "国内生产总值", "采购经理"
        ]) {
            return high("增长数据影响科技盈利预期与利率路径")
        }
        if contains(text, [
            "10-year treasury", "10 year treasury", "2-year treasury",
            "2 year treasury", "treasury yield", "dollar index",
            "十年期美债", "两年期美债", "美债收益率", "美元指数"
        ]) {
            return high("长端利率或美元异动直接影响科技股估值与海外收入")
        }
        return MarketTechnologyRelevance(
            tier: .low,
            reason: "不在科技股核心宏观白名单"
        )
    }

    private static func watchlistRelevance(
        event: MarketEvent,
        text: String
    ) -> MarketTechnologyRelevance {
        if ["EARNINGS", "FILING", "RATING"].contains(event.category) {
            return high("池内标的财报、公告或评级直接影响盈利预期")
        }
        if contains(text, [
            "guidance", "forecast", "merger", "acquisition", "antitrust",
            "investigation", "lawsuit", "product launch", "capacity",
            "semiconductor", "chip", "gpu", "artificial intelligence",
            "data center", "cloud", "cybersecurity", "supply chain",
            "指引", "预告", "并购", "反垄断", "调查", "诉讼",
            "产品发布", "产能", "半导体", "芯片", "算力", "人工智能",
            "数据中心", "云服务", "网络安全", "供应链"
        ]) {
            return high("池内标的关键业务、监管或供应链事件")
        }
        return MarketTechnologyRelevance(
            tier: .low,
            reason: "普通公司资讯，缺少明确财务或业务实质"
        )
    }

    private static func breakingRiskRelevance(_ text: String) -> MarketTechnologyRelevance {
        let hasControlledRisk = contains(text, [
            "trade_sanction", "supply_chain", "tariff", "sanction",
            "export control", "entity list", "embargo", "chip ban",
            "cyberattack", "ransomware", "outage", "disruption",
            "关税", "制裁", "出口管制", "实体清单", "禁运",
            "芯片禁令", "网络攻击", "勒索软件", "中断"
        ])
        let hasTechnologyTransmission = contains(text, [
            "semiconductor", "chip", "wafer", "foundry", "gpu",
            "artificial intelligence", "advanced computing", "server",
            "data center", "cloud", "software", "electronics", "tsmc",
            "nvidia", "asml", "半导体", "芯片", "晶圆", "代工",
            "算力", "人工智能", "服务器", "数据中心", "云服务",
            "软件", "消费电子", "台积电"
        ])
        if hasControlledRisk && hasTechnologyTransmission {
            return high("受控风险已明确传导至芯片、算力或科技供应链")
        }

        let hasStrategicRegion = contains(text, [
            "taiwan strait", "middle east", "red sea", "台湾海峡",
            "台海", "中东", "红海"
        ])
        let hasPhysicalTransmission = contains(text, [
            "shipping", "logistics", "energy", "oil", "factory", "port",
            "海运", "物流", "能源", "原油", "工厂", "港口"
        ])
        if hasStrategicRegion && hasPhysicalTransmission {
            return MarketTechnologyRelevance(
                tier: .significant,
                reason: "关键地区冲突可能通过能源或物流影响科技供应链"
            )
        }
        return MarketTechnologyRelevance(
            tier: .low,
            reason: "宽泛风险新闻，尚无明确科技产业传导"
        )
    }

    private static func rankedBefore(_ lhs: MarketEvent, _ rhs: MarketEvent) -> Bool {
        let lhsTier = evaluate(lhs).tier.rawValue
        let rhsTier = evaluate(rhs).tier.rawValue
        if lhsTier != rhsTier {
            return lhsTier > rhsTier
        }
        let lhsImportance = importanceRank(lhs.importance)
        let rhsImportance = importanceRank(rhs.importance)
        if lhsImportance != rhsImportance {
            return lhsImportance > rhsImportance
        }
        return lhs.publishedAt > rhs.publishedAt
    }

    private static func importanceRank(_ value: MarketEventImportance) -> Int {
        switch value {
        case .critical: 4
        case .high: 3
        case .medium: 2
        case .low: 1
        }
    }

    private static func high(_ reason: String) -> MarketTechnologyRelevance {
        MarketTechnologyRelevance(tier: .high, reason: reason)
    }

    private static func contains(_ value: String, _ terms: [String]) -> Bool {
        terms.contains { value.contains($0) }
    }
}

struct MarketEventInsight {
    let summary: String
    let category: String
    let previous: String
    let expectation: String
    let actual: String
    let surprise: String
    let impact: MarketTechnologyImpact
    let impactScope: String
    let impactReason: String
    let risks: [String]
}

enum MarketEventInterpreter {
    static func make(_ event: MarketEvent) -> MarketEventInsight {
        let profile = profile(for: event)
        let comparison = compare(actual: event.actual, consensus: event.consensus)
        let impact = impact(
            profile: profile,
            comparison: comparison,
            hasActual: hasValue(event.actual)
        )
        return MarketEventInsight(
            summary: summary(for: event, profile: profile),
            category: categoryTitle(event.category),
            previous: display(event.previous, fallback: "未提供"),
            expectation: display(event.consensus, fallback: "未提供"),
            actual: display(event.actual, fallback: "待公布"),
            surprise: surpriseText(
                actual: event.actual,
                consensus: event.consensus,
                comparison: comparison
            ),
            impact: impact,
            impactScope: impactScope(profile: profile, event: event),
            impactReason: impactReason(
                profile: profile,
                comparison: comparison,
                hasActual: hasValue(event.actual)
            ),
            risks: risks(for: event, profile: profile)
        )
    }

    private enum Profile {
        case inflation
        case rates
        case employment
        case growth
        case energy
        case earnings
        case tradeRisk
        case supplyChain
        case companyEvent
        case other
    }

    private enum Comparison {
        case above
        case below
        case inline
        case unavailable
    }

    private static func profile(for event: MarketEvent) -> Profile {
        let text = "\(event.category) \(event.title)".lowercased()
        if contains(text, ["cpi", "pce", "inflation", "price index", "通胀"]) {
            return .inflation
        }
        if contains(text, [
            "fedwatch", "fomc", "interest rate", "treasury", "bond auction",
            "yield", "利率", "国债"
        ]) {
            return .rates
        }
        if contains(text, [
            "nonfarm", "employment", "adp", "jobless", "unemployment",
            "就业", "失业"
        ]) {
            return .employment
        }
        if contains(text, [
            "gdp", "pmi", "ism", "retail sales", "national activity",
            "经济活动", "零售"
        ]) {
            return .growth
        }
        if contains(text, ["oil", "natural gas", "drilling", "原油", "天然气", "钻井"]) {
            return .energy
        }
        if event.category == "EARNINGS" {
            return .earnings
        }
        if contains(text, ["tariff", "sanction", "geopolitical", "关税", "制裁", "冲突"]) {
            return .tradeRisk
        }
        if contains(text, ["supply_chain", "supply chain", "供应链"]) {
            return .supplyChain
        }
        if event.group == .watchlist {
            return .companyEvent
        }
        return .other
    }

    private static func summary(for event: MarketEvent, profile: Profile) -> String {
        let title = event.title
        let lower = title.lowercased()
        if lower.contains("chicago fed national activity") {
            return "美国芝加哥联储全国活动指数"
        }
        if lower.contains("red book") && lower.contains("retail") {
            return "美国红皮书零售销售"
        }
        if lower.contains("adp") && lower.contains("employment") {
            return "美国 ADP 就业变化"
        }
        if lower.contains("natural gas") && lower.contains("drilling") {
            return "美国天然气钻井井数"
        }
        if lower.contains("oil") && lower.contains("drilling") {
            return "美国原油钻井井数"
        }
        if lower.contains("wells drilled") {
            return "美国油气钻井总数"
        }
        if lower.contains("three-month") && lower.contains("treasury") {
            return lower.contains("bid multiple")
                ? "美国 3 个月期国债拍卖投标倍数"
                : "美国 3 个月期国债拍卖利率"
        }
        if lower.contains("6-month") && lower.contains("treasury") {
            return lower.contains("bid multiple")
                ? "美国 6 个月期国债拍卖投标倍数"
                : "美国 6 个月期国债拍卖利率"
        }
        switch profile {
        case .inflation: return "美国通胀数据"
        case .rates: return "美国利率与流动性事件"
        case .employment: return "美国就业数据"
        case .growth: return "美国经济增长数据"
        case .energy: return "美国能源供给数据"
        case .earnings:
            return event.relatedSymbols.first.map { "\($0) 财报事件" } ?? "标的财报事件"
        case .tradeRisk: return "贸易与地缘风险事件"
        case .supplyChain: return "科技供应链风险事件"
        case .companyEvent, .other: return title
        }
    }

    private static func impact(
        profile: Profile,
        comparison: Comparison,
        hasActual: Bool
    ) -> MarketTechnologyImpact {
        guard hasActual else { return .pending }
        switch profile {
        case .inflation, .rates:
            switch comparison {
            case .above: return .negative
            case .below: return .positive
            case .inline: return .limited
            case .unavailable: return .mixed
            }
        case .tradeRisk, .supplyChain:
            return .negative
        case .employment, .growth:
            return comparison == .inline ? .limited : .mixed
        case .earnings:
            switch comparison {
            case .above: return .positive
            case .below: return .negative
            case .inline: return .limited
            case .unavailable: return .mixed
            }
        case .energy, .companyEvent, .other:
            return .limited
        }
    }

    private static func impactScope(profile: Profile, event: MarketEvent) -> String {
        switch profile {
        case .inflation, .rates:
            return "纳斯达克、半导体、软件及高估值成长股"
        case .employment, .growth:
            return "科技板块盈利预期与利率敏感型成长股"
        case .energy:
            return "数据中心能源成本及能源相关科技供应链"
        case .earnings, .companyEvent:
            return event.relatedSymbols.isEmpty
                ? "事件相关公司及同业"
                : event.relatedSymbols.joined(separator: "、")
        case .tradeRisk:
            return "半导体、硬件、跨境电商及全球化科技公司"
        case .supplyChain:
            return "芯片、消费电子、服务器与云基础设施"
        case .other:
            return "与美股科技板块相关性较低或尚不明确"
        }
    }

    private static func impactReason(
        profile: Profile,
        comparison: Comparison,
        hasActual: Bool
    ) -> String {
        guard hasActual else {
            switch profile {
            case .inflation, .rates:
                return "实际值公布前仅做情景判断：利率压力下降通常有利于科技股估值，反之形成压制。"
            case .tradeRisk, .supplyChain:
                return "需等待事件范围和持续时间确认，再评估收入、成本与供应链暴露。"
            default:
                return "实际值尚未公布，当前不能形成确定方向。"
            }
        }
        switch profile {
        case .inflation:
            return comparison == .below
                ? "通胀低于预期有助于缓解加息和长端利率压力，支持科技股估值。"
                : comparison == .above
                    ? "通胀高于预期可能推升利率路径，压制高估值科技股。"
                    : "通胀与预期接近，新增估值冲击有限。"
        case .rates:
            return comparison == .below
                ? "利率或收益率低于预期，折现率压力减弱，对成长股估值相对有利。"
                : comparison == .above
                    ? "利率或收益率高于预期，提高折现率并压制长久期科技资产。"
                    : "利率信号没有明显偏离预期，影响以板块内部轮动为主。"
        case .employment, .growth:
            return "数据同时影响增长预期和降息路径，强数据利好盈利但可能推迟降息，方向具有双重性。"
        case .energy:
            return "该指标主要反映能源供给，对科技股为间接影响，重点观察电力和数据中心成本。"
        case .earnings:
            return comparison == .above
                ? "实际表现高于一致预期，直接改善相关标的盈利预期。"
                : comparison == .below
                    ? "实际表现低于一致预期，可能引发盈利预测下修。"
                    : "需要结合指引、利润率和业务分部判断，单一数值不足以定方向。"
        case .tradeRisk:
            return "关税、制裁或冲突可能抬高硬件成本、限制市场准入并增加估值风险溢价。"
        case .supplyChain:
            return "供应中断可能影响芯片和硬件交付，并向云基础设施资本开支传导。"
        case .companyEvent:
            return "影响集中于关联标的，需结合公告或新闻正文确认财务和业务实质。"
        case .other:
            return "当前事件与美股科技的直接传导关系有限。"
        }
    }

    private static func risks(for event: MarketEvent, profile: Profile) -> [String] {
        var values = ["科技股影响为规则推导，不是券商原始结论或交易建议。"]
        if !hasValue(event.actual) {
            values.insert("实际值尚未公布，当前影响仅为情景预案。", at: 0)
        } else if !hasValue(event.consensus) {
            values.insert("缺少市场一致预期，无法计算可靠预期差。", at: 0)
        }
        if profile == .employment || profile == .growth {
            values.append("增长与利率路径可能给出相反信号，需结合美债收益率验证。")
        }
        return values
    }

    private static func surpriseText(
        actual: String?,
        consensus: String?,
        comparison: Comparison
    ) -> String {
        guard hasValue(actual) else { return "待公布" }
        guard hasValue(consensus) else { return "缺少预期，无法比较" }
        switch comparison {
        case .above: return "高于预期"
        case .below: return "低于预期"
        case .inline: return "符合预期"
        case .unavailable: return "已公布，需按原始口径比较"
        }
    }

    private static func compare(actual: String?, consensus: String?) -> Comparison {
        guard let actualValue = number(actual),
              let consensusValue = number(consensus) else {
            return .unavailable
        }
        let tolerance = max(abs(consensusValue) * 0.001, 0.000_001)
        if actualValue > consensusValue + tolerance { return .above }
        if actualValue < consensusValue - tolerance { return .below }
        return .inline
    }

    private static func number(_ value: String?) -> Double? {
        guard let value, !value.isEmpty else { return nil }
        let pattern = #"[-+]?\d[\d,]*(?:\.\d+)?"#
        guard let range = value.range(of: pattern, options: .regularExpression) else {
            return nil
        }
        return Double(value[range].replacingOccurrences(of: ",", with: ""))
    }

    private static func display(_ value: String?, fallback: String) -> String {
        hasValue(value) ? value! : fallback
    }

    private static func hasValue(_ value: String?) -> Bool {
        guard let value else { return false }
        return !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private static func contains(_ value: String, _ terms: [String]) -> Bool {
        terms.contains { value.contains($0) }
    }

    private static func categoryTitle(_ value: String) -> String {
        switch value {
        case "ECONOMIC_CALENDAR": "经济数据"
        case "FEDWATCH": "利率预期"
        case "EARNINGS": "财报"
        case "FILING": "公告"
        case "RATING": "评级"
        case "TRADE_SANCTION": "关税与制裁"
        case "GEOPOLITICAL_CONFLICT": "地缘冲突"
        case "SUPPLY_CHAIN": "供应链"
        default: "市场事件"
        }
    }
}
