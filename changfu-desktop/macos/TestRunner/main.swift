import ChangFuDomain
import ChangFuInfrastructure
import CryptoKit
import Foundation

@main
struct ChangFuDesktopTests {
    @MainActor
    static func main() async {
        var suite = TestSuite()
        if ProcessInfo.processInfo.environment["CHANGFU_TEST_SCOPE"] == "sell-put" {
            runResearchProductTests(&suite)
            suite.finish()
            return
        }
        runWorkspaceTests(&suite)
        runMarketIntelligenceTests(&suite)
        runResearchProductTests(&suite)
        runSubscriptionAndTradingModelTests(&suite)
        runContextEnvelopeTests(&suite)
        runOrderIntentTests(&suite)
        runAuthenticationTests(&suite)
        await runBackendClientTests(&suite)
        await runBrokerTests(&suite)
        await runLongbridgeBrokerTests(&suite)
        suite.finish()
    }

    private static func runMarketIntelligenceTests(_ suite: inout TestSuite) {
        suite.test("市场情报三组契约可编码并提供缺失组状态") {
            let event = MarketEvent(
                id: "event-1",
                group: .watchlist,
                category: "EARNINGS",
                title: "测试财报",
                source: "Futu 财报日历",
                publishedAt: "2026-09-20T12:00:00Z",
                fetchedAt: "2026-09-20T11:00:00Z",
                relatedSymbols: ["US.NVDA"],
                importance: .high,
                validUntil: "2026-09-23T12:00:00Z",
                previous: "1.0",
                consensus: "1.2",
                actual: "1.3"
            )
            let snapshot = MarketIntelligenceSnapshot(
                providerId: "FUTU",
                fetchedAt: event.fetchedAt,
                sections: [
                    MarketIntelligenceSection(
                        group: .watchlist,
                        availability: .available,
                        events: [event]
                    )
                ]
            )
            let request = MarketIntelligenceRequest(
                symbols: ["US.NVDA", "US.MU", "US.NVDA"]
            )
            guard let data = try? JSONEncoder().encode(snapshot),
                  let decoded = try? JSONDecoder().decode(
                      MarketIntelligenceSnapshot.self,
                      from: data
                  ) else {
                return false
            }
            return MarketEventGroup.allCases.count == 3
                && MarketEventImportance.allCases.count == 4
                && decoded.section(.watchlist).events.first == event
                && decoded.sections.first?.id == .watchlist
                && decoded.section(.usMacro).availability == .unavailable
                && request.symbols == ["US.MU", "US.NVDA"]
        }
    }

    private static func runResearchProductTests(_ suite: inout TestSuite) {
        suite.test("研究模型档位元数据完整") {
            ResearchModelProfile.allCases.map(\.id) == ["fast", "deep", "risk"]
                && ResearchModelProfile.allCases.map(\.title)
                    == ["快速研究", "深度研究", "风险复核"]
                && ResearchModelProfile.allCases.allSatisfy { !$0.detail.isEmpty }
        }
        suite.test("研究技能版本和内容完整") {
            ResearchSkill.allCases.map(\.id) == ["quantitative", "sellPut"]
                && ResearchSkill.allCases.map(\.title)
                    == ["量化研究", "SELL PUT 期权研究"]
                && ResearchSkill.allCases.map(\.promptVersion)
                    == ["research-quantitative-v1", "top30-mega-cap-csp-v3"]
                && ResearchSkill.allCases.map(\.systemImage)
                    == ["chart.xyaxis.line", "option"]
                && ResearchSkill.allCases.allSatisfy { !$0.detail.isEmpty }
                && ResearchSkill.allCases.allSatisfy { $0.sections.count == 4 }
        }
        suite.test("SELL PUT 报告保留独立请求与缺失数据门禁") {
            let data = Data("""
            {"runId":"00000000-0000-4000-8000-000000000601","providerId":"FUTU",
             "poolVersion":4,"reportWindowDays":30,"promptVersion":"top30-mega-cap-csp-v3",
             "status":"COMPLETED","symbolCount":1,"candidateCount":0,"dataGapCount":1,
             "dataQuality":{"isUsableForAnalysis":false,"issueCount":1},
             "summary":{"generatedAt":"2026-09-23T00:00:00Z",
             "isUsableForAnalysis":false,"candidateCount":0,"dataGapCount":1,
             "topOpportunities":[],"bottomRisks":[]},"markdown":"# 报告","errorCode":null,
             "startedAt":"2026-09-23T00:00:00Z","finishedAt":"2026-09-23T00:00:01Z",
             "items":[{"symbol":"US.NVDA","sourceSnapshot":{
             "requestId":"00000000-0000-4000-8000-000000000602","symbol":"US.NVDA",
             "displayName":"英伟达","capturedAt":"2026-09-23T00:00:00Z",
             "currentPrice":228.8,"change30dPercent":5.2,"option":null,
             "dataGaps":["Delta不可用"]},"analysis":{"symbol":"US.NVDA",
             "displayName":"英伟达","candidate":false,"score":null,"currentPrice":228.8,
             "change30dPercent":5.2,"optionCode":null,"expiryDate":null,
             "daysToExpiry":null,"strikePrice":null,"premium":null,
             "annualizedReturnPercent":null,"safetyMarginPercent":null,
             "cashRequired":null,"delta":null,"impliedVolatility":null,
             "bidAskSpreadPercent":null,"volume":null,"openInterest":null,
             "liquidity":"不可用","risks":[],"exitConditions":["复核"],
             "dataGaps":["Delta不可用"],"capturedAt":"2026-09-23T00:00:00Z"}}]}
            """.utf8)
            guard let report = try? JSONDecoder().decode(SellPutReport.self, from: data) else {
                return false
            }
            return report.reportWindowDays == 30
                && report.promptVersion == "top30-mega-cap-csp-v3"
                && report.items.first?.sourceSnapshot.requestId
                    == "00000000-0000-4000-8000-000000000602"
                && report.items.first?.analysis.candidate == false
        }
        suite.test("对话能力显式区分技能智能体和工具") {
            let capability = ConversationCapability(
                id: "quantitative",
                kind: .skill,
                title: "量化研究",
                detail: "测试",
                systemImage: "chart.xyaxis.line"
            )
            return ConversationCapabilityKind.skill.title == "技能"
                && ConversationCapabilityKind.agent.title == "智能体"
                && ConversationCapabilityKind.tool.title == "工具"
                && capability.mention == "@量化研究"
                && capability.isMentioned(in: "@量化研究 分析")
                && capability.isMentioned(in: "请用 @量化研究，分析")
                && !capability.isMentioned(in: "@量化研究报告")
        }
        suite.test("套餐和支付渠道目录完整") {
            SubscriptionTier.allCases.map(\.id) == ["light", "advanced", "flagship"]
                && SubscriptionTier.allCases.map(\.title) == ["轻量版", "高级版", "旗舰版"]
                && SubscriptionTier.allCases.allSatisfy { !$0.subtitle.isEmpty }
                && SubscriptionTier.allCases.allSatisfy { $0.features.count == 4 }
                && PaymentChannel.allCases.map(\.id) == ["wechat", "alipay", "douyin"]
                && PaymentChannel.allCases.map(\.title)
                    == ["微信支付", "支付宝支付", "抖音支付"]
                && PaymentChannel.allCases.map(\.systemImage)
                    == ["message.fill", "a.circle.fill", "music.note"]
        }
        suite.test("标的池权益和锁定模型完整") {
            let date = Date(timeIntervalSince1970: 1_800_000_000)
            let entitlement = ResearchPoolEntitlement(
                status: .active,
                planName: "专业版",
                poolLimit: 10,
                replacementIntervalDays: 30,
                nextReplacementAt: date
            )
            let clamped = ResearchPoolEntitlement(
                status: .expired,
                planName: nil,
                poolLimit: -1,
                replacementIntervalDays: nil,
                nextReplacementAt: nil
            )
            let item = ResearchPoolItem(
                symbol: "US.TEST",
                displayName: "测试标的",
                lockedUntil: date
            )
            return entitlement.poolLimit == 10
                && entitlement.status == .active
                && entitlement.nextReplacementAt == date
                && clamped.poolLimit == 0
                && clamped.status == .expired
                && ResearchPoolEntitlement.unavailable.status == .unavailable
                && item.id == "US.TEST"
                && item.lockedUntil == date
        }
        suite.test("Provider 分池分页模型可合并且保留期权字段") {
            let entitlement = ProviderPoolEntitlement(
                active: true,
                capacity: 15,
                used: 2,
                replacementLimit: 15,
                replacementUsed: 1,
                replacementWindowStart: "2026-09-19T00:00:00.000Z",
                replacementWindowEnd: "2026-10-19T00:00:00.000Z"
            )
            let first = ProviderPool(
                providerId: "FUTU",
                status: "ACTIVE",
                frozenReason: nil,
                version: 3,
                entitlement: entitlement,
                items: [],
                nextCursor: "next",
                updatedAt: "2026-09-19T00:00:00.000Z"
            )
            let itemJSON = Data("""
            {"providerId":"FUTU","status":"ACTIVE","frozenReason":null,"version":3,
             "entitlement":{"active":true,"capacity":15,"used":2,
             "replacementLimit":15,"replacementUsed":1,
             "replacementWindowStart":"2026-09-19T00:00:00.000Z",
             "replacementWindowEnd":"2026-10-19T00:00:00.000Z"},
             "items":[{"itemId":"item-1","providerId":"FUTU",
             "providerSymbol":"US.AAPL260918P00200000",
             "canonicalSymbol":"US.AAPL260918P00200000","displayName":"AAPL PUT",
             "market":"US","instrumentType":"OPTION","optionType":"PUT",
             "underlyingSymbol":"US.AAPL","expiryDate":"2026-09-18",
             "strikePrice":"200","currency":"USD","contractMultiplier":"100",
             "status":"ACTIVE","addedAt":"2026-09-19T00:00:00.000Z"}],
             "nextCursor":null,"updatedAt":"2026-09-19T00:00:00.000Z"}
            """.utf8)
            guard let second = try? JSONDecoder().decode(ProviderPool.self, from: itemJSON) else {
                return false
            }
            let merged = first.appending(second)
            return merged.items.count == 1
                && merged.items.first?.optionType == .put
                && merged.items.first?.contractMultiplier == "100"
                && merged.nextCursor == nil
        }
        suite.test("旗舰标的按每批一百个稳定拆分") {
            let symbols = (0..<205).map { "US.TEST\($0)" }
            let batches = ResearchBatching.conversationBatches(symbols)
            return batches.map(\.count) == [100, 100, 5]
                && batches.flatMap { $0 } == symbols
                && ResearchBatching.conversationBatches([]) == [[]]
        }
        suite.test("券商发现模型覆盖正股和期权完整字段") {
            let capability = BrokerCapability(
                providerId: "FUTU",
                searchMode: .fuzzy,
                supportedMarkets: BrokerMarket.allCases,
                supportedInstrumentTypes: BrokerInstrumentType.allCases,
                supportsOptionChain: true
            )
            let instrument = BrokerInstrument(
                providerId: "FUTU",
                providerSymbol: "US.AAPL",
                canonicalSymbol: "US.AAPL",
                displayName: "Apple",
                market: .us,
                instrumentType: .stock,
                currency: "USD",
                addable: true,
                unavailableReason: nil
            )
            let search = BrokerInstrumentSearchResponse(
                providerId: "FUTU",
                query: "AAPL",
                queryMode: .fuzzy,
                results: [instrument],
                fetchedAt: "2026-09-19T00:00:00.000Z"
            )
            let expiry = BrokerOptionExpiry(
                underlyingSymbol: "US.AAPL",
                expiryDate: "2026-09-25"
            )
            let expiries = BrokerOptionExpiryResponse(
                providerId: "FUTU",
                underlyingSymbol: "US.AAPL",
                expiries: [expiry],
                fetchedAt: "2026-09-19T00:00:00.000Z"
            )
            let contract = BrokerOptionContract(
                providerId: "FUTU",
                providerSymbol: "US.AAPL260925P00200000",
                canonicalSymbol: "US.AAPL260925P00200000",
                displayName: "AAPL PUT",
                market: .us,
                instrumentType: .option,
                optionType: .put,
                underlyingSymbol: "US.AAPL",
                expiryDate: "2026-09-25",
                strikePrice: "200",
                currency: "USD",
                contractMultiplier: "100",
                addable: true,
                unavailableReason: nil
            )
            let chain = BrokerOptionChainResponse(
                providerId: "FUTU",
                underlyingSymbol: "US.AAPL",
                expiryDate: "2026-09-25",
                contracts: [contract],
                fetchedAt: "2026-09-19T00:00:00.000Z"
            )
            let stockRequest = AddProviderPoolItemRequest(
                instrument: instrument,
                sourceVerifiedAt: search.fetchedAt
            )
            let optionRequest = AddProviderPoolItemRequest(
                contract: contract,
                sourceVerifiedAt: chain.fetchedAt
            )
            return capability.supportsOptionChain
                && search.results.first?.id == "FUTU:US.AAPL"
                && expiries.expiries.first?.id == "US.AAPL:2026-09-25"
                && chain.contracts.first?.id == "FUTU:US.AAPL260925P00200000"
                && stockRequest.optionType == nil
                && stockRequest.providerSymbol == "US.AAPL"
                && optionRequest.optionType == .put
                && optionRequest.contractMultiplier == "100"
        }
        suite.test("正股入池请求显式编码空期权字段") {
            let instrument = BrokerInstrument(
                providerId: "FUTU",
                providerSymbol: "US.MU",
                canonicalSymbol: "US.MU",
                displayName: "Micron Technology",
                market: .us,
                instrumentType: .stock,
                currency: "USD",
                addable: true,
                unavailableReason: nil
            )
            let request = AddProviderPoolItemRequest(
                instrument: instrument,
                sourceVerifiedAt: "2026-09-19T00:00:00Z"
            )
            guard let data = try? JSONEncoder().encode(request),
                  let object = try? JSONSerialization.jsonObject(with: data)
                    as? [String: Any] else {
                return false
            }
            return object["optionType"] is NSNull
                && object["underlyingSymbol"] is NSNull
                && object["expiryDate"] is NSNull
                && object["strikePrice"] is NSNull
                && object["contractMultiplier"] is NSNull
        }
        suite.test("Provider 池标识和空缓存模型完整") {
            let data = Data("""
            {"providerId":"FUTU","status":"ACTIVE","version":1,"used":1,
             "capacity":5,"updatedAt":"2026-09-19T00:00:00.000Z"}
            """.utf8)
            let itemData = Data("""
            {"itemId":"item-1","providerId":"FUTU","providerSymbol":"US.AAPL",
             "canonicalSymbol":"US.AAPL","displayName":"Apple","market":"US",
             "instrumentType":"STOCK","optionType":null,"underlyingSymbol":null,
             "expiryDate":null,"strikePrice":null,"currency":"USD",
             "contractMultiplier":null,"status":"ACTIVE",
             "addedAt":"2026-09-19T00:00:00.000Z"}
            """.utf8)
            guard let summary = try? JSONDecoder().decode(ProviderPoolSummary.self, from: data),
                  let item = try? JSONDecoder().decode(ProviderPoolItem.self, from: itemData) else {
                return false
            }
            let pool = ProviderPool(
                providerId: "FUTU",
                status: "ACTIVE",
                frozenReason: nil,
                version: 1,
                entitlement: ProviderPoolEntitlement(
                    active: true,
                    capacity: 5,
                    used: 1,
                    replacementLimit: 1,
                    replacementUsed: 0,
                    replacementWindowStart: nil,
                    replacementWindowEnd: nil
                ),
                items: [item],
                nextCursor: nil,
                updatedAt: summary.updatedAt
            )
            return summary.id == "FUTU"
                && item.id == "item-1"
                && pool.id == "FUTU"
                && ProviderPoolCacheSnapshot.empty.summaries.isEmpty
                && ProviderPoolCacheSnapshot.empty.pools.isEmpty
        }
    }

    private static func runSubscriptionAndTradingModelTests(_ suite: inout TestSuite) {
        suite.test("订阅领域模型标识、金额和请求编码完整") {
            let catalogData = Data("""
            {"catalogVersion":"2026.09.1","publishedAt":"2026-09-19T00:00:00.000Z",
             "currency":"CNY","providers":[{"providerId":"FUTU","displayName":"富途",
             "status":"ACTIVE","supportedMarkets":["US"],
             "supportedInstrumentTypes":["STOCK","ETF","OPTION"]}],
             "plans":[{"planVersionId":"plan-1","planCode":"LITE","version":1,
             "displayName":"轻量版","status":"ACTIVE",
             "effectiveFrom":"2026-09-19T00:00:00.000Z","brokerSlotLimit":1,
             "poolCapacityPerProvider":5,"monthlyReplacementLimit":1,
             "features":{"batchSize":100,"optionResearch":true,"optionTrading":false,
             "poolCapacityProtectionLimit":null},
             "prices":[{"priceId":"price-1","billingPeriod":"MONTHLY",
             "durationMonths":1,"currency":"CNY","amountMinor":2900}]}],
             "paymentChannels":[{"channel":"WECHAT","displayName":"微信支付",
             "available":true,"unavailableReason":null}]}
            """.utf8)
            let currentData = Data("""
            {"subscription":{"subscriptionId":"subscription-1","planVersionId":"plan-1",
             "planCode":"LITE","planName":"轻量版","billingPeriod":"MONTHLY",
             "status":"ACTIVE","version":2,"purchasedAt":"2026-09-19T00:00:00.000Z",
             "startsAt":"2026-09-19T00:00:00.000Z",
             "currentPeriodStart":"2026-09-19T00:00:00.000Z",
             "expiresAt":"2026-10-19T00:00:00.000Z","remainingDays":30,
             "pendingChange":{"planVersionId":"plan-1","planCode":"LITE",
             "billingPeriod":"YEARLY","effectiveAt":"2026-10-19T00:00:00.000Z",
             "retainedProviderIds":["FUTU"]},
             "slots":[{"slotId":"slot-1","slotOrdinal":1,"providerId":"FUTU",
             "status":"BOUND","boundAt":"2026-09-19T00:00:00.000Z",
             "nextRebindAt":null,"version":1}]}}
            """.utf8)
            let orderData = Data("""
            {"orderId":"order-1","businessOrderNo":"CF-1","orderType":"NEW",
             "planVersionId":"plan-1","planCode":"LITE","billingPeriod":"MONTHLY",
             "currency":"CNY","originalAmountMinor":2900,"creditAmountMinor":0,
             "payableAmountMinor":2900,"status":"PAYING",
             "providerSelections":[{"slotOrdinal":1,"providerId":"FUTU"}],
             "quoteExpiresAt":"2026-09-19T00:15:00.000Z",
             "createdAt":"2026-09-19T00:00:00.000Z","paidAt":null,
             "payment":{"channel":"WECHAT","paymentUrl":null,
             "qrCodePayload":"weixin://pay/test","expiresAt":"2026-09-19T00:15:00.000Z"}}
            """.utf8)
            guard let catalog = try? JSONDecoder().decode(
                      SubscriptionCatalog.self,
                      from: catalogData
                  ),
                  let current = try? JSONDecoder().decode(
                      SubscriptionCurrentEnvelope.self,
                      from: currentData
                  ),
                  let order = try? JSONDecoder().decode(
                      SubscriptionOrder.self,
                      from: orderData
                  ) else {
                return false
            }
            let schedule = ScheduleSubscriptionChangeRequest(
                planVersionId: "plan-1",
                billingPeriod: .yearly,
                retainedProviderIds: ["FUTU"],
                expectedVersion: 2
            )
            let bind = BindSubscriptionBrokerSlotRequest(providerId: "FUTU", expectedVersion: 2)
            let payment = StartSubscriptionPaymentRequest(channel: .wechat)
            guard (try? JSONEncoder().encode(schedule)) != nil,
                  (try? JSONEncoder().encode(bind)) != nil,
                  (try? JSONEncoder().encode(payment)) != nil else {
                return false
            }
            return SubscriptionBillingPeriod.allCases.map(\.id)
                == ["MONTHLY", "QUARTERLY", "YEARLY"]
                && SubscriptionBillingPeriod.allCases.map(\.title) == ["月付", "季付", "年付"]
                && SubscriptionPaymentChannel.allCases.map(\.id)
                    == ["WECHAT", "ALIPAY", "DOUYIN"]
                && catalog.providers.first?.id == "FUTU"
                && catalog.plans.first?.id == "plan-1"
                && catalog.plans.first?.prices.first?.id == "price-1"
                && catalog.plans.first?.prices.first?.displayPrice == "¥29.00"
                && catalog.paymentChannels.first?.id == "WECHAT"
                && current.subscription?.id == "subscription-1"
                && current.subscription?.slots.first?.id == "slot-1"
                && order.id == "order-1"
                && order.displayPayableAmount == "¥29.00"
        }

        suite.test("第三方模型配置只解码脱敏密钥元数据") {
            let data = Data("""
            {"eligible":true,"planCode":"FLAGSHIP",
             "config":{"configId":"00000000-0000-4000-8000-000000000501",
             "displayName":"自有模型","protocol":"OPENAI_RESPONSES",
             "endpoint":"https://api.example.com/v1/responses","model":"model-1",
             "enabled":true,"keyConfigured":true,"keyLastFour":"1234",
             "updatedAt":"2026-09-19T00:00:00.000Z"}}
            """.utf8)
            guard let envelope = try? JSONDecoder().decode(
                ThirdPartyModelConfigurationEnvelope.self,
                from: data
            ) else {
                return false
            }
            let input = SaveThirdPartyModelConfigurationRequest(
                displayName: "自有模型",
                protocol: .chatCompletions,
                endpoint: "https://api.example.com/v1/chat/completions",
                model: "model-2",
                apiKey: nil,
                enabled: false
            )
            guard let encoded = try? JSONEncoder().encode(input),
                  let object = try? JSONSerialization.jsonObject(with: encoded) as? [String: Any]
            else {
                return false
            }
            return envelope.eligible
                && envelope.planCode == .flagship
                && envelope.config?.keyLastFour == "1234"
                && envelope.config?.protocol == .responses
                && ModelProviderProtocol.allCases.map(\.id)
                    == ["OPENAI_RESPONSES", "OPENAI_CHAT_COMPLETIONS"]
                && ModelProviderProtocol.allCases.map(\.title)
                    == ["Responses API", "Chat Completions"]
                && object["apiKey"] == nil
                && object["protocol"] as? String == "OPENAI_CHAT_COMPLETIONS"
                && ModelRoute.official == "OFFICIAL"
                && ConversationModelOption(
                    id: ModelRoute.official,
                    displayName: "长富Pro",
                    detail: "官方路由"
                ).id == "OFFICIAL"
        }

        suite.test("交易控制面所有可识别实体提供稳定标识") {
            let catalogData = Data("""
            {"catalogVersion":"v1","publishedAt":"2026-09-19T00:00:00Z",
             "models":[{"id":"model-1","name":"模型","roles":[],"capabilities":[],
             "latencyTier":"FAST","plans":["LITE"]}],
             "strategies":[{"id":"strategy-1","name":"策略","version":"1",
             "providers":["FUTU"],"markets":["US"],"instrumentTypes":["STOCK"]}],
             "prompts":[{"id":"prompt-1","name":"提示词","version":"1",
             "role":"SINGLE_DECISION","summary":"摘要","constraints":[],
             "outputFields":[],"publishedAt":"2026-09-19T00:00:00Z",
             "contentHash":"hash"}],
             "riskPolicies":[{"id":"risk-1","name":"风控","version":"1"}]}
            """.utf8)
            let poolData = Data("""
            {"entitlement":{"status":"ACTIVE","planName":"轻量版","capacity":5,
             "replacementLimit":1,"replacementUsed":0,"renewsAt":null},
             "version":1,"items":[{"symbol":"US.AAPL","market":"US",
             "instrumentType":"STOCK","addedAt":"2026-09-19T00:00:00Z"}],
             "updatedAt":"2026-09-19T00:00:00Z"}
            """.utf8)
            let signalData = Data("""
            {"signalId":"signal-1","requestId":"request-1",
             "brokerConnectionId":"broker-1","symbol":"US.AAPL","action":"BUY",
             "evidenceSummary":{"confidence":0.8,"evidence":null,
             "counterEvidence":null,"sourceValidUntil":null},
             "riskSummary":{"risks":[],"dataGaps":[],"strategyId":"strategy-1",
             "riskPolicyId":"risk-1"},"exitCondition":null,
             "createdAt":"2026-09-19T00:00:00Z"}
            """.utf8)
            let candidateData = Data("""
            {"candidateId":"candidate-1","brokerConnectionId":"broker-1",
             "signalId":"signal-1","symbol":"US.AAPL","side":"BUY","status":"PENDING",
             "rank":1,"poolVersion":1,"configVersion":1,
             "createdAt":"2026-09-19T00:00:00Z","expiresAt":"2026-09-19T00:10:00Z",
             "updatedAt":null}
            """.utf8)
            let runData = Data("""
            {"requestId":"request-1","brokerConnectionId":"broker-1",
             "purpose":"SINGLE_DECISION","model":"model-1",
             "promptVersion":"1","status":"COMPLETED","result":null,"errorCode":null,
             "requestedSymbols":["US.AAPL"],
             "capturedAt":"2026-09-19T00:00:00Z",
             "sourceExpiresAt":"2026-09-19T00:01:00Z",
             "startedAt":"2026-09-19T00:00:00Z","finishedAt":null}
            """.utf8)
            guard let catalog = try? JSONDecoder().decode(TradingCatalog.self, from: catalogData),
                  let pool = try? JSONDecoder().decode(ServerResearchPool.self, from: poolData),
                  let signal = try? JSONDecoder().decode(TradingSignal.self, from: signalData),
                  let candidate = try? JSONDecoder().decode(
                      TradingCandidate.self,
                      from: candidateData
                  ),
                  let run = try? JSONDecoder().decode(ModelRunSummary.self, from: runData) else {
                return false
            }
            return catalog.models.first?.id == "model-1"
                && catalog.strategies.first?.id == "strategy-1"
                && catalog.prompts.first?.id == "prompt-1"
                && catalog.riskPolicies.first?.id == "risk-1"
                && pool.items.first?.id == "US.AAPL"
                && signal.id == "signal-1"
                && candidate.id == "candidate-1"
                && run.id == "request-1"
                && run.requestedSymbols == ["US.AAPL"]
        }

        suite.test("Futu 首次接入生成保守影子评估配置") {
            let data = Data("""
            {"catalogVersion":"v1","publishedAt":"2026-09-19T00:00:00Z",
             "models":[{"id":"model-1","name":"模型",
             "roles":["SINGLE_DECISION","PORTFOLIO_REVIEW","MANAGED_ORDER_REVIEW"],
             "capabilities":[],"latencyTier":"FAST","plans":["FLAGSHIP"]}],
             "strategies":[{"id":"strategy-1","name":"策略","version":"1",
             "providers":["FUTU"],"markets":["US"],"instrumentTypes":["STOCK"]}],
             "prompts":[
             {"id":"single-1","name":"单票","version":"1","role":"SINGLE_DECISION",
             "summary":"摘要","constraints":[],"outputFields":[],
             "publishedAt":"2026-09-19T00:00:00Z","contentHash":"a"},
             {"id":"portfolio-1","name":"组合","version":"1","role":"PORTFOLIO_REVIEW",
             "summary":"摘要","constraints":[],"outputFields":[],
             "publishedAt":"2026-09-19T00:00:00Z","contentHash":"b"},
             {"id":"managed-1","name":"挂单","version":"1","role":"MANAGED_ORDER_REVIEW",
             "summary":"摘要","constraints":[],"outputFields":[],
             "publishedAt":"2026-09-19T00:00:00Z","contentHash":"c"}],
             "riskPolicies":[{"id":"risk-1","name":"风控","version":"1"}]}
            """.utf8)
            guard let catalog = try? JSONDecoder().decode(TradingCatalog.self, from: data),
                  let input = try? SaveTradingConfigurationRequest.shadowDefault(
                      catalog: catalog,
                      provider: "FUTU"
                  ) else {
                return false
            }
            return input.expectedVersion == 0
                && input.executionMode == "DIRECT"
                && input.confirmationMode == "MANUAL_CONFIRM"
                && input.models.singleDecision == "model-1"
                && input.strategyId == "strategy-1"
                && input.singlePromptId == "single-1"
                && input.portfolioPromptId == "portfolio-1"
                && input.managedOrderPromptId == "managed-1"
                && input.scanIntervalSeconds == 60
                && input.disableUsOvernightEvaluation
        }
        suite.test("量化评估仅在港股盘中及美股非夜盘交易时段运行") {
            let allowed: [(BrokerMarket, String)] = [
                (.hk, "盘中"),
                (.hk, "交易中"),
                (.us, "盘前"),
                (.us, "盘中"),
                (.us, "盘后"),
                (.us, "PreMarket"),
                (.us, "RTH"),
                (.us, "AfterHours")
            ]
            let blocked: [(BrokerMarket, String?)] = [
                (.hk, "休市"),
                (.hk, "等待开盘"),
                (.hk, "午间休市"),
                (.us, "已收盘"),
                (.us, "等待开盘"),
                (.us, "夜盘"),
                (.us, "Overnight"),
                (.us, nil),
                (.cn, "盘中"),
                (.sg, "盘中")
            ]
            return allowed.allSatisfy {
                QuantEvaluationMarketGate.decide(
                    market: $0.0,
                    marketState: $0.1
                ).shouldEvaluate
            } && blocked.allSatisfy {
                !QuantEvaluationMarketGate.decide(
                    market: $0.0,
                    marketState: $0.1
                ).shouldEvaluate
            }
        }
        suite.test("量化评估在报价或趋势不足时不发送模型请求") {
            let noQuote = QuantEvaluationReadiness.decide(
                market: .us,
                marketState: "盘前",
                hasQuote: false,
                minuteBarCount: 60
            )
            let insufficientTrend = QuantEvaluationReadiness.decide(
                market: .us,
                marketState: "盘前",
                hasQuote: true,
                minuteBarCount: 4
            )
            let ready = QuantEvaluationReadiness.decide(
                market: .us,
                marketState: "盘前",
                hasQuote: true,
                minuteBarCount: 5
            )
            return !noQuote.shouldEvaluate
                && noQuote.reason.contains("不发送模型请求")
                && !insufficientTrend.shouldEvaluate
                && insufficientTrend.reason.contains("当前 4 根")
                && ready.shouldEvaluate
        }
        suite.test("交易目录不完整时拒绝生成影子配置") {
            let data = Data("""
            {"catalogVersion":"v1","publishedAt":"2026-09-19T00:00:00Z",
             "models":[],"strategies":[],"prompts":[],"riskPolicies":[]}
            """.utf8)
            guard let catalog = try? JSONDecoder().decode(TradingCatalog.self, from: data) else {
                return false
            }
            return catches({
                _ = try SaveTradingConfigurationRequest.shadowDefault(
                    catalog: catalog,
                    provider: "FUTU"
                )
            }) {
                guard case TradingConfigurationError.incompleteCatalog = $0 else {
                    return false
                }
                return $0.localizedDescription.contains("交易目录")
            }
        }
    }

    private static func runWorkspaceTests(_ suite: inout TestSuite) {
        suite.test("Futu 与 Longbridge 工作台可用") {
            !TradingPlatform.aShare.isAvailable
                && TradingPlatform.futu.isAvailable
                && TradingPlatform.longbridge.isAvailable
        }
        suite.test("平台标题和标识完整") {
            TradingPlatform.allCases.map(\.title) == ["A 股", "Futu", "Longbridge"]
                && TradingPlatform.allCases.map(\.id) == ["aShare", "futu", "longbridge"]
        }
        suite.test("导航元数据完整") {
            FutuWorkspace.allCases.map(\.title)
                == ["今日总览", "市场", "研究", "交易", "资产", "策略中心"]
                && Set(FutuWorkspace.allCases.map(\.systemImage)).count == 6
                && FutuWorkspace.assets.systemImage == "briefcase"
                && FutuWorkspace.overview.id == "overview"
                && FutuWorkspace.strategyCenter.id == "strategyCenter"
        }
        suite.test("连接状态文案完整") {
            OpenDConnectionState.disconnected.label == "OpenD 未连接"
                && OpenDConnectionState.connecting.label == "OpenD 连接中"
                && OpenDConnectionState.connected.label == "OpenD 已连接"
                && OpenDConnectionState.sdkUnavailable.label == "Futu SDK 未配置"
                && OpenDConnectionState.failed("测试").label.contains("测试")
                && LongbridgeConnectionState.disconnected.label == "Longbridge 未连接"
                && LongbridgeConnectionState.connecting.label == "Longbridge 连接中"
                && LongbridgeConnectionState.connected.label == "Longbridge 已连接"
                && LongbridgeConnectionState.unauthorized.label == "Longbridge 未授权"
                && LongbridgeConnectionState.cliUnavailable.label.contains("CLI")
                && LongbridgeConnectionState.failed("测试").label.contains("测试")
        }
        suite.test("Longbridge API 凭据必须三项完整") {
            LongbridgeCredentials(
                appKey: " app-key ",
                appSecret: " app-secret ",
                accessToken: " access-token "
            ).isComplete
                && !LongbridgeCredentials(
                    appKey: "app-key",
                    appSecret: "",
                    accessToken: "access-token"
                ).isComplete
        }
        suite.test("快照支持负持仓和市场状态") {
            guard let snapshot = try? JSONDecoder().decode(
                BrokerSnapshot.self,
                from: fixtureData
            ) else {
                return false
            }
            let rebuilt = BrokerSnapshot(
                account: AccountSummary(
                    accountId: snapshot.account.accountId,
                    environment: snapshot.account.environment,
                    totalAssets: snapshot.account.totalAssets,
                    cash: snapshot.account.cash,
                    buyingPower: snapshot.account.buyingPower,
                    currency: snapshot.account.currency
                ),
                positions: snapshot.positions.map {
                    PositionSummary(
                        id: $0.id,
                        symbol: $0.symbol,
                        name: $0.name,
                        quantity: $0.quantity,
                        costPrice: $0.costPrice,
                        lastPrice: $0.lastPrice,
                        todayProfit: $0.todayProfit,
                        currency: $0.currency
                    )
                },
                market: MarketSummary(
                    name: snapshot.market.name,
                    state: snapshot.market.state,
                    stateValue: snapshot.market.stateValue
                )
            )
            return rebuilt == snapshot
                && snapshot.account.currency == "USD"
                && snapshot.positions.first?.quantity == Decimal(-2)
                && snapshot.market.state == "交易中"
        }
        suite.test("旧版快照缺失扩展字段时安全降级") {
            guard let snapshot = try? JSONDecoder().decode(
                BrokerSnapshot.self,
                from: fixtureData
            ) else {
                return false
            }
            return snapshot.quotes.isEmpty
                && snapshot.minuteBars.isEmpty
                && snapshot.tickerPoints.isEmpty
                && snapshot.orderBooks.isEmpty
                && snapshot.openOrders.isEmpty
                && snapshot.recentDeals.isEmpty
                && snapshot.historicalOrders.isEmpty
                && snapshot.historicalDeals.isEmpty
                && snapshot.dataGaps.isEmpty
                && snapshot.account.unrealizedProfit == nil
                && snapshot.account.realizedProfit == nil
                && snapshot.account.totalProfit == nil
        }
        suite.test("旧版报价缺失扩展时段价格时安全降级") {
            let data = Data(
                """
                {"symbol":"US.TEST","name":"测试证券","lastPrice":10,
                 "openPrice":9,"highPrice":11,"lowPrice":8,
                 "previousClose":9.5,"volume":100,"turnover":1000,
                 "updateTime":"2026-09-17 18:00:00"}
                """.utf8
            )
            guard let quote = try? JSONDecoder().decode(QuoteSummary.self, from: data) else {
                return false
            }
            return quote.preMarketPrice == nil
                && quote.afterHoursPrice == nil
                && quote.overnightPrice == nil
                && quote.marketState == nil
                && quote.marketStateValue == nil
        }
        suite.test("账户累计收益字段可编码往返") {
            let account = AccountSummary(
                accountId: "test-account",
                environment: "REAL",
                totalAssets: 1_000,
                cash: 200,
                buyingPower: 300,
                unrealizedProfit: 12.5,
                realizedProfit: -2.5,
                currency: "USD"
            )
            guard let data = try? JSONEncoder().encode(account),
                  let decoded = try? JSONDecoder().decode(
                    AccountSummary.self,
                    from: data
                  ) else {
                return false
            }
            let unrealizedOnly = AccountSummary(
                accountId: "test-account",
                environment: "REAL",
                totalAssets: 1_000,
                cash: 200,
                buyingPower: 300,
                unrealizedProfit: 4,
                currency: "USD"
            )
            let realizedOnly = AccountSummary(
                accountId: "test-account",
                environment: "REAL",
                totalAssets: 1_000,
                cash: 200,
                buyingPower: 300,
                realizedProfit: -2,
                currency: "USD"
            )
            return decoded == account
                && decoded.totalProfit == 10
                && unrealizedOnly.totalProfit == 4
                && realizedOnly.totalProfit == -2
        }
        suite.test("全量 OpenD 快照可编码往返") {
            guard let base = try? JSONDecoder().decode(
                BrokerSnapshot.self,
                from: fixtureData
            ) else {
                return false
            }
            let snapshot = BrokerSnapshot(
                account: base.account,
                positions: base.positions,
                market: base.market,
                quotes: [QuoteSummary(
                    symbol: "US.TEST",
                    name: "测试证券",
                    lastPrice: 10,
                    openPrice: 9,
                    highPrice: 11,
                    lowPrice: 8,
                    previousClose: 9.5,
                    volume: 100,
                    turnover: 1000,
                    updateTime: "2026-09-17 18:00:00",
                    preMarketPrice: 9.8,
                    afterHoursPrice: 10.2,
                    overnightPrice: 10.3,
                    marketState: "夜盘",
                    marketStateValue: 16
                )],
                minuteBars: [CandlestickSummary(
                    symbol: "US.TEST",
                    time: "2026-09-17 18:00:00",
                    open: 9,
                    high: 11,
                    low: 8,
                    close: 10,
                    volume: 100,
                    turnover: 1000
                )],
                tickerPoints: [TickerSummary(
                    symbol: "US.TEST",
                    time: "18:00:00",
                    sequence: 1,
                    price: 10,
                    volume: 2,
                    direction: 1
                )],
                orderBooks: [OrderBookSummary(
                    symbol: "US.TEST",
                    asks: [OrderBookLevel(
                        side: "ASK",
                        level: 1,
                        price: 10.1,
                        volume: 20,
                        orderCount: 2
                    )],
                    bids: []
                )],
                openOrders: [BrokerOrderSummary(
                    orderId: "order-1",
                    symbol: "US.TEST",
                    name: "测试证券",
                    side: 1,
                    status: 5,
                    quantity: 2,
                    price: 10,
                    filledQuantity: 1,
                    filledAveragePrice: 9.9,
                    createdAt: "2026-09-17 18:00:00",
                    updatedAt: "2026-09-17 18:01:00"
                )],
                recentDeals: [BrokerFillSummary(
                    fillId: "fill-1",
                    orderId: "order-1",
                    symbol: "US.TEST",
                    name: "测试证券",
                    side: 1,
                    quantity: 1,
                    price: 9.9,
                    createdAt: "2026-09-17 18:01:00"
                )],
                dataGaps: ["二级行情权限不足"]
            )
            guard let data = try? JSONEncoder().encode(snapshot),
                  let decoded = try? JSONDecoder().decode(
                    BrokerSnapshot.self,
                    from: data
                  ) else {
                return false
            }
            return decoded == snapshot
                && decoded.quotes.first?.lastPrice == 10
                && decoded.quotes.first?.previousClose == 9.5
                && decoded.quotes.first?.preMarketPrice == 9.8
                && decoded.quotes.first?.afterHoursPrice == 10.2
                && decoded.quotes.first?.overnightPrice == 10.3
                && decoded.quotes.first?.marketState == "夜盘"
                && decoded.quotes.first?.marketStateValue == 16
                && decoded.orderBooks.first?.asks.first?.orderCount == 2
                && decoded.dataGaps == ["二级行情权限不足"]
                && decoded.quotes.first?.id == "US.TEST"
                && decoded.minuteBars.first?.id.contains("US.TEST") == true
                && decoded.tickerPoints.first?.id.contains(":1:") == true
                && decoded.orderBooks.first?.id == "US.TEST"
                && decoded.orderBooks.first?.asks.first?.id == "ASK:1"
                && decoded.openOrders.first?.id == "order-1"
                && decoded.recentDeals.first?.id == "fill-1"
        }
    }

    private static func runContextEnvelopeTests(_ suite: inout TestSuite) {
        let key = Curve25519.Signing.PrivateKey()
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let snapshot = ContextSnapshot(
            account: [
                "accountIdHash": .string("hash"),
                "enabled": .bool(true),
                "balance": .number(Decimal(string: "12.34")!),
                "nullable": .null,
                "nested": .object(["items": .array([.string("A"), .number(2)])])
            ],
            positions: [.object(["symbol": .string("US.TEST")])],
            marketSessions: [.string("OPEN")],
            quotes: [.number(10)],
            minuteBars: [.array([.number(1), .number(2)])],
            tickerPoints: [.bool(false)],
            orderBooks: [.object([:])],
            openOrders: [.null],
            recentDeals: [.string("deal")],
            research: [
                "entitlementStatus": .string("active"),
                "planName": .string("专业版"),
                "poolLimit": .number(10),
                "poolSymbols": .array([.string("US.TEST")]),
                "conversationSymbols": .array([.string("US.TEST")])
            ],
            decisionContext: [
                "trendContext": .array([
                    .object([
                        "symbol": .string("US.TEST"),
                        "strength": .string("0.0046")
                    ])
                ])
            ],
            capabilities: [
                .object([
                    "id": .string("quantitative"),
                    "kind": .string("skill"),
                    "title": .string("量化研究"),
                    "promptVersion": .string("research-quantitative-v1"),
                    "modelProfile": .string("deep"),
                    "toolPolicyVersion": .string("research-readonly-v1")
                ]),
                .object([
                    "id": .string("sellPut"),
                    "kind": .string("skill"),
                    "title": .string("SELL PUT 期权研究"),
                    "promptVersion": .string("top30-mega-cap-csp-v3"),
                    "modelProfile": .string("risk"),
                    "toolPolicyVersion": .string("research-readonly-v1")
                ])
            ],
            dataGaps: ["逐笔成交缺失"]
        )

        do {
            let envelope = try ContextEnvelopeFactory.makeTrading(
                requestId: UUID(uuidString: "11111111-2222-3333-4444-555555555555")!,
                deviceId: "device-1",
                brokerConnectionId: "broker-1",
                provider: "FUTU",
                purpose: "SINGLE_DECISION",
                sequence: 1,
                snapshot: snapshot,
                researchPoolVersion: 1,
                tradingConfigVersion: 2,
                catalogVersion: "2026.09.1",
                requestedSymbols: ["US.TEST"],
                clientPolicyVersion: "policy-1",
                devicePrivateKey: key,
                now: now
            )
            let signature = Data(base64URL: envelope.deviceSignature)
            let digest = Data(hex: envelope.contentHash)
            let roundTrip = try JSONDecoder().decode(
                ContextEnvelope.self,
                from: JSONEncoder().encode(envelope)
            )
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let lifetime = formatter.date(from: envelope.expiresAt)?
                .timeIntervalSince(formatter.date(from: envelope.capturedAt) ?? .distantPast)
            suite.test("上下文元数据和有效期正确") {
                envelope.schemaVersion == "2.0"
                    && envelope.provider == "FUTU"
                    && envelope.researchPoolVersion == 1
                    && envelope.tradingConfigVersion == 2
                    && envelope.requestId == "11111111-2222-3333-4444-555555555555"
                    && lifetime.map { abs($0 - 60) < 0.001 } == true
            }
            suite.test("上下文设备签名有效") {
                signature.map { key.publicKey.isValidSignature($0, for: digest) } == true
            }
            suite.test("上下文序列化往返一致") {
                roundTrip == envelope
                    && roundTrip.capabilities.count == 2
                    && roundTrip.decisionContext != nil
            }
        } catch {
            suite.fail("上下文构建", detail: String(reflecting: error))
        }

        suite.test("JSONValue 全类型往返") {
            let values: [JSONValue] = [
                .string("文本"), .number(Decimal(string: "-1.25")!), .bool(true),
                .object(["a": .array([.null])]), .array([.number(3)]), .null
            ]
            guard let data = try? JSONEncoder().encode(values),
                  let decoded = try? JSONDecoder().decode([JSONValue].self, from: data) else {
                return false
            }
            return decoded == values
        }
        suite.test("拒绝非法上下文用途") {
            catches({
                _ = try ContextEnvelopeFactory.make(
                    deviceId: "device", brokerConnectionId: "broker",
                    purpose: "EXECUTE_NOW", sequence: 1, snapshot: snapshot,
                    strategyConfigVersion: "s", clientPolicyVersion: "p",
                    devicePrivateKey: key, now: now
                )
            }) {
                if case ContextEnvelopeError.invalidPurpose = $0 { return true }
                return false
            }
        }
        suite.test("拒绝非法上下文序列") {
            catches({
                _ = try ContextEnvelopeFactory.make(
                    deviceId: "device", brokerConnectionId: "broker",
                    purpose: "CHAT", sequence: 0, snapshot: snapshot,
                    strategyConfigVersion: "s", clientPolicyVersion: "p",
                    devicePrivateKey: key, now: now
                )
            }) {
                if case ContextEnvelopeError.invalidLifetime = $0 { return true }
                return false
            }
        }
        suite.test("拒绝超过 2 MiB 的上下文") {
            let oversized = ContextSnapshot(
                account: ["payload": .string(String(repeating: "x", count: 2_100_000))]
            )
            return catches({
                _ = try ContextEnvelopeFactory.make(
                    deviceId: "device", brokerConnectionId: "broker",
                    purpose: "REPORT", sequence: 1, snapshot: oversized,
                    strategyConfigVersion: "s", clientPolicyVersion: "p",
                    devicePrivateKey: key, now: now
                )
            }) {
                if case ContextEnvelopeError.tooLarge = $0 { return true }
                return false
            }
        }
        suite.test("交易上下文拒绝非法元数据和超大快照") {
            let invalid = catches({
                _ = try ContextEnvelopeFactory.makeTrading(
                    deviceId: "device",
                    brokerConnectionId: "broker",
                    provider: "UNKNOWN",
                    purpose: "SINGLE_DECISION",
                    sequence: 1,
                    snapshot: snapshot,
                    researchPoolVersion: 1,
                    tradingConfigVersion: 1,
                    catalogVersion: "v1",
                    requestedSymbols: ["US.TEST"],
                    clientPolicyVersion: "policy",
                    devicePrivateKey: key,
                    now: now
                )
            }) {
                if case ContextEnvelopeError.invalidPurpose = $0 { return true }
                return false
            }
            let oversized = ContextSnapshot(
                account: ["payload": .string(String(repeating: "x", count: 2_100_000))]
            )
            let tooLarge = catches({
                _ = try ContextEnvelopeFactory.makeTrading(
                    deviceId: "device",
                    brokerConnectionId: "broker",
                    provider: "FUTU",
                    purpose: "SINGLE_DECISION",
                    sequence: 1,
                    snapshot: oversized,
                    researchPoolVersion: 1,
                    tradingConfigVersion: 1,
                    catalogVersion: "v1",
                    requestedSymbols: ["US.TEST"],
                    clientPolicyVersion: "policy",
                    devicePrivateKey: key,
                    now: now
                )
            }) {
                if case ContextEnvelopeError.tooLarge = $0 { return true }
                return false
            }
            return invalid && tooLarge
        }
        suite.test("上下文错误文案完整") {
            ContextEnvelopeError.invalidPurpose.localizedDescription.contains("用途")
                && ContextEnvelopeError.invalidLifetime.localizedDescription.contains("有效期")
                && ContextEnvelopeError.tooLarge.localizedDescription.contains("2 MiB")
        }
    }

    private static func runOrderIntentTests(_ suite: inout TestSuite) {
        let key = Curve25519.Signing.PrivateKey()
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let binding = OrderIntentBinding(
            userId: "user-1",
            deviceId: "device-1",
            brokerConnectionId: "broker-1",
            provider: "FUTU",
            accountIdHash: "account-hash",
            poolVersion: 1,
            configVersion: 1,
            riskPolicyVersion: "risk-v1",
            sessionId: nil
        )

        do {
            let valid = try makeSignedIntent(key: key, now: now)
            try OrderIntentVerifier.verify(
                valid,
                binding: binding,
                publicKey: key.publicKey,
                now: now
            )
            let automatic = try makeSignedIntent(
                key: key,
                now: now,
                sessionId: "session-1",
                executionMode: "AUTO_EXECUTE"
            )
            try OrderIntentVerifier.verify(
                automatic,
                binding: OrderIntentBinding(
                    userId: "user-1",
                    deviceId: "device-1",
                    brokerConnectionId: "broker-1",
                    provider: "FUTU",
                    accountIdHash: "account-hash",
                    poolVersion: 1,
                    configVersion: 1,
                    riskPolicyVersion: "risk-v1",
                    sessionId: "session-1"
                ),
                publicKey: key.publicKey,
                now: now
            )
            suite.test("订单意图签名校验通过") { true }
        } catch {
            suite.fail("订单意图签名校验通过", detail: error.localizedDescription)
        }

        let cases: [(String, OrderIntentVerificationError, () throws -> SignedOrderIntent)] = [
            ("拒绝未知订单版本", .unsupportedVersion, {
                try makeSignedIntent(key: key, now: now, schemaVersion: "1.0")
            }),
            ("拒绝过期订单", .expired, {
                try makeSignedIntent(key: key, now: now, expiresAt: now.addingTimeInterval(-1))
            }),
            ("拒绝未来签发订单", .invalidIssueTime, {
                try makeSignedIntent(key: key, now: now, issuedAt: now.addingTimeInterval(6))
            }),
            ("拒绝超限滑点", .invalidSlippage, {
                try makeSignedIntent(key: key, now: now, maxSlippageBps: 16)
            }),
            ("拒绝关闭客户端订单复核", .bindingMismatch, {
                try makeSignedIntent(key: key, now: now, mustCheckOpenOrders: false)
            }),
            ("拒绝未知执行模式", .bindingMismatch, {
                try makeSignedIntent(key: key, now: now, executionMode: "UNKNOWN")
            })
        ]
        for (name, expected, builder) in cases {
            suite.test(name) {
                catches({
                    try OrderIntentVerifier.verify(
                        builder(),
                        binding: binding,
                        publicKey: key.publicKey,
                        now: now
                    )
                }) { sameOrderError($0, expected) }
            }
        }

        suite.test("拒绝订单绑定不一致") {
            catches({
                try OrderIntentVerifier.verify(
                    makeSignedIntent(key: key, now: now),
                    binding: OrderIntentBinding(
                        userId: "other", deviceId: "device-1",
                        brokerConnectionId: "broker-1", provider: "FUTU",
                        accountIdHash: "account-hash", poolVersion: 1,
                        configVersion: 1, riskPolicyVersion: "risk-v1", sessionId: nil
                    ),
                    publicKey: key.publicKey,
                    now: now
                )
            }) { sameOrderError($0, .bindingMismatch) }
        }
        suite.test("拒绝非法签名编码") {
            catches({
                let intent = try makeSignedIntent(key: key, now: now, signatureOverride: "%")
                try OrderIntentVerifier.verify(
                    intent, binding: binding, publicKey: key.publicKey, now: now
                )
            }) { sameOrderError($0, .invalidSignatureEncoding) }
        }
        suite.test("拒绝不匹配签名") {
            catches({
                let intent = try makeSignedIntent(key: key, now: now, signatureOverride: "AA")
                try OrderIntentVerifier.verify(
                    intent, binding: binding, publicKey: key.publicKey, now: now
                )
            }) { sameOrderError($0, .invalidSignature) }
        }
        suite.test("订单校验错误文案完整") {
            [
                OrderIntentVerificationError.unsupportedVersion,
                .bindingMismatch, .expired, .invalidIssueTime, .invalidSlippage,
                .invalidSignatureEncoding, .invalidSignature
            ].allSatisfy { !$0.localizedDescription.isEmpty }
        }
    }

    private static func runAuthenticationTests(_ suite: inout TestSuite) {
        let accessExpiry = Date(timeIntervalSince1970: 1_800_000_000)
        let refreshExpiry = accessExpiry.addingTimeInterval(3600)
        let pair = TokenPair(
            accessToken: "access",
            accessExpiresAt: accessExpiry,
            refreshToken: "refresh",
            refreshExpiresAt: refreshExpiry
        )
        suite.test("令牌对只向会话暴露访问令牌") {
            pair.session == AuthenticationSession(
                accessToken: "access",
                accessExpiresAt: accessExpiry,
                refreshExpiresAt: refreshExpiry
            )
        }
        suite.test("登录请求字段编码完整") {
            let request = DesktopLoginRequest(
                username: "user",
                password: "password",
                deviceId: "device",
                deviceFingerprint: "fingerprint",
                displayName: "长富测试设备",
                platform: "macOS",
                appVersion: "1.0",
                publicKey: "public-key"
            )
            guard let data = try? JSONEncoder().encode(request),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: String] else {
                return false
            }
            return object.count == 8
                && object["deviceFingerprint"] == "fingerprint"
                && object["publicKey"] == "public-key"
        }
        let cloud = BackendEnvironment.cloud(
            baseURL: URL(string: "https://api.changfu.example")!
        )
        suite.test("后台环境固定使用云端 HTTPS 与本机 Debug Gateway") {
            cloud.baseURL.absoluteString == "https://api.changfu.example"
                && BackendEnvironment.defaultCloudURL.absoluteString
                    == "https://s1t8is7jgm85sfs523g5l.apigateway-cn-beijing.volceapi.com"
                && cloud.credentialAccount == "refresh-token.cloud"
                && !cloud.isDebug
                && BackendEnvironment.debugLocal.baseURL.absoluteString
                    == "http://127.0.0.1:4310"
                && BackendEnvironment.debugLocal.credentialAccount
                    == "refresh-token.debug-local"
                && BackendEnvironment.debugLocal.isDebug
        }
        let credentialStore = SecureCredentialStore(
            service: "com.changfu.desktop.tests.\(UUID().uuidString)"
        )
        do {
            try credentialStore.saveRefreshToken("cloud-token", for: cloud)
            try credentialStore.saveRefreshToken("debug-token", for: .debugLocal)
            suite.test("云端与 Debug refresh token 按环境隔离") {
                (try? credentialStore.refreshToken(for: cloud)) == "cloud-token"
                    && (try? credentialStore.refreshToken(for: .debugLocal)) == "debug-token"
            }
            try credentialStore.clearRefreshToken(for: cloud)
            try credentialStore.clearRefreshToken(for: .debugLocal)
        } catch {
            suite.fail("云端与 Debug refresh token 按环境隔离", detail: error.localizedDescription)
        }
    }

    @MainActor
    private static func runBackendClientTests(_ suite: inout TestSuite) async {
        let session = makeMockSession()
        let client = BackendClient(
            baseURL: URL(string: "http://changfu.test:4310")!,
            session: session
        )
        MockURLProtocol.configure([
            "/v1/auth/login": .http(200, tokenJSON),
            "/v1/auth/logout": .http(204, Data())
        ])
        do {
            let pair = try await client.login(loginRequest)
            await client.logout(refreshToken: pair.refreshToken)
            let captured = MockURLProtocol.capturedRequests()
            suite.test("登录与登出请求正确") {
                pair.accessToken == "access-token"
                    && captured.map(\.path).contains("/v1/auth/login")
                    && captured.map(\.path).contains("/v1/auth/logout")
                    && captured.allSatisfy { $0.method == "POST" }
            }
        } catch {
            suite.fail("登录与登出请求正确", detail: error.localizedDescription)
        }

        MockURLProtocol.configure([
            "/v1/ready": .http(
                200,
                Data(#"{"ok":true,"database":true,"worker":true}"#.utf8)
            )
        ])
        do {
            let readiness = try await client.readiness()
            suite.test("Debug readiness 同时要求 Gateway、Worker 与数据库可用") {
                readiness.ok && readiness.database && readiness.worker
            }
        } catch {
            suite.fail(
                "Debug readiness 同时要求 Gateway、Worker 与数据库可用",
                detail: error.localizedDescription
            )
        }

        MockURLProtocol.configure(["/v1/auth/refresh": .http(401, Data())])
        let refreshRejected = await awaitCatches {
            _ = try await client.refresh(refreshToken: "expired")
        } matches: {
            if case BackendClientError.authenticationRejected = $0 { return true }
            return false
        }
        suite.test("刷新令牌 401 强制拒绝认证") {
            refreshRejected
        }

        MockURLProtocol.configure([
            "/v1/ads/active": .http(
                200,
                Data("""
                {"serverTime":"2027-01-15T08:00:00Z","enabled":true,
                 "placement":"startup","durationSeconds":5,"campaignId":null,
                 "version":1,"localAssetId":"startup_default"}
                """.utf8)
            )
        ])
        do {
            let ad = try await client.activeAd(placement: "startup", accessToken: "access")
            suite.test("有效启动广告通过校验") {
                ad?.isValid == true
                    && MockURLProtocol.capturedRequests().last?.authorization == "Bearer access"
            }
        } catch {
            suite.fail("有效启动广告通过校验", detail: error.localizedDescription)
        }

        MockURLProtocol.configure([
            "/v1/ads/active": .http(
                200,
                Data("""
                {"serverTime":"2027-01-15T08:00:00Z","enabled":true,
                 "placement":"unknown","durationSeconds":90,"campaignId":null,
                 "version":1,"localAssetId":"missing"}
                """.utf8)
            )
        ])
        do {
            let ad = try await client.activeAd(placement: "startup", accessToken: "access")
            suite.test("非法广告配置不展示") { ad == nil }
        } catch {
            suite.fail("非法广告配置不展示", detail: error.localizedDescription)
        }

        MockURLProtocol.configure([
            "/v1/broker-connections": .http(
                200,
                Data("""
                {"brokerConnectionId":"broker-1","provider":"FUTU",
                 "displayName":"Futu 实盘账户","environment":"REAL","status":"ACTIVE"}
                """.utf8)
            )
        ])
        do {
            let connection = try await client.registerFutuConnection(
                accountIdHash: "account-hash",
                environment: "REAL",
                accessToken: "access"
            )
            let request = MockURLProtocol.capturedRequests().last
            suite.test("Futu 账户注册使用受保护端点") {
                connection.brokerConnectionId == "broker-1"
                    && connection.provider == "FUTU"
                    && connection.environment == "REAL"
                    && request?.path == "/v1/broker-connections"
                    && request?.authorization == "Bearer access"
                    && request?.idempotencyKey != nil
            }
        } catch {
            suite.fail("Futu 账户注册使用受保护端点", detail: error.localizedDescription)
        }

        MockURLProtocol.configure([
            "/v1/trading/catalog": .http(
                200,
                Data("""
                {"catalogVersion":"2026.09.1","publishedAt":"2026-09-19T00:00:00.000Z",
                 "models":[{"id":"ark-balanced","name":"均衡决策模型",
                 "roles":["SINGLE_DECISION"],"capabilities":["STRUCTURED_OUTPUT"],
                 "latencyTier":"BALANCED","plans":["PRO"]}],
                 "strategies":[],"prompts":[{"id":"single-decision-v1",
                 "name":"单票交易决策","version":"1.0.0","role":"SINGLE_DECISION",
                 "summary":"摘要","constraints":["只读"],"outputFields":["summary"],
                 "publishedAt":"2026-09-19T00:00:00.000Z",
                 "contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}],
                 "riskPolicies":[]}
                """.utf8)
            ),
            "/v1/trading/config": .http(404, Data()),
            "/v1/research/pool": .http(
                200,
                Data("""
                {"entitlement":{"status":"ACTIVE","planName":"专业版","capacity":10,
                 "replacementLimit":3,"replacementUsed":1,"renewsAt":null},
                 "version":2,"items":[],"updatedAt":"2026-09-19T00:00:00.000Z"}
                """.utf8)
            ),
            "/v1/model/runs": .http(
                200,
                Data("""
                {"items":[{"requestId":"run-1","brokerConnectionId":"broker-1",
                 "purpose":"SINGLE_DECISION",
                 "model":"ark-balanced","promptVersion":"1.0.0","status":"COMPLETED",
                 "errorCode":null,"capturedAt":"2026-09-19T00:00:00Z",
                 "sourceExpiresAt":"2026-09-19T00:01:00Z",
                 "startedAt":"2026-09-19T00:00:00Z","finishedAt":"2026-09-19T00:00:01Z"}],
                 "total":21,"limit":10,"offset":0}
                """.utf8)
            ),
            "/v1/signals": .http(
                200,
                Data("""
                {"items":[{"signalId":"signal-1","requestId":"run-1",
                 "brokerConnectionId":"broker-1","symbol":"US.TEST","action":"BUY",
                 "evidenceSummary":{"confidence":0.8},"riskSummary":{"risks":["回撤"]},
                 "exitCondition":"跌破支撑","createdAt":"2026-09-19T00:00:01Z"}]}
                """.utf8)
            ),
            "/v1/candidates": .http(
                200,
                Data("""
                {"items":[{"candidateId":"candidate-1","signalId":"signal-1",
                 "brokerConnectionId":"broker-1","symbol":"US.TEST","side":"BUY",
                 "status":"PENDING","rank":null,"poolVersion":2,"configVersion":1,
                 "createdAt":"2026-09-19T00:00:01Z","expiresAt":"2026-09-19T00:10:01Z"}]}
                """.utf8)
            )
        ])
        do {
            async let catalog = client.tradingCatalog(
                brokerConnectionId: "broker-1",
                accessToken: "access"
            )
            async let configuration = client.tradingConfiguration(
                brokerConnectionId: "broker-1",
                accessToken: "access"
            )
            async let pool = client.researchPool(accessToken: "access")
            let values = try await (catalog, configuration, pool)
            suite.test("交易控制面目录与研究池可只读加载") {
                values.0.catalogVersion == "2026.09.1"
                    && values.0.prompts.first?.summary == "摘要"
                    && values.1 == nil
                    && values.2.version == 2
                    && values.2.entitlement.capacity == 10
                    && MockURLProtocol.capturedRequests().allSatisfy { $0.method == "GET" }
            }
            async let runs = client.modelRuns(
                brokerConnectionId: "broker-1",
                accessToken: "access"
            )
            async let signals = client.tradingSignals(
                brokerConnectionId: "broker-1",
                accessToken: "access"
            )
            async let candidates = client.tradingCandidates(
                brokerConnectionId: "broker-1",
                accessToken: "access"
            )
            let history = try await (runs, signals, candidates)
            suite.test("影子运行信号与候选按账户加载") {
                history.0.items.first?.purpose == "SINGLE_DECISION"
                    && history.0.total == 21
                    && history.0.limit == 10
                    && history.1.first?.evidenceSummary.confidence == 0.8
                    && history.2.first?.status == "PENDING"
            }
        } catch {
            suite.fail("交易控制面目录与研究池可只读加载", detail: error.localizedDescription)
        }

        let savedTradingConfigJSON = Data("""
        {"brokerConnectionId":"broker-1","provider":"FUTU","version":1,
         "catalogVersion":"2026.09.1","executionMode":"CANDIDATE_POOL",
         "confirmationMode":"MANUAL_CONFIRM",
         "models":{"singleDecision":"model-1","portfolioReview":"model-1",
         "managedOrderReview":"model-1"},"strategyId":"strategy-1",
         "singlePromptId":"single-1","portfolioPromptId":"portfolio-1",
         "managedOrderPromptId":"managed-1","scanIntervalSeconds":60,
         "portfolioReviewIntervalSeconds":300,"candidateTtlSeconds":900,
         "maxConcurrency":2,"disableUsOvernightEvaluation":true,
         "riskPolicyId":"risk-1"}
        """.utf8)
        MockURLProtocol.configure([
            "/v1/trading/config/broker-1": .http(200, savedTradingConfigJSON)
        ])
        do {
            let input = try JSONDecoder().decode(
                SaveTradingConfigurationRequest.self,
                from: Data("""
                {"expectedVersion":0,"catalogVersion":"2026.09.1",
                 "executionMode":"CANDIDATE_POOL","confirmationMode":"MANUAL_CONFIRM",
                 "models":{"singleDecision":"model-1","portfolioReview":"model-1",
                 "managedOrderReview":"model-1"},"strategyId":"strategy-1",
                 "singlePromptId":"single-1","portfolioPromptId":"portfolio-1",
                 "managedOrderPromptId":"managed-1","scanIntervalSeconds":60,
                 "portfolioReviewIntervalSeconds":300,"candidateTtlSeconds":900,
                 "maxConcurrency":2,"disableUsOvernightEvaluation":true,
                 "riskPolicyId":"risk-1"}
                """.utf8)
            )
            let saved = try await client.saveTradingConfiguration(
                brokerConnectionId: "broker-1",
                input: input,
                accessToken: "access"
            )
            let request = MockURLProtocol.capturedRequests().last
            suite.test("首次 Futu 影子配置通过鉴权幂等接口保存") {
                saved.version == 1
                    && saved.executionMode == "CANDIDATE_POOL"
                    && request?.path == "/v1/trading/config/broker-1"
                    && request?.method == "PUT"
                    && request?.authorization == "Bearer access"
                    && request?.idempotencyKey != nil
            }
        } catch {
            suite.fail("首次 Futu 影子配置通过鉴权幂等接口保存", detail: error.localizedDescription)
        }

        MockURLProtocol.configure([
            "/v1/subscription/catalog": .http(
                200,
                Data("""
                {"catalogVersion":"2026.09.1","publishedAt":"2026-09-19T00:00:00.000Z",
                 "currency":"CNY","providers":[{"providerId":"FUTU","displayName":"富途",
                 "status":"ACTIVE","supportedMarkets":["US","HK"],
                 "supportedInstrumentTypes":["STOCK","ETF","OPTION"]}],
                 "plans":[{"planVersionId":"00000000-0000-4000-8000-000000000101",
                 "planCode":"LITE","version":1,"displayName":"轻量版","status":"ACTIVE",
                 "effectiveFrom":"2026-09-19T00:00:00.000Z","brokerSlotLimit":1,
                 "poolCapacityPerProvider":5,"monthlyReplacementLimit":1,
                 "features":{"batchSize":100,"optionResearch":true,"optionTrading":false},
                 "prices":[{"priceId":"00000000-0000-4000-8000-000000000201",
                 "billingPeriod":"MONTHLY","durationMonths":1,"currency":"CNY",
                 "amountMinor":2900}]}],
                 "paymentChannels":[{"channel":"WECHAT","displayName":"微信支付",
                 "available":false,"unavailableReason":"PAYMENT_CREDENTIALS_MISSING"}]}
                """.utf8)
            ),
            "/v1/subscription/current": .http(
                200,
                Data(#"{"subscription":null}"#.utf8)
            ),
            "/v1/subscription/orders": .http(
                201,
                Data("""
                {"orderId":"00000000-0000-4000-8000-000000000301",
                 "businessOrderNo":"CF202609190001","orderType":"NEW",
                 "planVersionId":"00000000-0000-4000-8000-000000000101",
                 "planCode":"LITE","billingPeriod":"MONTHLY","currency":"CNY",
                 "originalAmountMinor":2900,"creditAmountMinor":0,"payableAmountMinor":2900,
                 "status":"CREATED","providerSelections":[{"slotOrdinal":1,"providerId":"FUTU"}],
                 "quoteExpiresAt":"2026-09-19T00:15:00.000Z",
                 "createdAt":"2026-09-19T00:00:00.000Z","paidAt":null,"payment":null}
                """.utf8)
            )
        ])
        do {
            async let catalog = client.subscriptionCatalog(accessToken: "access")
            async let current = client.currentSubscription(accessToken: "access")
            let values = try await (catalog, current)
            let order = try await client.createSubscriptionOrder(
                CreateSubscriptionOrderRequest(
                    orderType: .new,
                    planVersionId: values.0.plans[0].planVersionId,
                    billingPeriod: .monthly,
                    providerSelections: [
                        SubscriptionProviderSelection(slotOrdinal: 1, providerId: "FUTU")
                    ]
                ),
                accessToken: "access"
            )
            let requests = MockURLProtocol.capturedRequests()
            suite.test("订阅目录、当前权益与幂等订单接口完整") {
                values.0.plans.first?.poolCapacityPerProvider == 5
                    && values.1 == nil
                    && order.payableAmountMinor == 2900
                    && requests.first { $0.path == "/v1/subscription/orders" }?
                        .idempotencyKey != nil
            }
        } catch {
            suite.fail("订阅目录、当前权益与幂等订单接口完整", detail: error.localizedDescription)
        }

        let modelConfigJSON = Data("""
        {"eligible":true,"planCode":"FLAGSHIP",
         "config":{"configId":"00000000-0000-4000-8000-000000000501",
         "displayName":"自有模型","protocol":"OPENAI_RESPONSES",
         "endpoint":"https://api.example.com/v1/responses","model":"model-1",
         "enabled":true,"keyConfigured":true,"keyLastFour":"1234",
         "updatedAt":"2026-09-19T00:00:00.000Z"}}
        """.utf8)
        MockURLProtocol.configure([
            "/v1/model-provider/config": .http(200, modelConfigJSON)
        ])
        do {
            let configuration = try await client.thirdPartyModelConfiguration(
                accessToken: "access"
            )
            suite.test("第三方模型读取接口只返回脱敏配置") {
                configuration.eligible
                    && configuration.config?.keyLastFour == "1234"
                    && MockURLProtocol.capturedRequests().last?.method == "GET"
            }
        } catch {
            suite.fail("第三方模型读取接口只返回脱敏配置", detail: error.localizedDescription)
        }

        MockURLProtocol.configure([
            "/v1/model-provider/config": .http(200, modelConfigJSON)
        ])
        do {
            _ = try await client.saveThirdPartyModelConfiguration(
                SaveThirdPartyModelConfigurationRequest(
                    displayName: "自有模型",
                    protocol: .responses,
                    endpoint: "https://api.example.com/v1/responses",
                    model: "model-1",
                    apiKey: "sk-secret-value",
                    enabled: true
                ),
                accessToken: "access"
            )
            let request = MockURLProtocol.capturedRequests().last
            suite.test("第三方模型写入使用鉴权和幂等键") {
                request?.method == "PUT"
                    && request?.authorization == "Bearer access"
                    && request?.idempotencyKey != nil
            }
        } catch {
            suite.fail("第三方模型写入使用鉴权和幂等键", detail: error.localizedDescription)
        }

        let providerPoolJSON = Data("""
        {"providerId":"FUTU","status":"ACTIVE","frozenReason":null,"version":2,
         "entitlement":{"active":true,"capacity":5,"used":1,"replacementLimit":1,
         "replacementUsed":0,"replacementWindowStart":"2026-09-19T00:00:00.000Z",
         "replacementWindowEnd":"2026-10-19T00:00:00.000Z"},
         "items":[{"itemId":"00000000-0000-4000-8000-000000000401",
         "providerId":"FUTU","providerSymbol":"US.AAPL","canonicalSymbol":"US.AAPL",
         "displayName":"Apple","market":"US","instrumentType":"STOCK","optionType":null,
         "underlyingSymbol":null,"expiryDate":null,"strikePrice":null,"currency":"USD",
         "contractMultiplier":null,"status":"ACTIVE",
         "addedAt":"2026-09-19T00:00:00.000Z"}],
         "nextCursor":null,"updatedAt":"2026-09-19T00:00:00.000Z"}
        """.utf8)
        MockURLProtocol.configure([
            "/v1/research/pools": .http(
                200,
                Data("""
                {"items":[{"providerId":"FUTU","status":"ACTIVE","version":2,
                 "used":1,"capacity":5,"updatedAt":"2026-09-19T00:00:00.000Z"}]}
                """.utf8),
                headers: ["ETag": "\"list-v2\""]
            ),
            "/v1/research/pools/FUTU": .http(
                200,
                providerPoolJSON,
                headers: ["ETag": "\"pool-v2\""]
            )
        ])
        do {
            let list = try await client.providerPoolSummaries(
                ifNoneMatch: nil,
                accessToken: "access"
            )
            let page = try await client.providerPoolPage(
                providerId: "FUTU",
                cursor: nil,
                ifNoneMatch: nil,
                accessToken: "access"
            )
            suite.test("Provider 池列表与分页响应保留 ETag") {
                list.items?.first?.providerId == "FUTU"
                    && list.etag == "\"list-v2\""
                    && page.pool?.items.first?.providerSymbol == "US.AAPL"
                    && page.etag == "\"pool-v2\""
            }
        } catch {
            suite.fail("Provider 池列表与分页响应保留 ETag", detail: error.localizedDescription)
        }

        MockURLProtocol.configure([
            "/v1/research/pools": .http(
                304,
                Data(),
                headers: ["ETag": "\"list-v2\""]
            )
        ])
        do {
            let result = try await client.providerPoolSummaries(
                ifNoneMatch: "\"list-v2\"",
                accessToken: "access"
            )
            suite.test("Provider 池 ETag 命中时使用 304") {
                result.notModified
                    && result.items == nil
                    && MockURLProtocol.capturedRequests().last?.ifNoneMatch == "\"list-v2\""
            }
        } catch {
            suite.fail("Provider 池 ETag 命中时使用 304", detail: error.localizedDescription)
        }

        do {
            let context = try makeContext()
            MockURLProtocol.configure([
                "/v1/model/runs": .http(
                    200,
                    Data((
                        "{\"type\":\"accepted\",\"requestId\":\"request-1\","
                            + "\"occurredAt\":\"2026-09-19T00:00:00Z\","
                            + "\"stage\":\"accepted\",\"percent\":0}\n"
                            + "{\"type\":\"result\",\"requestId\":\"request-1\","
                            + "\"occurredAt\":\"2026-09-19T00:00:01Z\","
                            + "\"result\":\(modelResultJSON)}\n"
                    ).utf8)
                )
            ])
            let result = try await client.runModel(
                context: context,
                userMessage: "评估风险",
                modelRoute: "OFFICIAL",
                accessToken: "access"
            )
            let requestBody = MockURLProtocol.capturedRequests().last?.body
                .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            suite.test("模型流读取最后一条结构化结果") {
                result.status == "COMPLETED"
                    && result.evidence.first?.summary == "证据"
                    && MockURLProtocol.capturedRequests().last?.idempotencyKey != nil
                    && (requestBody?["modelRoute"] as? String) == "OFFICIAL"
            }
        } catch {
            suite.fail("模型流读取最后一条结构化结果", detail: String(reflecting: error))
        }

        MockURLProtocol.configure(["/v1/model/runs": .http(503, Data())])
        let modelUnavailable = await awaitCatches {
            _ = try await client.runModel(
                context: try makeContext(),
                userMessage: nil,
                accessToken: "access"
            )
        } matches: {
            if case BackendClientError.serviceUnavailable = $0 { return true }
            return false
        }
        suite.test("模型服务异常明确降级") {
            modelUnavailable
        }
        suite.test("后台错误文案完整") {
            BackendClientError.requestFailed.localizedDescription.contains("请求")
                && BackendClientError.authenticationRejected.localizedDescription.contains("账号")
                && BackendClientError.serviceUnavailable.localizedDescription.contains("不可用")
        }

        let cache = ProviderPoolCache()
        let namespace = UUID().uuidString.replacingOccurrences(of: "-", with: "")
        do {
            let snapshot = ProviderPoolCacheSnapshot(
                listETag: "\"test\"",
                summaries: [],
                poolETags: [:],
                pools: [:],
                cachedAt: Date(timeIntervalSince1970: 1_800_000_000)
            )
            try await cache.save(snapshot, namespace: namespace)
            let loaded = await cache.load(namespace: namespace)
            let root = FileManager.default.urls(
                for: .applicationSupportDirectory,
                in: .userDomainMask
            ).first!
                .appending(path: "com.changfu.desktop/provider-pools/\(namespace).json")
            let attributes = try FileManager.default.attributesOfItem(atPath: root.path)
            let permissions = (attributes[.posixPermissions] as? NSNumber)?.intValue
            await cache.remove(namespace: namespace)
            suite.test("Provider 池缓存原子保存并使用私有权限") {
                loaded?.listETag == "\"test\""
                    && permissions == 0o600
                    && !FileManager.default.fileExists(atPath: root.path)
            }
        } catch {
            await cache.remove(namespace: namespace)
            suite.fail("Provider 池缓存原子保存并使用私有权限", detail: error.localizedDescription)
        }
        session.invalidateAndCancel()
    }

    @MainActor
    private static func runBrokerTests(_ suite: inout TestSuite) async {
        let fixtureDirectory = FileManager.default.temporaryDirectory
            .appending(path: "changfu-broker-tests-\(UUID().uuidString)")
        do {
            try FileManager.default.createDirectory(
                at: fixtureDirectory,
                withIntermediateDirectories: true
            )
        } catch {
            suite.fail("创建 Broker 测试夹具", detail: error.localizedDescription)
        }
        defer { try? FileManager.default.removeItem(at: fixtureDirectory) }

        let missingHostBroker = FutuBrokerClient(
            hostExecutableURL: URL(fileURLWithPath: "/不存在/ChangFuBrokerHost")
        )
        await missingHostBroker.connect()
        suite.test("宿主缺失时不得伪造连接") {
            guard case .failed(let message) = missingHostBroker.connectionState else {
                return false
            }
            return message.contains("BrokerHost")
        }
        suite.test("主动断开后状态同步") {
            missingHostBroker.disconnect()
            return missingHostBroker.connectionState == .disconnected
        }
        suite.test("Broker 错误文案完整") {
            BrokerClientError.hostUnavailable.localizedDescription.contains("不可用")
                && BrokerClientError.hostFailed("宿主错误").localizedDescription == "宿主错误"
                && BrokerClientError.invalidResponse.localizedDescription.contains("无效")
        }

        do {
            let invalidHost = try makeBrokerFixture(
                in: fixtureDirectory,
                name: "invalid-host",
                script: """
                #!/bin/sh
                if [ "$1" = "probe" ]; then
                  printf '{"connected":true}\\n'
                else
                  printf 'not-json\\n'
                fi
                """
            )
            let invalidBroker = FutuBrokerClient(hostExecutableURL: invalidHost)
            await invalidBroker.connect()
            let rejected = await awaitCatches {
                _ = try await invalidBroker.loadSnapshot()
            } matches: {
                if case BrokerClientError.invalidResponse = $0 { return true }
                return false
            }
            suite.test("无效宿主快照被拒绝") {
                rejected
                    && invalidBroker.connectionState
                        == .failed(BrokerClientError.invalidResponse.localizedDescription)
            }

            let failedHost = try makeBrokerFixture(
                in: fixtureDirectory,
                name: "failed-host",
                script: """
                #!/bin/sh
                printf '测试宿主失败\\n' >&2
                exit 9
                """
            )
            let failedBroker = FutuBrokerClient(hostExecutableURL: failedHost)
            await failedBroker.connect()
            let failedSnapshot = await awaitCatches {
                _ = try await failedBroker.loadSnapshot()
            } matches: {
                guard case BrokerClientError.hostFailed(let message) = $0 else { return false }
                return message == "测试宿主失败"
            }
            suite.test("宿主失败信息向客户端传递") {
                failedSnapshot
                    && failedBroker.connectionState.label.contains("测试宿主失败")
            }

            setenv("CHANGFU_BROKER_HOST", invalidHost.path, 1)
            let configuredBroker = FutuBrokerClient()
            await configuredBroker.connect()
            unsetenv("CHANGFU_BROKER_HOST")
            _ = FutuBrokerClient()
            suite.test("默认宿主路径支持环境变量覆盖") {
                configuredBroker.connectionState == .connected
            }

            let discoveryHost = try makeBrokerFixture(
                in: fixtureDirectory,
                name: "discovery-host",
                script: """
                #!/bin/sh
                case "$1" in
                  capabilities)
                    printf '{"providerId":"FUTU","searchMode":"FUZZY","supportedMarkets":["US","HK","CN","SG"],"supportedInstrumentTypes":["STOCK","ETF","OPTION"],"supportsOptionChain":true}'
                    ;;
                  search-instruments)
                    cat >/dev/null
                    printf '{"providerId":"FUTU","query":"Apple","queryMode":"FUZZY","results":[{"providerId":"FUTU","providerSymbol":"US.AAPL","canonicalSymbol":"US.AAPL","displayName":"Apple","market":"US","instrumentType":"STOCK","currency":"USD","addable":true}],"fetchedAt":"2026-09-19T00:00:00Z"}'
                    ;;
                  market-intelligence)
                    cat >/dev/null
                    printf '{"providerId":"FUTU","fetchedAt":"2026-09-20T00:00:00Z","sections":[{"group":"US_MACRO","availability":"AVAILABLE","message":null,"events":[{"id":"macro-1","group":"US_MACRO","category":"ECONOMIC_CALENDAR","title":"CPI","source":"Futu 财经日历","publishedAt":"2026-09-20T12:00:00Z","fetchedAt":"2026-09-20T00:00:00Z","relatedSymbols":[],"importance":"CRITICAL","validUntil":"2026-09-21T12:00:00Z","url":null,"previous":"2.7%%","consensus":"2.8%%","actual":null,"detail":null}]}]}'
                    ;;
                  option-expiries)
                    cat >/dev/null
                    printf '{"providerId":"FUTU","underlyingSymbol":"US.AAPL","expiries":[{"underlyingSymbol":"US.AAPL","expiryDate":"2026-09-25"}],"fetchedAt":"2026-09-19T00:00:00Z"}'
                    ;;
                  option-chain)
                    cat >/dev/null
                    printf '{"providerId":"FUTU","underlyingSymbol":"US.AAPL","expiryDate":"2026-09-25","contracts":[{"providerId":"FUTU","providerSymbol":"US.AAPL260925C00200000","canonicalSymbol":"US.AAPL260925C00200000","displayName":"AAPL 200 Call","market":"US","instrumentType":"OPTION","optionType":"CALL","underlyingSymbol":"US.AAPL","expiryDate":"2026-09-25","strikePrice":"200","currency":"USD","contractMultiplier":"100","addable":true}],"fetchedAt":"2026-09-19T00:00:00Z"}'
                    ;;
                  *)
                    exit 8
                    ;;
                esac
                """
            )
            let discovery = FutuBrokerClient(hostExecutableURL: discoveryHost)
            let capability = try await discovery.capabilities()
            let search = try await discovery.searchInstruments(
                BrokerInstrumentSearchRequest(
                    query: "Apple",
                    markets: [.us],
                    instrumentTypes: [.stock]
                )
            )
            let intelligence = try await discovery.loadMarketIntelligence(
                symbols: ["US.AAPL"]
            )
            let expiries = try await discovery.optionExpiries(for: "US.AAPL")
            let chain = try await discovery.optionChain(
                for: "US.AAPL",
                expiryDate: "2026-09-25"
            )
            suite.test("Futu 标的发现 IPC 使用统一模型") {
                capability.providerId == "FUTU"
                    && capability.searchMode == .fuzzy
                    && capability.supportsOptionChain
                    && search.results.first?.providerSymbol == "US.AAPL"
                    && search.results.first?.instrumentType == .stock
                    && intelligence.section(.usMacro).events.first?.title == "CPI"
                    && expiries.expiries.first?.expiryDate == "2026-09-25"
                    && chain.contracts.first?.optionType == .call
                    && chain.contracts.first?.contractMultiplier == "100"
            }
        } catch {
            suite.fail("Broker 异常夹具", detail: error.localizedDescription)
        }

        if let hostPath = ProcessInfo.processInfo.environment["CHANGFU_TEST_BROKER_HOST"] {
            let realBroker = FutuBrokerClient(
                hostExecutableURL: URL(fileURLWithPath: hostPath)
            )
            for attempt in 1...3 {
                await realBroker.connect()
                if realBroker.connectionState == .connected { break }
                if attempt < 3 {
                    try? await Task.sleep(for: .milliseconds(300))
                }
            }
            suite.test("真实 OpenD 握手") {
                realBroker.connectionState == .connected
            }
            do {
                let snapshot = try await realBroker.loadSnapshot()
                suite.test("真实 OpenD 快照") {
                    snapshot.account.totalAssets != 0
                        && !snapshot.positions.isEmpty
                        && !snapshot.market.state.isEmpty
                }
                suite.test("真实 OpenD 全量只读数据") {
                    !snapshot.quotes.isEmpty
                        && !snapshot.minuteBars.isEmpty
                        && !snapshot.tickerPoints.isEmpty
                        && !snapshot.orderBooks.isEmpty
                        && !snapshot.historicalOrders.isEmpty
                        && !snapshot.historicalDeals.isEmpty
                }
                suite.test("真实 OpenD 数据标的与持仓一致") {
                    let positionSymbols = Set(snapshot.positions.map(\.symbol))
                    let quoteSymbols = Set(snapshot.quotes.map(\.symbol))
                    return quoteSymbols.isSubset(of: positionSymbols)
                        && snapshot.orderBooks.allSatisfy {
                            positionSymbols.contains($0.symbol)
                        }
                }
                suite.test("真实 OpenD 主市场状态与持仓一致") {
                    let prefix: String?
                    switch snapshot.market.name {
                    case "美股": prefix = "US."
                    case "港股": prefix = "HK."
                    case "A 股": prefix = "CN."
                    case "新加坡": prefix = "SG."
                    case "日本": prefix = "JP."
                    default: prefix = nil
                    }
                    guard let prefix else { return false }
                    let primaryQuotes = snapshot.quotes.filter {
                        $0.symbol.hasPrefix(prefix)
                    }
                    return !primaryQuotes.isEmpty
                        && primaryQuotes.allSatisfy {
                            $0.marketState == snapshot.market.state
                        }
                }
                let researchSnapshot = try await realBroker.loadSnapshot(
                    additionalSymbols: ["US.MU", "US.NVDA", "US.SNDK"]
                )
                let researchSymbols = Set(["US.MU", "US.NVDA", "US.SNDK"])
                suite.test("真实 OpenD 优先加载 Futu 池行情") {
                    researchSymbols.isSubset(of: Set(researchSnapshot.quotes.map(\.symbol)))
                        && researchSymbols.isSubset(
                            of: Set(researchSnapshot.minuteBars.map(\.symbol))
                        )
                }
            } catch {
                suite.fail("真实 OpenD 快照", detail: error.localizedDescription)
            }
        }
    }

    @MainActor
    private static func runLongbridgeBrokerTests(_ suite: inout TestSuite) async {
        let directory = FileManager.default.temporaryDirectory
            .appending(path: "changfu-longbridge-tests-\(UUID().uuidString)")
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        } catch {
            suite.fail("创建 Longbridge 测试夹具", detail: error.localizedDescription)
        }
        defer { try? FileManager.default.removeItem(at: directory) }

        let missing = LongbridgeBrokerClient(
            hostExecutableURL: URL(fileURLWithPath: "/不存在/ChangFuLongbridgeHost")
        )
        await missing.connect()
        suite.test("Longbridge Host 缺失状态独立") {
            missing.connectionState == .cliUnavailable
        }

        do {
            let unauthorizedHost = try makeBrokerFixture(
                in: directory,
                name: "longbridge-unauthorized",
                script: """
                #!/bin/sh
                printf 'Longbridge 未授权，请先完成 Longbridge 登录授权\\n' >&2
                exit 3
                """
            )
            let unauthorized = LongbridgeBrokerClient(hostExecutableURL: unauthorizedHost)
            await unauthorized.connect()
            suite.test("Longbridge 未授权不会伪造成零资产") {
                unauthorized.connectionState == .unauthorized
            }

            let snapshotURL = directory.appending(path: "longbridge-valid.snapshot")
            try fixtureData.write(to: snapshotURL)
            let validHost = try makeBrokerFixture(
                in: directory,
                name: "longbridge-valid",
                script: """
                #!/bin/sh
                if [ "$1" = "probe" ]; then
                  printf '{"connected":true}\\n'
                else
                  cat "$0.snapshot"
                fi
                """
            )
            let valid = LongbridgeBrokerClient(hostExecutableURL: validHost)
            await valid.connect()
            let snapshot = try await valid.loadSnapshot()
            suite.test("Longbridge 客户端解码共享快照") {
                valid.connectionState == .connected
                    && snapshot.account.accountId == "test-account"
                    && snapshot.positions.count == 1
            }
            valid.disconnect()
            suite.test("Longbridge 主动断开状态同步") {
                valid.connectionState == .disconnected
            }
        } catch {
            suite.fail("Longbridge 客户端夹具", detail: error.localizedDescription)
        }

        guard let hostPath = ProcessInfo.processInfo.environment[
            "CHANGFU_TEST_LONGBRIDGE_HOST"
        ] else { return }
        do {
            let cli = try makeBrokerFixture(
                in: directory,
                name: "longbridge",
                script: """
                #!/bin/sh
                if [ "$LONGBRIDGE_APP_KEY" != "test-app-key" ] || \
                   [ "$LONGBRIDGE_APP_SECRET" != "test-app-secret" ] || \
                   [ "$LONGBRIDGE_ACCESS_TOKEN" != "test-access-token" ]; then
                  printf 'API credentials missing\\n' >&2
                  exit 7
                fi
                case "$1" in
                  auth)
                    printf '{"token":{"status":"authenticated"}}\\n'
                    ;;
                  assets)
                    printf '{"currency":"USD","net_assets":"12000.50","total_cash":4000,"buy_power":"8000.25"}\\n'
                    ;;
                  positions)
                    printf '[{"symbol":"AAPL.US","name":"Apple","quantity":"10","cost_price":"180","currency":"USD","market":"US"},{"symbol":"700.HK","name":"腾讯控股","quantity":20,"cost_price":"500","currency":"HKD","market":"HK"}]\\n'
                    ;;
                  quote)
                    printf '[{"symbol":"AAPL.US","last_done":"200","prev_close":"198","trade_status":"Overnight","overnight_quote":{"last_done":"201.5"}},{"symbol":"700.HK","last_done":"510","prev_close":"505","trade_status":"Normal"}]\\n'
                    ;;
                  kline)
                    printf '[{"time":"2026-09-18T01:00:00Z","open":"198","high":"201","low":"197","close":"200","volume":"1000","turnover":"200000"}]\\n'
                    ;;
                  market-status)
                    printf '[{"market":"US","status":"Overnight"},{"market":"HK","status":"Trading"}]\\n'
                    ;;
                  order)
                    if [ "$2" = "executions" ]; then
                      printf '[{"trade_id":"fill-1","order_id":"order-1","symbol":"AAPL.US","side":"Buy","quantity":"1","price":"199","trade_done_at":"2026-09-18T01:00:00Z"}]\\n'
                    else
                      printf '[{"order_id":"order-1","symbol":"AAPL.US","side":"Buy","status":"Filled","quantity":"1","price":"199","executed_quantity":"1","executed_price":"199"}]\\n'
                    fi
                    ;;
                  *)
                    exit 8
                    ;;
                esac
                """
            )
            setenv("CHANGFU_LONGBRIDGE_CLI", cli.path, 1)
            defer { unsetenv("CHANGFU_LONGBRIDGE_CLI") }
            let credentialStore = SecureCredentialStore(
                service: "com.changfu.desktop.tests.\(UUID().uuidString)"
            )
            try credentialStore.saveLongbridgeCredentials(LongbridgeCredentials(
                appKey: "test-app-key",
                appSecret: "test-app-secret",
                accessToken: "test-access-token"
            ))
            defer { try? credentialStore.clearLongbridgeCredentials() }
            let broker = LongbridgeBrokerClient(
                hostExecutableURL: URL(fileURLWithPath: hostPath),
                credentialStore: credentialStore
            )
            await broker.connect()
            let snapshot = try await broker.loadSnapshot()
            suite.test("Longbridge Host 标准化动态 JSON") {
                snapshot.account.totalAssets == Decimal(string: "12000.50")
                    && snapshot.positions.count == 2
                    && snapshot.quotes.count == 2
                    && snapshot.minuteBars.count == 2
                    && snapshot.openOrders.count == 1
                    && snapshot.recentDeals.count == 1
                    && snapshot.dataGaps.count == 2
            }
            suite.test("Longbridge API 凭据经安全通道传入 Host") {
                (try? credentialStore.longbridgeCredentials())?.appKey == "test-app-key"
                    && broker.connectionState == .connected
            }
            suite.test("Longbridge 美股与港股时段互不污染") {
                snapshot.quotes.first { $0.symbol == "US.AAPL" }?.marketState == "夜盘"
                    && snapshot.quotes.first { $0.symbol == "HK.700" }?.marketState == "盘中"
                    && snapshot.quotes.first { $0.symbol == "US.AAPL" }?.overnightPrice
                        == Decimal(string: "201.5")
            }
        } catch {
            suite.fail("Longbridge Host 解析夹具", detail: error.localizedDescription)
        }
    }

    private static func makeBrokerFixture(
        in directory: URL,
        name: String,
        script: String
    ) throws -> URL {
        let url = directory.appending(path: name)
        try Data(script.utf8).write(to: url, options: .atomic)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: url.path
        )
        return url
    }

    private static func makeSignedIntent(
        key: Curve25519.Signing.PrivateKey,
        now: Date,
        schemaVersion: String = "2.0",
        issuedAt: Date? = nil,
        expiresAt: Date? = nil,
        maxSlippageBps: Int = 10,
        mustCheckOpenOrders: Bool = true,
        sessionId: String? = nil,
        executionMode: String = "MANUAL_CONFIRM",
        signatureOverride: String? = nil
    ) throws -> SignedOrderIntent {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let order = SignedOrderIntent.OrderSpec(
            broker: "FUTU",
            environment: "REAL",
            market: "US",
            symbol: "US.TEST",
            side: "BUY",
            positionEffect: "OPEN",
            orderType: "LIMIT",
            quantity: "1",
            limitPrice: "10.00",
            currency: "USD",
            maxSlippageBps: maxSlippageBps
        )
        let unsigned = TestUnsignedOrderIntent(
            schemaVersion: schemaVersion,
            intentId: "intent-1",
            userId: "user-1",
            deviceId: "device-1",
            brokerConnectionId: "broker-1",
            provider: "FUTU",
            accountIdHash: "account-hash",
            contextHash: "context-hash",
            strategyVersion: "strategy-1",
            sessionId: sessionId,
            poolVersion: 1,
            configVersion: 1,
            riskPolicyVersion: "risk-v1",
            executionMode: executionMode,
            clientRevalidation: SignedOrderIntent.ClientRevalidation(
                quoteMaxAgeMs: 5_000,
                accountMaxAgeMs: 10_000,
                mustCheckOpenOrders: mustCheckOpenOrders
            ),
            order: order,
            issuedAt: formatter.string(from: issuedAt ?? now),
            expiresAt: formatter.string(from: expiresAt ?? now.addingTimeInterval(30)),
            keyId: "key-1"
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let signature = try key.signature(for: encoder.encode(unsigned)).base64URL
        return SignedOrderIntent(
            schemaVersion: unsigned.schemaVersion,
            intentId: unsigned.intentId,
            userId: unsigned.userId,
            deviceId: unsigned.deviceId,
            brokerConnectionId: unsigned.brokerConnectionId,
            provider: unsigned.provider,
            accountIdHash: unsigned.accountIdHash,
            contextHash: unsigned.contextHash,
            strategyVersion: unsigned.strategyVersion,
            sessionId: unsigned.sessionId,
            poolVersion: unsigned.poolVersion,
            configVersion: unsigned.configVersion,
            riskPolicyVersion: unsigned.riskPolicyVersion,
            executionMode: unsigned.executionMode,
            clientRevalidation: unsigned.clientRevalidation,
            order: unsigned.order,
            issuedAt: unsigned.issuedAt,
            expiresAt: unsigned.expiresAt,
            keyId: unsigned.keyId,
            signature: signatureOverride ?? signature
        )
    }

    private static func makeContext() throws -> ContextEnvelope {
        try ContextEnvelopeFactory.make(
            deviceId: "device-1",
            brokerConnectionId: "broker-1",
            purpose: "CHAT",
            sequence: 1,
            snapshot: ContextSnapshot(account: ["accountIdHash": .string("hash")]),
            strategyConfigVersion: "strategy-1",
            clientPolicyVersion: "policy-1",
            devicePrivateKey: Curve25519.Signing.PrivateKey(),
            now: Date(timeIntervalSince1970: 1_800_000_000)
        )
    }

    private static func catches(
        _ operation: () throws -> Void,
        matches: (Error) -> Bool
    ) -> Bool {
        do {
            try operation()
            return false
        } catch {
            return matches(error)
        }
    }

    @MainActor
    private static func awaitCatches(
        _ operation: () async throws -> Void,
        matches: (Error) -> Bool
    ) async -> Bool {
        do {
            try await operation()
            return false
        } catch {
            return matches(error)
        }
    }

    private static func sameOrderError(
        _ error: Error,
        _ expected: OrderIntentVerificationError
    ) -> Bool {
        guard let actual = error as? OrderIntentVerificationError else { return false }
        return switch (actual, expected) {
        case (.unsupportedVersion, .unsupportedVersion),
             (.bindingMismatch, .bindingMismatch),
             (.expired, .expired),
             (.invalidIssueTime, .invalidIssueTime),
             (.invalidSlippage, .invalidSlippage),
             (.invalidSignatureEncoding, .invalidSignatureEncoding),
             (.invalidSignature, .invalidSignature):
            true
        default:
            false
        }
    }

    private static func makeMockSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    private static let loginRequest = DesktopLoginRequest(
        username: "user",
        password: "password",
        deviceId: "device",
        deviceFingerprint: "fingerprint",
        displayName: "测试设备",
        platform: "macOS",
        appVersion: "1.0",
        publicKey: "public-key"
    )

    private static let tokenJSON = Data(
        """
        {"accessToken":"access-token","accessExpiresAt":"2027-01-15T08:00:00Z",
         "refreshToken":"refresh-token","refreshExpiresAt":"2027-01-16T08:00:00Z"}
        """.utf8
    )

    private static let modelResultJSON = """
        {"schemaVersion":"1.0","requestId":"request-1","status":"COMPLETED","responseType":"ANALYSIS","summary":"结论","evidence":[{"id":"e1","kind":"ACCOUNT","summary":"证据","sourceAt":null}],"counterEvidence":[],"risks":["风险"],"dataGaps":[],"exitCondition":"退出条件","sourceValidUntil":null,"orderIntent":null}
        """

    private static let fixtureData = Data(
        """
        {
          "account": {
            "accountId": "test-account",
            "environment": "SIMULATE",
            "totalAssets": 1000.5,
            "cash": 200.25,
            "buyingPower": 400.5,
            "currency": "USD"
          },
          "positions": [{
            "id": "position-1",
            "symbol": "US.TEST",
            "name": "测试证券",
            "quantity": -2,
            "costPrice": 12.5,
            "lastPrice": 10,
            "todayProfit": 5,
            "currency": "USD"
          }],
          "market": {
            "name": "美股",
            "state": "交易中",
            "stateValue": 37
          }
        }
        """.utf8
    )
}

private struct TestUnsignedOrderIntent: Encodable {
    let schemaVersion: String
    let intentId: String
    let userId: String
    let deviceId: String
    let brokerConnectionId: String
    let provider: String
    let accountIdHash: String
    let contextHash: String
    let strategyVersion: String
    let sessionId: String?
    let poolVersion: Int
    let configVersion: Int
    let riskPolicyVersion: String
    let executionMode: String
    let clientRevalidation: SignedOrderIntent.ClientRevalidation
    let order: SignedOrderIntent.OrderSpec
    let issuedAt: String
    let expiresAt: String
    let keyId: String
}

private struct TestSuite {
    private var passed = 0
    private var failed = 0

    mutating func test(_ name: String, _ assertion: () -> Bool) {
        if assertion() {
            passed += 1
            print("通过：\(name)")
        } else {
            fail(name, detail: "断言不成立")
        }
    }

    mutating func test(_ name: String, _ assertion: () async -> Bool) async {
        if await assertion() {
            passed += 1
            print("通过：\(name)")
        } else {
            fail(name, detail: "断言不成立")
        }
    }

    mutating func fail(_ name: String, detail: String) {
        failed += 1
        print("失败：\(name)：\(detail)")
    }

    func finish() -> Never {
        print("长富桌面测试：通过 \(passed)，失败 \(failed)")
        Foundation.exit(failed == 0 ? EXIT_SUCCESS : EXIT_FAILURE)
    }
}

private struct MockResponse: Sendable {
    let statusCode: Int
    let data: Data
    let headers: [String: String]

    static func http(
        _ statusCode: Int,
        _ data: Data,
        headers: [String: String] = [:]
    ) -> MockResponse {
        MockResponse(statusCode: statusCode, data: data, headers: headers)
    }
}

private struct CapturedRequest: Sendable {
    let path: String
    let method: String
    let authorization: String?
    let idempotencyKey: String?
    let ifNoneMatch: String?
    let body: Data?
}

private func requestBodyData(_ request: URLRequest) -> Data? {
    if let body = request.httpBody {
        return body
    }
    guard let stream = request.httpBodyStream else {
        return nil
    }
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while stream.hasBytesAvailable {
        let count = stream.read(&buffer, maxLength: buffer.count)
        guard count > 0 else { break }
        data.append(buffer, count: count)
    }
    return data
}

private final class MockURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var responses: [String: MockResponse] = [:]
    nonisolated(unsafe) private static var requests: [CapturedRequest] = []

    static func configure(_ newResponses: [String: MockResponse]) {
        lock.lock()
        responses = newResponses
        requests = []
        lock.unlock()
    }

    static func capturedRequests() -> [CapturedRequest] {
        lock.lock()
        defer { lock.unlock() }
        return requests
    }

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == "changfu.test"
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        let path = request.url?.path ?? ""
        let body = requestBodyData(request)
        Self.lock.lock()
        Self.requests.append(CapturedRequest(
            path: path,
            method: request.httpMethod ?? "GET",
            authorization: request.value(forHTTPHeaderField: "Authorization"),
            idempotencyKey: request.value(forHTTPHeaderField: "Idempotency-Key"),
            ifNoneMatch: request.value(forHTTPHeaderField: "If-None-Match"),
            body: body
        ))
        let response = Self.responses[path]
        Self.lock.unlock()

        guard let response, let url = request.url,
              let http = HTTPURLResponse(
                url: url,
                statusCode: response.statusCode,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"].merging(
                    response.headers,
                    uniquingKeysWith: { _, new in new }
                )
              ) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
        if !response.data.isEmpty {
            client?.urlProtocol(self, didLoad: response.data)
        }
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private extension Data {
    init?(base64URL value: String) {
        var normalized = value
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = normalized.count % 4
        if remainder != 0 {
            normalized += String(repeating: "=", count: 4 - remainder)
        }
        self.init(base64Encoded: normalized)
    }

    init(hex value: String) {
        self.init(stride(from: 0, to: value.count, by: 2).compactMap { index in
            let start = value.index(value.startIndex, offsetBy: index)
            let end = value.index(start, offsetBy: 2)
            return UInt8(value[start..<end], radix: 16)
        })
    }

    var base64URL: String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
