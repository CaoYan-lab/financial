import ChangFuDomain
import Foundation

public enum DecisionContextBuilder {
    public static func make(
        account: AccountSummary,
        market: MarketSummary,
        positions: [PositionSummary],
        quotes: [QuoteSummary],
        minuteBars: [CandlestickSummary],
        tickerPoints: [TickerSummary],
        orderBooks: [OrderBookSummary],
        openOrders: [BrokerOrderSummary],
        requestedSymbols: [String],
        riskPolicyId: String?,
        providerDataGaps: [String] = [],
        marketIntelligence: MarketIntelligenceSnapshot? = nil,
        sourceAt: Date
    ) -> [String: JSONValue] {
        let sourceTime = timestamp(sourceAt)
        let validUntil = timestamp(sourceAt.addingTimeInterval(300))
        let symbols = requestedSymbols.sorted()
        let quoteBySymbol = Dictionary(uniqueKeysWithValues: quotes.map { ($0.symbol, $0) })
        let bookBySymbol = Dictionary(uniqueKeysWithValues: orderBooks.map { ($0.symbol, $0) })
        let barsBySymbol = Dictionary(grouping: minuteBars, by: \.symbol)
        let ticksBySymbol = Dictionary(grouping: tickerPoints, by: \.symbol)

        var evidence: [JSONValue] = [
            evidenceItem(
                id: "ACCOUNT_SNAPSHOT",
                kind: "ACCOUNT",
                summary: "账户权益 \(account.totalAssets) \(account.currency)，现金 \(account.cash)，购买力 \(account.buyingPower)",
                sourceAt: sourceTime
            ),
            evidenceItem(
                id: "ORDER_SCOPE",
                kind: "ORDER",
                summary: "已注入 \(openOrders.count) 笔当前未终态订单，订单范围由本轮券商快照确认",
                sourceAt: sourceTime
            )
        ]
        var trends: [JSONValue] = []
        var windows: [JSONValue] = []
        var gaps: [JSONValue] = []

        for symbol in symbols {
            let quote = quoteBySymbol[symbol]
            let symbolBars = (barsBySymbol[symbol] ?? []).sorted { $0.time < $1.time }
            let symbolTicks = ticksBySymbol[symbol] ?? []
            let book = bookBySymbol[symbol]
            if let quote {
                evidence.append(evidenceItem(
                    id: evidenceId("QUOTE", symbol),
                    kind: "QUOTE",
                    summary: quoteSummary(quote),
                    sourceAt: quote.updateTime ?? sourceTime
                ))
            } else {
                gaps.append(gap(
                    code: "QUOTE_MISSING",
                    severity: "BLOCKING",
                    summary: "\(symbol) 缺少关键报价",
                    sourceSupport: "provider"
                ))
            }

            if let trend = trendValue(symbol: symbol, bars: symbolBars) {
                trends.append(trend.value)
                evidence.append(evidenceItem(
                    id: evidenceId("TREND", symbol),
                    kind: "TREND",
                    summary: trend.summary,
                    sourceAt: trend.sourceAt
                ))
                if symbolBars.count < 60 {
                    gaps.append(gap(
                        code: "MINUTE_WINDOW_PARTIAL",
                        severity: "DEGRADING",
                        summary: "\(symbol) 1 分钟线实际 \(symbolBars.count) 根，目标 60 根",
                        sourceSupport: "provider"
                    ))
                }
            } else {
                gaps.append(gap(
                    code: "TREND_MISSING",
                    severity: "BLOCKING",
                    summary: "\(symbol) 没有足够分钟线生成趋势",
                    sourceSupport: "provider"
                ))
            }

            let bookDepth = min(book?.asks.count ?? 0, book?.bids.count ?? 0)
            windows.append(.object([
                "symbol": .string(symbol),
                "minuteBars": countWindow(requested: 60, available: symbolBars.count),
                "tickerPoints": countWindow(requested: 50, available: symbolTicks.count),
                "orderBookDepth": countWindow(requested: 5, available: bookDepth)
            ]))
            if symbolTicks.isEmpty {
                gaps.append(gap(
                    code: "TICKER_POINTS_MISSING",
                    severity: "DEGRADING",
                    summary: "\(symbol) 缺少逐笔成交",
                    sourceSupport: "provider"
                ))
            }
            if bookDepth == 0 {
                gaps.append(gap(
                    code: "ORDER_BOOK_MISSING",
                    severity: "DEGRADING",
                    summary: "\(symbol) 缺少订单簿深度",
                    sourceSupport: "provider"
                ))
            }
        }

        appendMarketIntelligence(
            marketIntelligence,
            requestedSymbols: symbols,
            sourceAt: sourceAt,
            evidence: &evidence,
            gaps: &gaps
        )

        gaps.append(contentsOf: [
            gap(
                code: "ACCOUNT_RISK_BUDGET_UNAVAILABLE",
                severity: "DEGRADING",
                summary: "风险策略尚未下发可计算的单笔与组合最大亏损参数",
                sourceSupport: "policyUnavailable"
            ),
            gap(
                code: "POSITION_AVAILABLE_TO_CLOSE_UNSUPPORTED",
                severity: "DEGRADING",
                summary: "统一券商快照尚未提供可平数量",
                sourceSupport: "providerUnsupported"
            ),
            gap(
                code: "SECURITY_MARGIN_RATE_UNSUPPORTED",
                severity: "INFORMATIONAL",
                summary: "券商快照未提供个股保证金率及融资借券成本",
                sourceSupport: "providerUnsupported"
            )
        ])
        gaps.append(contentsOf: providerDataGaps.map { summary in
            gap(
                code: "PROVIDER_DATA_GAP",
                severity: providerGapSeverity(summary),
                summary: summary,
                sourceSupport: "provider"
            )
        })

        let exposure = symbols.map { symbol -> JSONValue in
            let direct = positions.filter { $0.symbol == symbol }
            let quantity = direct.reduce(Decimal.zero) { $0 + $1.quantity }
            evidence.append(evidenceItem(
                id: evidenceId("POSITION", symbol),
                kind: "POSITION",
                summary: "\(symbol) 直接正股/ETF 数量 \(quantity)，可平数量不可用",
                sourceAt: sourceTime
            ))
            return .object([
                "symbol": .string(symbol),
                "classification": .string("DIRECT_STOCK_OR_ETF"),
                "quantity": .string(quantity.description),
                "availableToClose": .null,
                "known": .bool(true)
            ])
        }
        let extendedPrices = symbols.map { symbol -> JSONValue in
            let quote = quoteBySymbol[symbol]
            return .object([
                "symbol": .string(symbol),
                "marketState": quote?.marketState.map(JSONValue.string)
                    ?? .string(market.state),
                "preMarketPrice": quote?.preMarketPrice.map(decimal) ?? .null,
                "afterHoursPrice": quote?.afterHoursPrice.map(decimal) ?? .null,
                "overnightPrice": quote?.overnightPrice.map(decimal) ?? .null,
                "sourceAt": quote?.updateTime.map(JSONValue.string) ?? .string(sourceTime)
            ])
        }

        return [
            "strategyRequirements": .object([
                "requiredContext": .array([
                    .string("ACCOUNT"),
                    .string("POSITION"),
                    .string("QUOTE"),
                    .string("MINUTE_TREND"),
                    .string("ORDER_SCOPE")
                ]),
                "optionalContext": .array([
                    .string("NEWS"),
                    .string("FILINGS"),
                    .string("EARNINGS"),
                    .string("CORPORATE_ACTIONS"),
                    .string("US_MACRO"),
                    .string("BREAKING_RISK"),
                    .string("SECURITY_MARGIN_RATE")
                ])
            ]),
            "evidenceCatalog": .array(evidence),
            "trendContext": .array(trends),
            "positionExposure": .array(exposure),
            "accountRisk": .object([
                "status": .string("ACCOUNT_SNAPSHOT_AVAILABLE"),
                "riskPolicyId": riskPolicyId.map(JSONValue.string) ?? .null,
                "equity": decimal(account.totalAssets),
                "cash": decimal(account.cash),
                "buyingPower": decimal(account.buyingPower),
                "currency": .string(account.currency),
                "maxPerTradeLoss": .null,
                "availablePortfolioRisk": .null,
                "budgetUnit": .string("MAX_LOSS_AT_INVALIDATION"),
                "detailAvailability": .string("UNAVAILABLE")
            ]),
            "ordersKnowledge": .object([
                "status": .string("KNOWN"),
                "openOrderCount": .number(Decimal(openOrders.count)),
                "scope": .string("BROKER_OPEN_ORDERS")
            ]),
            "dataWindow": .array(windows),
            "extendedSession": .array(extendedPrices),
            "gapCatalog": .array(gaps),
            "temporalBoundary": .object([
                "capturedAt": .string(sourceTime),
                "sourceValidUntil": .string(validUntil),
                "marketState": .string(market.state),
                "nextSessionOpen": .string("NOT_YET_OCCURRED"),
                "futureDataPolicy": .string("未来开盘价和跳空结果不得列为采集失败")
            ]),
            "outputContract": .object([
                "version": .string("model-result-v1"),
                "evidenceIdPolicy": .string("CATALOG_ONLY"),
                "holdRequiresEvidence": .bool(true),
                "gapSeverityPolicy": .string("ONLY_BLOCKING_FORCES_HOLD"),
                "allowedActions": .array([
                    .string("BUY"),
                    .string("SELL"),
                    .string("HOLD")
                ])
            ])
        ]
    }

    private static func appendMarketIntelligence(
        _ snapshot: MarketIntelligenceSnapshot?,
        requestedSymbols: [String],
        sourceAt: Date,
        evidence: inout [JSONValue],
        gaps: inout [JSONValue]
    ) {
        guard let snapshot else {
            gaps.append(gap(
                code: "MARKET_INTELLIGENCE_NOT_CONNECTED",
                severity: "INFORMATIONAL",
                summary: "宏观日历、标的池事件和突发风险尚未加载",
                sourceSupport: "notConnected"
            ))
            return
        }
        let requested = Set(requestedSymbols)
        evidence.append(evidenceItem(
            id: "MARKET_INTELLIGENCE_SCOPE",
            kind: "RISK",
            summary: "市场情报仅注入对美股科技高相关、仍有效且重要级为 HIGH/CRITICAL 的事件；突发风险优先，总量最多 10 条",
            sourceAt: timestamp(sourceAt)
        ))
        var remaining = 10
        let groupLimits: [(MarketEventGroup, Int)] = [
            (.breakingRisk, 4),
            (.watchlist, 3),
            (.usMacro, 3)
        ]
        for (group, groupLimit) in groupLimits {
            let section = snapshot.section(group)
            if section.availability == .unavailable
                || section.availability == .providerUnsupported {
                gaps.append(gap(
                    code: "MARKET_INTELLIGENCE_\(section.group.rawValue)_UNAVAILABLE",
                    severity: "INFORMATIONAL",
                    summary: section.message ?? "\(section.group.rawValue) 数据不可用",
                    sourceSupport: section.availability == .providerUnsupported
                        ? "providerUnsupported"
                        : "provider"
                ))
            } else if section.availability == .partial, let message = section.message {
                gaps.append(gap(
                    code: "MARKET_INTELLIGENCE_\(section.group.rawValue)_PARTIAL",
                    severity: "INFORMATIONAL",
                    summary: message,
                    sourceSupport: "provider"
                ))
            }

            guard remaining > 0 else { continue }
            let activeEvents = section.events
                .filter { event in
                    guard let validUntil = parseTimestamp(event.validUntil),
                          validUntil > sourceAt else {
                        return false
                    }
                    return event.group != .watchlist
                        || !requested.isDisjoint(with: event.relatedSymbols)
                }
            let selected = MarketEventRelevance.modelEvents(
                activeEvents,
                limit: min(groupLimit, remaining)
            )
            remaining -= selected.count
            for event in selected {
                evidence.append(evidenceItem(
                    id: "EVENT_\(event.id)",
                    kind: "RISK",
                    summary: marketEventSummary(event),
                    sourceAt: event.publishedAt
                ))
            }
        }
    }

    private static func marketEventSummary(_ event: MarketEvent) -> String {
        let insight = MarketEventInterpreter.make(event)
        let relevance = MarketEventRelevance.evaluate(event)
        var parts = [
            "\(insight.category)：\(insight.summary)",
            "来源“\(event.source)”发布“\(event.title)”",
            "发布时间 \(event.publishedAt)",
            "科技相关性 \(relevance.reason)",
            "预期差 \(insight.surprise)",
            "美股科技影响（规则推导）\(insight.impact.title)：\(insight.impactReason)",
            "事实边界：按来源标题筛选，未独立核实全文"
        ]
        if !event.relatedSymbols.isEmpty {
            parts.append("关联标的 \(event.relatedSymbols.joined(separator: ", "))")
        }
        let values = [
            event.previous.map { "前值 \($0)" },
            event.consensus.map { "预测 \($0)" },
            event.actual.map { "实际 \($0)" }
        ].compactMap { $0 }
        if !values.isEmpty {
            parts.append(values.joined(separator: "，"))
        }
        if let detail = event.detail, !detail.isEmpty {
            parts.append(detail)
        }
        return parts.joined(separator: "；")
    }

    private static func parseTimestamp(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }

    private static func trendValue(
        symbol: String,
        bars: [CandlestickSummary]
    ) -> (value: JSONValue, summary: String, sourceAt: String)? {
        guard bars.count >= 5, let latest = bars.last else { return nil }
        let closes = bars.map { NSDecimalNumber(decimal: $0.close).doubleValue }
        let shortCount = min(5, closes.count)
        let mediumCount = min(20, closes.count)
        let longCount = min(60, closes.count)
        let shortAverage = average(Array(closes.suffix(shortCount)))
        let mediumAverage = average(Array(closes.suffix(mediumCount)))
        let longAverage = average(Array(closes.suffix(longCount)))
        let latestClose = closes.last ?? 0
        let direction: String
        if latestClose > mediumAverage, shortAverage >= mediumAverage {
            direction = "UP"
        } else if latestClose < mediumAverage, shortAverage <= mediumAverage {
            direction = "DOWN"
        } else {
            direction = "RANGE"
        }
        let recent = Array(bars.suffix(mediumCount))
        let support = recent.map { NSDecimalNumber(decimal: $0.low).doubleValue }.min() ?? latestClose
        let resistance = recent.map { NSDecimalNumber(decimal: $0.high).doubleValue }.max() ?? latestClose
        let strength = latestClose == 0
            ? 0
            : min(1, abs(shortAverage - mediumAverage) / abs(latestClose))
        let summary = "\(symbol) 趋势 \(direction)，MA5 \(format(shortAverage))，MA\(mediumCount) \(format(mediumAverage))，支撑 \(format(support))，阻力 \(format(resistance))"
        return (
            .object([
                "symbol": .string(symbol),
                "direction": .string(direction),
                "strength": .string(format(strength)),
                "actualBars": .number(Decimal(bars.count)),
                "movingAverages": .object([
                    "ma5": .string(format(shortAverage)),
                    "ma20": .string(format(mediumAverage)),
                    "ma60": .string(format(longAverage))
                ]),
                "support": .string(format(support)),
                "resistance": .string(format(resistance)),
                "sourceAt": .string(latest.time)
            ]),
            summary,
            latest.time
        )
    }

    private static func evidenceItem(
        id: String,
        kind: String,
        summary: String,
        sourceAt: String
    ) -> JSONValue {
        .object([
            "id": .string(id),
            "kind": .string(kind),
            "summary": .string(summary),
            "sourceAt": .string(sourceAt)
        ])
    }

    private static func gap(
        code: String,
        severity: String,
        summary: String,
        sourceSupport: String
    ) -> JSONValue {
        .object([
            "code": .string(code),
            "severity": .string(severity),
            "summary": .string(summary),
            "sourceSupport": .string(sourceSupport)
        ])
    }

    private static func providerGapSeverity(_ summary: String) -> String {
        if summary.contains("目标标的") && (
            summary.contains("报价") || summary.contains("账户") || summary.contains("持仓")
        ) {
            return "BLOCKING"
        }
        return "DEGRADING"
    }

    private static func countWindow(requested: Int, available: Int) -> JSONValue {
        .object([
            "requested": .number(Decimal(requested)),
            "available": .number(Decimal(available)),
            "included": .number(Decimal(min(requested, available)))
        ])
    }

    private static func quoteSummary(_ quote: QuoteSummary) -> String {
        "\(quote.symbol) 最新价 \(quote.lastPrice)，开 \(quote.openPrice?.description ?? "不可用")，高 \(quote.highPrice?.description ?? "不可用")，低 \(quote.lowPrice?.description ?? "不可用")，成交量 \(quote.volume?.description ?? "不可用")"
    }

    private static func evidenceId(_ prefix: String, _ symbol: String) -> String {
        let normalized = symbol.uppercased().map {
            $0.isLetter || $0.isNumber ? $0 : "_"
        }
        return "\(prefix)_\(String(normalized))"
    }

    private static func decimal(_ value: Decimal) -> JSONValue {
        .string(value.description)
    }

    private static func average(_ values: [Double]) -> Double {
        values.isEmpty ? 0 : values.reduce(0, +) / Double(values.count)
    }

    private static func format(_ value: Double) -> String {
        String(format: "%.4f", value)
    }

    private static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}
