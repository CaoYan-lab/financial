import ChangFuDomain
import SwiftUI

struct FutuWorkspaceView: View {
    @Bindable var state: AppState

    var body: some View {
        ScrollViewReader { proxy in
            ZStack(alignment: .bottomTrailing) {
                ScrollView {
                    VStack(alignment: .leading, spacing: FutuTheme.sectionSpacing) {
                        WorkspaceHeading(
                            platform: state.platform,
                            title: state.workspace.title,
                            detail: detail,
                            status: state.currentStatusMessage
                        )
                        .id(StrategyCenterAnchor.top)
                        switch state.workspace {
                        case .overview:
                            OverviewWorkspace(state: state)
                        case .market:
                            MarketWorkspace(state: state)
                        case .research:
                            ResearchWorkspace(state: state)
                        case .trading:
                            TradingWorkspace(state: state)
                        case .assets:
                            AssetsWorkspace(state: state)
                        case .strategyCenter:
                            StrategyCenterWorkspace(state: state, scrollProxy: proxy)
                        }
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                if state.workspace == .strategyCenter {
                    Button {
                        withAnimation(.easeOut(duration: 0.2)) {
                            proxy.scrollTo(StrategyCenterAnchor.top, anchor: .top)
                        }
                    } label: {
                        Image(systemName: "arrow.up")
                            .frame(width: 40, height: 40)
                    }
                    .buttonStyle(.borderedProminent)
                    .clipShape(Circle())
                    .padding(20)
                    .help("回到策略中心顶部")
                }
            }
        }
        .background(
            LinearGradient(
                colors: [FutuTheme.canvas, FutuTheme.canvasWarm.opacity(0.62)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        )
    }

    private var detail: String {
        switch state.workspace {
        case .overview: "资金、收益、风险与数据链路集中监控"
        case .market: "市场政策、监管动态与重要事件"
        case .research: "围绕具体标的组织研究与策略筛选"
        case .trading: "OpenD 订单与成交只读监控"
        case .assets: "资金口径、持仓明细与集中度"
        case .strategyCenter: "集中查看订单状态与策略报告"
        }
    }
}

private enum StrategyCenterAnchor {
    static let top = "strategy-center-top"
    static let orders = "strategy-center-orders"
    static let reports = "strategy-center-reports"
}

private struct WorkspaceHeading: View {
    let platform: TradingPlatform
    let title: String
    let detail: String
    let status: String?

    var body: some View {
        HStack(alignment: .center, spacing: 16) {
            VStack(alignment: .leading, spacing: 3) {
                Text("\(platform.title) 量化工作台")
                    .font(FutuTheme.pageEyebrow)
                    .foregroundStyle(FutuTheme.orange)
                Text(title)
                    .font(FutuTheme.pageTitle)
                    .foregroundStyle(FutuTheme.ink)
                Text(detail)
                    .font(FutuTheme.pageSubtitle)
                    .foregroundStyle(FutuTheme.inkMuted)
                    .lineSpacing(2)
            }
            Spacer()
            if let status {
                StatusPill(text: status, color: FutuTheme.rose)
            }
        }
        .padding(.horizontal, 2)
    }
}

private struct OverviewWorkspace: View {
    @Bindable var state: AppState
    @State private var profitPeriod: ProfitPeriod = .all

    var body: some View {
        VStack(spacing: FutuTheme.sectionSpacing) {
            LazyVGrid(
                columns: Array(
                    repeating: GridItem(.flexible(minimum: 132), spacing: 10),
                    count: 4
                ),
                spacing: 10
            ) {
                MetricTile("总资产", value: money(state.currentAccount?.totalAssets), note: currency)
                MetricTile("可用现金", value: money(state.currentAccount?.cash), note: currency)
                MetricTile("购买力", value: money(state.currentAccount?.buyingPower), note: currency)
                MetricTile(
                    "持仓市值",
                    value: money(positionMarketValue),
                    note: "\(state.currentPositions.count) 项持仓"
                )
            }
            HStack(alignment: .top, spacing: FutuTheme.sectionSpacing) {
                MetricTile(
                    "今日收益",
                    value: "不可用",
                    note: state.platform == .futu
                        ? "OpenD 证券账户无日收益字段"
                        : "Longbridge 当前快照无日收益字段"
                )
                ProfitMetricTile(
                    account: state.currentAccount,
                    period: $profitPeriod
                )
            }
            HStack(alignment: .top, spacing: FutuTheme.sectionSpacing) {
                WorkbenchPanel(
                    "账户风险",
                    subtitle: "现金、集中度与数据完整性",
                    systemImage: "shield.lefthalf.filled",
                    minimumHeight: 230
                ) {
                    RiskSummary(account: state.currentAccount, positions: state.currentPositions)
                }
                WorkbenchPanel(
                    "市场与连接",
                    subtitle: "交易时段和本地数据通道",
                    systemImage: "network",
                    minimumHeight: 230
                ) {
                    KeyValueRows(rows: [
                        ("市场", state.currentMarket?.name ?? "不可用"),
                        ("市场状态", state.currentMarket?.state ?? "不可用"),
                        ("数据通道", state.currentConnectionLabel),
                        ("自动刷新", "每 30 秒")
                    ])
                }
                WorkbenchPanel(
                    "数据覆盖",
                    subtitle: "缺失能力不会用估算值替代",
                    systemImage: "checklist",
                    minimumHeight: 230
                ) {
                    DataAvailabilityRows(items: [
                        ("账户资金", state.currentAccount != nil),
                        ("持仓", !state.currentPositions.isEmpty),
                        ("实时行情", !state.currentQuotes.isEmpty),
                        ("K 线与逐笔", !state.currentMinuteBars.isEmpty || !state.currentTickerPoints.isEmpty),
                        ("订单与成交", !state.currentOpenOrders.isEmpty || !state.currentRecentDeals.isEmpty)
                    ])
                    if !state.currentBrokerDataGaps.isEmpty {
                        Text("\(state.currentBrokerDataGaps.count) 项数据受限")
                            .font(FutuTheme.metricNote)
                            .foregroundStyle(FutuTheme.rose)
                    }
                }
            }
        }
    }

    private var currency: String { state.currentAccount?.currency ?? "不可用" }
    private var positionMarketValue: Decimal? {
        let values = state.currentPositions.compactMap { position -> Decimal? in
            guard let price = position.lastPrice else { return nil }
            return price * position.quantity
        }
        return values.isEmpty ? nil : values.reduce(0, +)
    }
}

private struct MarketWorkspace: View {
    @Bindable var state: AppState

    var body: some View {
        VStack(spacing: FutuTheme.sectionSpacing) {
            MarketEventPanel(
                title: "美国宏观日历",
                subtitle: "仅保留影响科技估值的利率、通胀、就业与增长数据",
                systemImage: "building.columns",
                section: section(.usMacro),
                isRefreshing: state.isRefreshingMarketIntelligence,
                refresh: refresh
            )
            HStack(alignment: .top, spacing: FutuTheme.sectionSpacing) {
                MarketEventPanel(
                    title: "标的池事件",
                    subtitle: "财报、指引、监管、评级及关键业务变化",
                    systemImage: "calendar.badge.exclamationmark",
                    section: section(.watchlist),
                    isRefreshing: state.isRefreshingMarketIntelligence,
                    refresh: refresh
                )
                MarketEventPanel(
                    title: "突发风险",
                    subtitle: "仅保留明确传导至芯片、算力与科技供应链的风险",
                    systemImage: "exclamationmark.triangle",
                    section: section(.breakingRisk),
                    isRefreshing: state.isRefreshingMarketIntelligence,
                    refresh: refresh
                )
            }
            if let message = state.marketIntelligenceStatusMessage {
                DataUnavailableView(text: message)
            }
        }
        .task {
            if state.platform == .futu, state.marketIntelligence == nil {
                await state.refreshMarketIntelligence()
            }
        }
    }

    private func section(_ group: MarketEventGroup) -> MarketIntelligenceSection {
        state.currentMarketIntelligence?.section(group)
            ?? MarketIntelligenceSection(
                group: group,
                availability: .unavailable,
                message: "尚未刷新市场情报"
            )
    }

    private func refresh() {
        Task { await state.refreshMarketIntelligence() }
    }
}

private struct MarketEventPanel: View {
    let title: String
    let subtitle: String
    let systemImage: String
    let section: MarketIntelligenceSection
    let isRefreshing: Bool
    let refresh: () -> Void

    var body: some View {
        WorkbenchPanel(
            title,
            subtitle: subtitle,
            systemImage: systemImage,
            minimumHeight: 280,
            headerTrailing: AnyView(
                HStack(spacing: 8) {
                    StatusPill(
                        text: availabilityText,
                        color: availabilityColor
                    )
                    Button(action: refresh) {
                        Image(systemName: "arrow.clockwise")
                    }
                    .buttonStyle(.borderless)
                    .disabled(isRefreshing)
                    .help("刷新市场情报")
                }
            )
        ) {
            if section.events.isEmpty {
                DataUnavailableView(text: section.message ?? "当前时间窗口内没有事件")
            } else if filteredEvents.isEmpty {
                DataUnavailableView(text: "当前没有通过科技相关性筛选的关键事件")
            } else {
                MarketEventTable(events: filteredEvents)
                if let message = section.message {
                    Text(message)
                        .font(FutuTheme.metricNote)
                        .foregroundStyle(FutuTheme.inkMuted)
                }
            }
        }
    }

    private var filteredEvents: [MarketEvent] {
        MarketEventRelevance.displayEvents(section.events, group: section.group)
    }

    private var availabilityText: String {
        switch section.availability {
        case .available: "已接入"
        case .partial: "部分可用"
        case .unavailable: "不可用"
        case .providerUnsupported: "供应商未支持"
        }
    }

    private var availabilityColor: Color {
        switch section.availability {
        case .available: FutuTheme.loss
        case .partial: FutuTheme.amber
        case .unavailable, .providerUnsupported: FutuTheme.rose
        }
    }
}

private struct MarketEventTable: View {
    let events: [MarketEvent]
    @State private var expandedEventID: String?

    var body: some View {
        VStack(spacing: 0) {
            header
            ForEach(events) { event in
                Divider()
                eventRow(event)
                if expandedEventID == event.id {
                    eventDetail(event)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
        }
        .animation(.easeInOut(duration: 0.16), value: expandedEventID)
    }

    private var header: some View {
        HStack(spacing: 10) {
            Text("时间")
                .frame(width: 105, alignment: .leading)
            Text("级别")
                .frame(width: 46, alignment: .center)
            Text("摘要")
                .frame(maxWidth: .infinity, alignment: .leading)
            Text("科技影响")
                .frame(width: 72, alignment: .center)
            Color.clear.frame(width: 18)
        }
        .font(FutuTheme.tableHeader)
        .foregroundStyle(FutuTheme.inkMuted)
        .padding(.vertical, 7)
    }

    private func eventRow(_ event: MarketEvent) -> some View {
        let insight = MarketEventInterpreter.make(event)
        return Button {
            expandedEventID = expandedEventID == event.id ? nil : event.id
        } label: {
            HStack(alignment: .center, spacing: 10) {
                Text(displayTime(event.publishedAt))
                    .monospacedDigit()
                    .frame(width: 105, alignment: .leading)
                Text(importanceText(event.importance))
                    .foregroundStyle(importanceColor(event.importance))
                    .frame(width: 46, alignment: .center)
                VStack(alignment: .leading, spacing: 3) {
                    Text(insight.summary)
                        .font(FutuTheme.bodyStrong)
                        .foregroundStyle(FutuTheme.ink)
                        .lineLimit(2)
                    Text(summaryNote(event: event, insight: insight))
                        .font(FutuTheme.metricNote)
                        .foregroundStyle(FutuTheme.inkMuted)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Text(insight.impact.title)
                    .font(FutuTheme.metricNote.weight(.semibold))
                    .foregroundStyle(impactColor(insight.impact))
                    .frame(width: 72, alignment: .center)
                Image(systemName: expandedEventID == event.id
                    ? "chevron.up"
                    : "chevron.down")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(FutuTheme.inkMuted)
                    .frame(width: 18)
            }
            .contentShape(Rectangle())
            .padding(.vertical, 9)
        }
        .buttonStyle(.plain)
    }

    private func eventDetail(_ event: MarketEvent) -> some View {
        let insight = MarketEventInterpreter.make(event)
        return VStack(alignment: .leading, spacing: 14) {
            detailSectionTitle("数据对比", systemImage: "chart.bar.xaxis")
            HStack(alignment: .top, spacing: 0) {
                MarketDetailMetric(label: "前值", value: insight.previous)
                verticalRule
                MarketDetailMetric(label: "市场预期", value: insight.expectation)
                verticalRule
                MarketDetailMetric(label: "实际值", value: insight.actual)
                verticalRule
                MarketDetailMetric(
                    label: "预期差",
                    value: insight.surprise,
                    emphasized: insight.surprise != "待公布"
                        && insight.surprise != "缺少预期，无法比较"
                )
            }

            Divider()
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .top, spacing: 16) {
                    detailTextBlock(
                        title: "科技股影响 · \(insight.impact.title)",
                        body: "\(insight.impactScope)\n\(insight.impactReason)",
                        color: impactColor(insight.impact),
                        minimumWidth: 220
                    )
                    Divider()
                    detailTextBlock(
                        title: "风险与边界",
                        body: insight.risks.joined(separator: "\n"),
                        color: FutuTheme.amber,
                        minimumWidth: 220
                    )
                }
                VStack(alignment: .leading, spacing: 12) {
                    detailTextBlock(
                        title: "科技股影响 · \(insight.impact.title)",
                        body: "\(insight.impactScope)\n\(insight.impactReason)",
                        color: impactColor(insight.impact)
                    )
                    Divider()
                    detailTextBlock(
                        title: "风险与边界",
                        body: insight.risks.joined(separator: "\n"),
                        color: FutuTheme.amber
                    )
                }
            }

            Divider()
            detailSectionTitle("来源追溯", systemImage: "link")
            Text(sourceDetail(event))
                .font(FutuTheme.metricNote)
                .foregroundStyle(FutuTheme.inkMuted)
                .textSelection(.enabled)
            Text("原始标题：\(event.title)")
                .font(FutuTheme.metricNote)
                .foregroundStyle(FutuTheme.inkMuted)
                .textSelection(.enabled)
        }
        .padding(.horizontal, 8)
        .padding(.bottom, 14)
    }

    private var verticalRule: some View {
        Divider()
            .frame(height: 46)
            .padding(.horizontal, 10)
    }

    private func detailSectionTitle(_ title: String, systemImage: String) -> some View {
        Label(title, systemImage: systemImage)
            .font(FutuTheme.tableHeader)
            .foregroundStyle(FutuTheme.inkMuted)
    }

    private func detailTextBlock(
        title: String,
        body: String,
        color: Color,
        minimumWidth: CGFloat? = nil
    ) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title)
                .font(FutuTheme.bodyStrong)
                .foregroundStyle(color)
            Text(body)
                .font(FutuTheme.tableCell)
                .foregroundStyle(FutuTheme.ink)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(minWidth: minimumWidth, maxWidth: .infinity, alignment: .topLeading)
    }

    private func summaryNote(event: MarketEvent, insight: MarketEventInsight) -> String {
        let symbol = event.relatedSymbols.isEmpty
            ? insight.category
            : event.relatedSymbols.joined(separator: "、")
        let relevance = MarketEventRelevance.evaluate(event)
        return "\(symbol) · \(insight.surprise) · \(relevance.reason)"
    }

    private func sourceDetail(_ event: MarketEvent) -> String {
        "来源 \(event.source) · 发布 \(displayTime(event.publishedAt)) · "
            + "抓取 \(displayTime(event.fetchedAt)) · 有效至 \(displayTime(event.validUntil))"
    }

    private func displayTime(_ value: String) -> String {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = fractional.date(from: value)
                ?? ISO8601DateFormatter().date(from: value) else {
            return value
        }
        return date.formatted(
            .dateTime.month(.twoDigits).day(.twoDigits).hour().minute()
        )
    }

    private func importanceText(_ value: MarketEventImportance) -> String {
        switch value {
        case .critical: "紧急"
        case .high: "高"
        case .medium: "中"
        case .low: "低"
        }
    }

    private func importanceColor(_ value: MarketEventImportance) -> Color {
        switch value {
        case .critical: FutuTheme.rose
        case .high: FutuTheme.orange
        case .medium, .low: FutuTheme.inkMuted
        }
    }

    private func impactColor(_ value: MarketTechnologyImpact) -> Color {
        switch value {
        case .positive: FutuTheme.profit
        case .negative: FutuTheme.loss
        case .mixed, .pending: FutuTheme.amber
        case .limited: FutuTheme.inkMuted
        }
    }
}

private struct MarketDetailMetric: View {
    let label: String
    let value: String
    var emphasized = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(FutuTheme.metricNote)
                .foregroundStyle(FutuTheme.inkMuted)
            Text(value)
                .font(emphasized ? FutuTheme.bodyStrong : FutuTheme.body)
                .foregroundStyle(emphasized ? FutuTheme.orange : FutuTheme.ink)
                .lineLimit(2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ResearchWorkspace: View {
    @Bindable var state: AppState

    var body: some View {
        VStack(spacing: FutuTheme.sectionSpacing) {
            WorkbenchPanel(
                "研究标的池",
                subtitle: "套餐决定容量和替换周期，池内标的才可通过斜杠指令进入对话",
                systemImage: "square.stack.3d.up",
                minimumHeight: 230
            ) {
                HStack(alignment: .top, spacing: 28) {
                    KeyValueRows(rows: [
                        ("当前套餐", state.researchPoolEntitlement.planName ?? "权益待同步"),
                        (
                            "标的池容量",
                            "\(state.researchPool.count) / \(state.researchPoolEntitlement.poolLimit)"
                        ),
                        ("替换周期", replacementCycle),
                        ("下次可替换", replacementDate)
                    ])
                    .frame(maxWidth: 320)
                    Rectangle()
                        .fill(FutuTheme.lineSoft)
                        .frame(width: 1)
                    researchPoolContent
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                }
            }

            LazyVGrid(
                columns: [
                    GridItem(
                        .flexible(),
                        spacing: FutuTheme.sectionSpacing,
                        alignment: .topLeading
                    ),
                    GridItem(
                        .flexible(),
                        spacing: FutuTheme.sectionSpacing,
                        alignment: .topLeading
                    )
                ],
                alignment: .leading,
                spacing: FutuTheme.sectionSpacing
            ) {
                ForEach(ResearchSkill.allCases) { skill in
                    researchSkillPanel(skill)
                }
            }
        }
        .sheet(isPresented: $state.isResearchPoolManagerOpen) {
            ProviderPoolManagerView(state: state)
                .frame(minWidth: 980, minHeight: 680)
        }
    }

    @ViewBuilder
    private var researchPoolContent: some View {
        if state.researchPool.isEmpty {
            DataUnavailableView(text: "套餐权益与锁定周期尚未同步，当前不能创建或替换标的池")
        } else {
            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 170), spacing: 10)],
                spacing: 8
            ) {
                ForEach(state.researchPool) { item in
                    HStack(spacing: 10) {
                        Button {
                            state.toggleConversationResearchSymbol(item.symbol)
                        } label: {
                            Image(
                                systemName: state.conversationResearchSymbols.contains(item.symbol)
                                    ? "checkmark.square.fill"
                                    : "square"
                            )
                        }
                        .buttonStyle(.borderless)
                        .help("选择或移出当前模型对话")
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.symbol).font(FutuTheme.bodyStrong)
                            Text(item.displayName)
                                .font(FutuTheme.metricNote)
                                .foregroundStyle(FutuTheme.inkMuted)
                        }
                        Spacer()
                        Image(systemName: "lock.fill")
                            .foregroundStyle(FutuTheme.inkMuted)
                            .help("套餐替换周期内锁定")
                    }
                    .frame(minHeight: 42)
                    .padding(.horizontal, 10)
                    .background(FutuTheme.surfaceMuted)
                    .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                }
            }
        }
        Button {
            state.isResearchPoolManagerOpen = true
        } label: {
            Label("管理标的池", systemImage: "plus")
        }
        .buttonStyle(.bordered)
        .disabled(state.providerPoolSummaries.isEmpty)
        .help("从已绑定的 Futu 或 Longbridge 搜索并管理标的")
    }

    private func researchSkillPanel(_ skill: ResearchSkill) -> some View {
        WorkbenchPanel(
            skill.title,
            subtitle: skill == .sellPut && state.platform == .longbridge
                ? "基于当日全球市值 Top30、Longbridge 行情与期权快照评估现金担保卖 Put"
                : skill.detail,
            systemImage: skill.systemImage,
            minimumHeight: 490
        ) {
            HStack {
                Text("对话调用")
                    .font(FutuTheme.metricLabel)
                    .foregroundStyle(FutuTheme.inkMuted)
                Spacer()
                StatusPill(
                    text: "@\(skill.title)",
                    color: FutuTheme.orange
                )
            }
            HStack {
                Text("研究模型")
                    .font(FutuTheme.metricLabel)
                    .foregroundStyle(FutuTheme.inkMuted)
                Spacer()
                Picker(
                    "研究模型",
                    selection: Binding(
                        get: { state.researchModel(for: skill) },
                        set: { state.setResearchModel($0, for: skill) }
                    )
                ) {
                    ForEach(ResearchModelProfile.allCases) { profile in
                        Text(profile.title).tag(profile)
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
            }
            Text(state.researchModel(for: skill).detail)
                .font(FutuTheme.metricNote)
                .foregroundStyle(FutuTheme.inkMuted)
                .lineSpacing(2)
            DashedDivider()
            HStack {
                Text("提示词策略")
                    .font(FutuTheme.metricLabel)
                    .foregroundStyle(FutuTheme.inkMuted)
                Spacer()
                Text(skill.promptVersion)
                    .font(FutuTheme.metricNote)
                    .foregroundStyle(FutuTheme.inkMuted)
            }
            ChecklistRows(items: skill.sections)
            DashedDivider()
            Text("强制输出：证据、反证、风险、数据缺口、退出条件")
                .font(FutuTheme.body)
                .foregroundStyle(FutuTheme.inkMuted)
                .lineSpacing(2)
            Text(
                skill == .sellPut
                    ? "单个标的期权链、希腊值或流动性数据缺失时，仅跳过该候选，不阻断整份报告"
                    : "量价或事件数据不完整时明确列出缺口，不使用估算值替代"
            )
            .font(FutuTheme.metricNote)
            .foregroundStyle(skill == .sellPut ? FutuTheme.rose : FutuTheme.inkMuted)
            .lineSpacing(2)
            .frame(minHeight: 34, alignment: .topLeading)
            if skill == .sellPut {
                Button {
                    Task {
                        if await state.startSellPutReport() {
                            state.workspace = .strategyCenter
                        }
                    }
                } label: {
                    Label(
                        state.isSellPutRunning ? "正在生成报告" : "执行 SELL PUT 研究",
                        systemImage: state.isSellPutRunning
                            ? "clock.arrow.circlepath"
                            : "play.fill"
                    )
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(!state.canStartSellPutReport)

                if state.isSellPutRunning {
                    ProgressView(
                        value: Double(state.sellPutCompletedSymbols),
                        total: Double(max(state.sellPutTotalSymbols, 1))
                    )
                }
                Text(
                    state.sellPutAccessMessage
                        ?? state.sellPutStatusMessage
                        ?? "执行前自动同步当日全球市值 Top30 美股专属标的池"
                )
                .font(FutuTheme.metricNote)
                .foregroundStyle(FutuTheme.inkMuted)
                .lineLimit(2)
                .frame(minHeight: 34, alignment: .topLeading)
            }
        }
    }

    private var replacementCycle: String {
        state.researchPoolEntitlement.replacementIntervalDays
            .map { "\($0) 天" } ?? "待同步"
    }

    private var replacementDate: String {
        state.researchPoolEntitlement.nextReplacementAt?
            .formatted(date: .abbreviated, time: .omitted) ?? "待同步"
    }

}

private struct TradingWorkspace: View {
    @Bindable var state: AppState
    @State private var isEvaluationDetailsPresented = false

    var body: some View {
        VStack(spacing: FutuTheme.sectionSpacing) {
            HStack(spacing: 10) {
                StatusPill(text: "影子模式", color: FutuTheme.orange)
                StatusPill(text: "真实下单关闭", color: FutuTheme.rose)
                StatusPill(text: state.currentConnectionLabel, color: connectionColor)
                StatusPill(
                    text: state.currentTradingConfiguration.map { "配置 v\($0.version)" } ?? "未配置",
                    color: state.currentTradingConfiguration == nil
                        ? FutuTheme.inkMuted
                        : FutuTheme.loss
                )
                Spacer()
                Button {
                    isEvaluationDetailsPresented = true
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: evaluationErrorCount > 0
                            ? "exclamationmark.triangle"
                            : (state.isShadowTradingRunning ? "waveform.path.ecg" : "pause.circle"))
                            .foregroundStyle(evaluationStatusColor)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(evaluationTitle)
                                .font(FutuTheme.metricNote.weight(.semibold))
                                .foregroundStyle(FutuTheme.ink)
                            Text(
                                "可评估 \(evaluationActiveCount) · 等待 \(evaluationWaitingCount)"
                                    + (evaluationErrorCount > 0 ? " · 异常 \(evaluationErrorCount)" : "")
                                    + " · 共 \(state.shadowEvaluationItems.count)"
                            )
                            .font(FutuTheme.metricNote)
                            .foregroundStyle(FutuTheme.inkMuted)
                        }
                        Image(systemName: "info.circle")
                            .foregroundStyle(FutuTheme.inkMuted)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("查看量化评估详情")
                Button {
                    Task { await state.runShadowTradingOnce() }
                } label: {
                    Label("运行一次", systemImage: "play")
                }
                .buttonStyle(.borderless)
                .disabled(
                    state.currentTradingConfiguration == nil
                        || state.isShadowEvaluationInFlight
                )
                Button {
                    if state.isShadowTradingRunning {
                        state.stopShadowTrading()
                    } else {
                        Task { await state.enableShadowTrading() }
                    }
                } label: {
                    Label(
                        state.isShadowTradingRunning
                            ? "停止"
                            : (state.currentTradingConfiguration == nil
                                ? "启用量化评估"
                                : "启动"),
                        systemImage: state.isShadowTradingRunning ? "stop.fill" : "play.fill"
                    )
                }
                .buttonStyle(.borderless)
                .disabled(
                    !state.isShadowTradingRunning
                        && (
                            state.currentTradingCatalog == nil
                                || !state.isCurrentBrokerConnected
                        )
                )
            }
            HStack(alignment: .top, spacing: FutuTheme.sectionSpacing) {
                WorkbenchPanel(
                    "影子信号",
                    subtitle: "服务端权威配置生成的最近信号",
                    systemImage: "waveform.path.ecg",
                    minimumHeight: 250
                ) {
                    shadowSignalRows
                }
                WorkbenchPanel(
                    "候选池",
                    subtitle: "候选状态、方向与组合排序",
                    systemImage: "list.number",
                    minimumHeight: 250
                ) {
                    candidateRows
                }
            }
            WorkbenchPanel(
                "模型运行",
                subtitle: "单票、组合与挂单监管运行审计",
                systemImage: "cpu"
            ) {
                VStack(spacing: 12) {
                    modelRunRows
                    modelRunPager
                }
            }
        }
        .sheet(isPresented: $isEvaluationDetailsPresented) {
            QuantEvaluationDetailsSheet(state: state)
        }
    }

    private var evaluationActiveCount: Int {
        state.shadowEvaluationItems.filter { $0.state == .active }.count
    }

    private var evaluationWaitingCount: Int {
        state.shadowEvaluationItems.filter { $0.state == .waiting }.count
    }

    private var evaluationErrorCount: Int {
        state.shadowEvaluationItems.filter { $0.state == .error }.count
    }

    private var evaluationTitle: String {
        if evaluationErrorCount > 0 {
            return state.isShadowTradingRunning ? "部分标的待重试" : "部分标的评估未完成"
        }
        if state.isShadowTradingRunning {
            return evaluationActiveCount > 0 ? "量化评估运行中" : "量化评估运行中，等待条件"
        }
        return state.shadowLastRunAt == nil ? "量化评估已停止" : state.shadowRuntimeStatus
    }

    private var evaluationStatusColor: Color {
        if evaluationErrorCount > 0 { return FutuTheme.loss }
        if state.isShadowTradingRunning { return FutuTheme.profit }
        return FutuTheme.inkMuted
    }

    private var modelRunPager: some View {
        HStack(spacing: 10) {
            Text("共 \(state.shadowModelRunTotal) 条")
                .font(FutuTheme.metricNote)
                .foregroundStyle(FutuTheme.inkMuted)
            Spacer()
            Button {
                Task { await state.showPreviousModelRunPage() }
            } label: {
                Image(systemName: "chevron.left")
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(.borderless)
            .disabled(state.shadowModelRunPage <= 1)
            .help("上一页")
            Text("\(state.shadowModelRunPage) / \(state.shadowModelRunPageCount)")
                .font(FutuTheme.metricNote)
                .foregroundStyle(FutuTheme.ink)
                .monospacedDigit()
                .frame(minWidth: 52)
            Button {
                Task { await state.showNextModelRunPage() }
            } label: {
                Image(systemName: "chevron.right")
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(.borderless)
            .disabled(state.shadowModelRunPage >= state.shadowModelRunPageCount)
            .help("下一页")
        }
        .frame(minHeight: 32)
    }

    @ViewBuilder
    private var shadowSignalRows: some View {
        if state.shadowSignals.isEmpty {
            Text("暂无影子信号")
                .font(FutuTheme.metricNote)
                .foregroundStyle(FutuTheme.inkMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            VStack(spacing: 0) {
                shadowSignalRow(
                    symbol: "标的",
                    action: "方向",
                    confidence: "模型置信度",
                    createdAt: "生成时间",
                    validity: "数据时效",
                    header: true
                )
                ForEach(Array(state.shadowSignals.prefix(8).enumerated()), id: \.element.id) {
                    index,
                    signal in
                    if index > 0 {
                        DashedDivider()
                    }
                    shadowSignalRow(
                        symbol: signal.symbol,
                        action: shadowActionLabel(signal.evidenceSummary.intent ?? signal.action),
                        confidence: shadowConfidenceLabel(signal),
                        createdAt: shadowTimeLabel(signal.createdAt),
                        validity: shadowValidityLabel(signal),
                        header: false
                    )
                }
            }
        }
    }

    private func shadowSignalRow(
        symbol: String,
        action: String,
        confidence: String,
        createdAt: String,
        validity: String,
        header: Bool
    ) -> some View {
        HStack(spacing: 8) {
            fixedCell(symbol, width: nil, alignment: .leading, header: header)
            fixedCell(action, width: 58, alignment: .center, header: header)
                .foregroundStyle(header ? FutuTheme.inkMuted : shadowActionColor(action))
            fixedCell(confidence, width: 92, alignment: .trailing, header: header)
                .help(header ? "模型对当前方向判断的置信度，不是上涨概率或收益率" : "")
            fixedCell(createdAt, width: 72, alignment: .trailing, header: header)
            fixedCell(validity, width: 112, alignment: .trailing, header: header)
                .foregroundStyle(header ? FutuTheme.inkMuted : FutuTheme.inkMuted)
        }
        .frame(minHeight: header ? 30 : 38)
    }

    private func shadowActionLabel(_ action: String) -> String {
        switch action {
        case "BUY": "买入"
        case "BUY_TO_COVER": "买入平空"
        case "SELL", "SELL_TO_CLOSE": "平仓卖出"
        case "SELL_SHORT": "卖空"
        case "HOLD": "观望"
        default: action
        }
    }

    private func shadowActionColor(_ action: String) -> Color {
        switch action {
        case "买入", "买入平空": FutuTheme.profit
        case "平仓卖出", "卖空": FutuTheme.loss
        default: FutuTheme.inkMuted
        }
    }

    private func shadowConfidenceLabel(_ signal: TradingSignal) -> String {
        guard let confidence = signal.evidenceSummary.confidence,
              confidence > 0 else {
            return "未提供"
        }
        return String(format: "%.0f%%", confidence * 100)
    }

    private func shadowTimeLabel(_ value: String) -> String {
        guard let date = shadowSignalDate(value) else { return "不可用" }
        return date.formatted(date: .omitted, time: .shortened)
    }

    private func shadowValidityLabel(_ signal: TradingSignal) -> String {
        guard let value = signal.evidenceSummary.sourceValidUntil,
              let validUntil = shadowSignalDate(value) else {
            return "未标注"
        }
        let time = validUntil.formatted(date: .omitted, time: .shortened)
        return validUntil > Date() ? "有效至 \(time)" : "已于 \(time) 过期"
    }

    private func shadowSignalDate(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }

    @ViewBuilder
    private var candidateRows: some View {
        if state.currentTradingConfiguration?.executionMode == "DIRECT" {
            Text("直推模式不使用候选池")
                .font(FutuTheme.metricNote)
                .foregroundStyle(FutuTheme.inkMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else if state.shadowCandidates.isEmpty {
            Text("暂无候选")
                .font(FutuTheme.metricNote)
                .foregroundStyle(FutuTheme.inkMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            VStack(spacing: 0) {
                candidateRow(
                    symbol: "标的",
                    side: "方向",
                    rank: "排序",
                    status: "状态",
                    createdAt: "生成时间",
                    validity: "数据时效",
                    header: true
                )
                ForEach(Array(state.shadowCandidates.prefix(8).enumerated()), id: \.element.id) {
                    index,
                    candidate in
                    if index > 0 {
                        DashedDivider()
                    }
                    candidateRow(
                        symbol: candidate.symbol,
                        side: shadowActionLabel(candidate.side),
                        rank: candidate.rank.map { "#\($0)" } ?? "—",
                        status: candidateStatusLabel(candidate),
                        createdAt: shadowTimeLabel(candidate.createdAt),
                        validity: candidateValidityLabel(candidate),
                        header: false
                    )
                }
            }
        }
    }

    private func candidateRow(
        symbol: String,
        side: String,
        rank: String,
        status: String,
        createdAt: String,
        validity: String,
        header: Bool
    ) -> some View {
        HStack(spacing: 8) {
            fixedCell(symbol, width: nil, alignment: .leading, header: header)
            fixedCell(side, width: 58, alignment: .center, header: header)
                .foregroundStyle(header ? FutuTheme.inkMuted : shadowActionColor(side))
            fixedCell(rank, width: 44, alignment: .trailing, header: header)
            fixedCell(status, width: 58, alignment: .center, header: header)
                .foregroundStyle(header ? FutuTheme.inkMuted : candidateColor(status))
            fixedCell(createdAt, width: 72, alignment: .trailing, header: header)
            fixedCell(validity, width: 112, alignment: .trailing, header: header)
                .foregroundStyle(FutuTheme.inkMuted)
        }
        .frame(minHeight: header ? 30 : 38)
    }

    private func candidateStatusLabel(_ candidate: TradingCandidate) -> String {
        if shadowSignalDate(candidate.expiresAt).map({ $0 <= Date() }) == true {
            return "已过期"
        }
        return switch candidate.status {
        case "PROMOTED": "已晋级"
        case "PENDING": "待处理"
        case "WATCH": "观察"
        case "REJECTED": "已拒绝"
        case "EXPIRED": "已过期"
        default: candidate.status
        }
    }

    private func candidateValidityLabel(_ candidate: TradingCandidate) -> String {
        guard let expiresAt = shadowSignalDate(candidate.expiresAt) else { return "未标注" }
        let time = expiresAt.formatted(date: .omitted, time: .shortened)
        return expiresAt > Date() ? "有效至 \(time)" : "已于 \(time) 过期"
    }

    @ViewBuilder
    private var modelRunRows: some View {
        if state.shadowModelRuns.isEmpty {
            Text("暂无运行记录")
                .font(FutuTheme.metricNote)
                .foregroundStyle(FutuTheme.inkMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            VStack(spacing: 0) {
                let runs = Array(state.shadowModelRuns.prefix(10))
                ForEach(Array(runs.enumerated()), id: \.element.id) { index, run in
                    ModelRunAuditRow(run: run, initiallyExpanded: index == 0)
                    if index < runs.count - 1 {
                        Divider().overlay(FutuTheme.lineSoft)
                    }
                }
            }
        }
    }

    private func candidateColor(_ status: String) -> Color {
        switch status {
        case "已晋级": FutuTheme.loss
        case "待处理", "观察": FutuTheme.orange
        default: FutuTheme.inkMuted
        }
    }

    private var connectionColor: Color {
        state.isCurrentBrokerConnected ? FutuTheme.loss : FutuTheme.rose
    }
}

private struct QuantEvaluationDetailsSheet: View {
    @Bindable var state: AppState
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("量化评估状态")
                        .font(FutuTheme.pageEyebrow)
                        .foregroundStyle(FutuTheme.orange)
                    Text("策略与标的详情")
                        .font(FutuTheme.pageTitle)
                        .foregroundStyle(FutuTheme.ink)
                    Text(summary)
                        .font(FutuTheme.body)
                        .foregroundStyle(FutuTheme.inkMuted)
                }
                Spacer()
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark")
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.borderless)
                .help("关闭")
            }

            HStack(spacing: 24) {
                detailValue(
                    title: "当前策略版本",
                    value: state.currentTradingCatalog?.strategies.first {
                        $0.id == state.currentTradingConfiguration?.strategyId
                    }.map { "\($0.name) \($0.version)" } ?? "未加载"
                )
                detailValue(
                    title: "当前提示词版本",
                    value: state.currentTradingCatalog?.prompts.first {
                        $0.id == state.currentTradingConfiguration?.singlePromptId
                    }.map { "\($0.name) \($0.version)" } ?? "未加载"
                )
                detailValue(
                    title: "执行模式",
                    value: state.currentTradingConfiguration?.executionMode == "CANDIDATE_POOL"
                        ? "候选池组合裁决"
                        : "大模型直推"
                )
            }

            HStack {
                Text("全部标的状态")
                    .font(FutuTheme.panelTitle)
                    .foregroundStyle(FutuTheme.ink)
                Spacer()
                Text("更新时间：\(updatedAt)")
                    .font(FutuTheme.metricNote)
                    .foregroundStyle(FutuTheme.inkMuted)
            }

            VStack(spacing: 0) {
                evaluationRow(
                    symbol: "标的",
                    market: "市场",
                    marketState: "当前状态",
                    status: "评估状态",
                    reason: "评估说明",
                    header: true,
                    index: 0
                )
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(Array(state.shadowEvaluationItems.enumerated()), id: \.element.id) {
                            index,
                            item in
                            evaluationRow(
                                symbol: item.symbol,
                                market: item.market,
                                marketState: item.marketState,
                                status: statusLabel(item.state),
                                reason: item.reason,
                                header: false,
                                index: index
                            )
                        }
                    }
                }
            }
            .overlay {
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .stroke(FutuTheme.lineSoft, lineWidth: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
        }
        .padding(24)
        .frame(minWidth: 860, minHeight: 560)
        .background(FutuTheme.canvas)
    }

    private var summary: String {
        let items = state.shadowEvaluationItems
        let active = items.filter { $0.state == .active }.count
        let waiting = items.filter { $0.state == .waiting }.count
        let errors = items.filter { $0.state == .error }.count
        return "当前股票池共 \(items.count) 个标的，可评估 \(active) 个，等待 \(waiting) 个"
            + (errors > 0 ? "，异常 \(errors) 个；定时运行会在后续轮次重试。" : "。")
    }

    private var updatedAt: String {
        state.shadowEvaluationUpdatedAt?
            .formatted(date: .numeric, time: .standard) ?? "尚未运行"
    }

    private func detailValue(title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(FutuTheme.tableHeader)
                .foregroundStyle(FutuTheme.inkMuted)
            Text(value)
                .font(FutuTheme.bodyStrong)
                .foregroundStyle(FutuTheme.ink)
                .lineLimit(2)
        }
        .frame(maxWidth: .infinity, minHeight: 54, alignment: .leading)
    }

    private func evaluationRow(
        symbol: String,
        market: String,
        marketState: String,
        status: String,
        reason: String,
        header: Bool,
        index: Int
    ) -> some View {
        HStack(spacing: 12) {
            fixedCell(symbol, width: 140, alignment: .leading, header: header)
            fixedCell(market, width: 76, alignment: .leading, header: header)
            fixedCell(marketState, width: 110, alignment: .leading, header: header)
            fixedCell(status, width: 92, alignment: .leading, header: header)
                .foregroundStyle(header ? FutuTheme.inkMuted : statusColor(status))
            fixedCell(reason, width: nil, alignment: .leading, header: header, lines: 2)
        }
        .padding(.horizontal, 14)
        .frame(minHeight: header ? 36 : 48)
        .background(header ? FutuTheme.surfaceMuted : (index.isMultiple(of: 2)
            ? FutuTheme.surface
            : FutuTheme.surfaceMuted.opacity(0.55)))
    }

    private func statusLabel(_ state: ShadowEvaluationItemState) -> String {
        switch state {
        case .active: "可评估"
        case .waiting: "暂不评估"
        case .error: "待重试"
        }
    }

    private func statusColor(_ status: String) -> Color {
        switch status {
        case "可评估": FutuTheme.profit
        case "待重试": FutuTheme.rose
        default: FutuTheme.amber
        }
    }
}

private struct ModelRunAuditRow: View {
    let run: ModelRunSummary
    @State private var isExpanded: Bool

    init(run: ModelRunSummary, initiallyExpanded: Bool) {
        self.run = run
        _isExpanded = State(initialValue: initiallyExpanded)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 10) {
                Text(symbolLabel)
                    .font(FutuTheme.metricValue)
                    .foregroundStyle(FutuTheme.ink)
                VStack(alignment: .leading, spacing: 2) {
                    Text(purposeLabel)
                        .font(FutuTheme.metricLabel)
                        .foregroundStyle(FutuTheme.inkMuted)
                    Text(run.model)
                        .font(FutuTheme.metricNote)
                        .foregroundStyle(FutuTheme.inkMuted)
                }
                Spacer()
                StatusPill(
                    text: resultLabel,
                    color: run.result?.signal?.action == "HOLD"
                        ? FutuTheme.orange
                        : FutuTheme.loss
                )
                StatusPill(
                    text: statusLabel,
                    color: run.status == "COMPLETED"
                        ? FutuTheme.loss
                        : FutuTheme.rose
                )
            }
            HStack(spacing: 18) {
                modelRunTimeItem(title: "开始时间", value: runTimeLabel(run.startedAt))
                modelRunTimeItem(
                    title: "结束时间",
                    value: run.finishedAt.map(runTimeLabel) ?? "运行中"
                )
                Spacer(minLength: 0)
            }

            if let result = run.result {
                auditConclusion(result.summary)
                DisclosureGroup(isExpanded: $isExpanded) {
                    VStack(alignment: .leading, spacing: 10) {
                        LazyVGrid(
                            columns: [
                                GridItem(.flexible(), spacing: 12, alignment: .top),
                                GridItem(.flexible(), spacing: 12, alignment: .top)
                            ],
                            alignment: .leading,
                            spacing: 10
                        ) {
                            ModelRunAuditModule(
                                title: hasFallbackEvidence ? "证据校验" : "支持证据",
                                systemImage: hasFallbackEvidence
                                    ? "exclamationmark.shield"
                                    : "checkmark.seal",
                                color: hasFallbackEvidence ? FutuTheme.amber : FutuTheme.loss,
                                items: result.evidence.map {
                                    "\($0.kind) · \($0.summary)"
                                },
                                emptyText: "未记录结构化支持证据"
                            )
                            ModelRunAuditModule(
                                title: "关键反证",
                                systemImage: "arrow.left.arrow.right",
                                color: FutuTheme.inkMuted,
                                items: result.counterEvidence.map {
                                    "\($0.kind) · \($0.summary)"
                                },
                                emptyText: "模型未列出关键反证"
                            )
                            ModelRunAuditModule(
                                title: "风险约束",
                                systemImage: "shield.lefthalf.filled",
                                color: FutuTheme.rose,
                                items: result.risks,
                                emptyText: "未记录额外风险"
                            )
                            ModelRunAuditModule(
                                title: "数据缺口",
                                systemImage: "externaldrive.badge.questionmark",
                                color: FutuTheme.orange,
                                items: result.dataGaps,
                                emptyText: "本轮未报告数据缺口"
                            )
                        }
                        if let exitCondition = result.exitCondition,
                           !exitCondition.isEmpty {
                            ModelRunAuditModule(
                                title: "退出与重评条件",
                                systemImage: "arrow.triangle.2.circlepath",
                                color: FutuTheme.amber,
                                items: [exitCondition],
                                emptyText: ""
                            )
                        }
                    }
                    .padding(.top, 8)
                } label: {
                    HStack(spacing: 14) {
                        Label("分析详情", systemImage: "doc.text.magnifyingglass")
                            .font(FutuTheme.metricLabel)
                        Spacer()
                        auditCount("证据", result.evidence.count)
                        auditCount("反证", result.counterEvidence.count)
                        auditCount("风险", result.risks.count)
                        auditCount("缺口", result.dataGaps.count)
                    }
                    .foregroundStyle(FutuTheme.inkMuted)
                }
                .tint(FutuTheme.orange)
            } else if let errorCode = run.errorCode {
                ModelRunAuditModule(
                    title: "运行错误",
                    systemImage: "exclamationmark.triangle",
                    color: FutuTheme.rose,
                    items: [errorCode],
                    emptyText: ""
                )
            }
        }
        .padding(.vertical, 14)
    }

    private func modelRunTimeItem(title: String, value: String) -> some View {
        HStack(spacing: 6) {
            Text(title)
                .foregroundStyle(FutuTheme.inkMuted)
            Text(value)
                .foregroundStyle(FutuTheme.ink)
                .monospacedDigit()
        }
        .font(FutuTheme.metricNote)
    }

    private func runTimeLabel(_ value: String) -> String {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = fractional.date(from: value)
                ?? ISO8601DateFormatter().date(from: value) else {
            return value
        }
        return date.formatted(date: .abbreviated, time: .standard)
    }

    private var resultLabel: String {
        if let signal = run.result?.signal {
            return tradeActionLabel(signal.intent ?? signal.action)
        }
        switch run.result?.responseType {
        case "RESEARCH": return "研究完成"
        case "CANDIDATE": return "组合评估"
        case "ORDER_DRAFT": return "订单草案"
        case "ERROR": return "运行错误"
        default: return run.errorCode ?? "无交易动作"
        }
    }

    private var statusLabel: String {
        switch run.status {
        case "COMPLETED": return "已完成"
        case "RUNNING": return "运行中"
        case "INTERRUPTED": return "已中断"
        case "REJECTED": return "已拒绝"
        default: return run.status
        }
    }

    private var purposeLabel: String {
        switch run.purpose {
        case "SINGLE_DECISION": return "单标的评估"
        case "PORTFOLIO_REVIEW": return "组合评估"
        case "MANAGED_ORDER_REVIEW": return "挂单复核"
        default: return run.purpose
        }
    }

    private func tradeActionLabel(_ action: String) -> String {
        switch action {
        case "BUY": return "买入"
        case "BUY_TO_COVER": return "买入平空"
        case "SELL", "SELL_TO_CLOSE": return "平仓卖出"
        case "SELL_SHORT": return "卖空"
        case "HOLD": return "观望"
        default: return action
        }
    }

    private var symbolLabel: String {
        let symbols = run.requestedSymbols ?? []
        if !symbols.isEmpty {
            return symbols.joined(separator: "、")
        }
        return run.result?.signal?.symbol ?? "标的未记录"
    }

    private var hasFallbackEvidence: Bool {
        run.result?.evidence.contains { $0.id == "model-output-incomplete" } == true
    }

    private func auditConclusion(_ summary: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "scope")
                .foregroundStyle(FutuTheme.orange)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 3) {
                Text("本轮结论")
                    .font(FutuTheme.metricLabel)
                    .foregroundStyle(FutuTheme.inkMuted)
                Text(summary)
                    .font(FutuTheme.bodyStrong)
                    .foregroundStyle(FutuTheme.ink)
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 12)
        .background(FutuTheme.orangeSoft.opacity(0.42))
    }

    private func auditCount(_ label: String, _ count: Int) -> some View {
        Text("\(label) \(count)")
            .font(FutuTheme.metricNote)
            .monospacedDigit()
    }
}

private struct ModelRunAuditModule: View {
    let title: String
    let systemImage: String
    let color: Color
    let items: [String]
    let emptyText: String

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Label(title, systemImage: systemImage)
                .font(FutuTheme.metricLabel)
                .foregroundStyle(color)
            if items.isEmpty {
                Text(emptyText)
                    .font(FutuTheme.metricNote)
                    .foregroundStyle(FutuTheme.inkMuted)
            } else {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .top, spacing: 7) {
                        Circle()
                            .fill(color.opacity(0.8))
                            .frame(width: 4, height: 4)
                            .padding(.top, 6)
                        Text(item)
                            .font(FutuTheme.metricNote)
                            .foregroundStyle(FutuTheme.ink)
                            .lineSpacing(2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .padding(.vertical, 9)
        .padding(.horizontal, 11)
        .background(FutuTheme.surfaceMuted.opacity(0.72))
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(color.opacity(0.72))
                .frame(width: 3)
        }
    }
}

private struct AssetsWorkspace: View {
    @Bindable var state: AppState
    @State private var hideAmounts = false
    @State private var collapsedGroups: Set<String> = []

    var body: some View {
        let groupIds = Set(positionGroups(state.currentPositions).map(\.id))
        let allCollapsed = !groupIds.isEmpty && groupIds.isSubset(of: collapsedGroups)
        VStack(spacing: FutuTheme.sectionSpacing) {
            HStack(alignment: .top, spacing: FutuTheme.sectionSpacing) {
                WorkbenchPanel(
                    "资金账户",
                    subtitle: "\(state.platform.title) 资金口径",
                    systemImage: "banknote",
                    minimumHeight: 250,
                    headerTrailing: AnyView(
                        Button {
                            hideAmounts.toggle()
                        } label: {
                            Image(systemName: hideAmounts ? "eye.slash" : "eye")
                        }
                        .buttonStyle(.borderless)
                        .help(hideAmounts ? "显示资产数字" : "隐藏资产数字")
                    )
                ) {
                    KeyValueRows(rows: [
                        ("账户", sensitive(state.currentAccount?.accountId ?? "不可用")),
                        ("环境", state.currentAccount?.environment ?? "不可用"),
                        ("币种", state.currentAccount?.currency ?? "不可用"),
                        ("总资产", sensitive(money(state.currentAccount?.totalAssets))),
                        ("现金", sensitive(money(state.currentAccount?.cash))),
                        ("购买力", sensitive(money(state.currentAccount?.buyingPower)))
                    ])
                }
                WorkbenchPanel(
                    "资产集中度",
                    subtitle: "按持仓市值观察风险",
                    systemImage: "chart.pie",
                    minimumHeight: 250
                ) {
                    RiskSummary(
                        account: state.currentAccount,
                        positions: state.currentPositions,
                        hideAmounts: hideAmounts
                    )
                }
            }
            WorkbenchPanel(
                "持仓明细",
                subtitle: "按标的归组，期权归入对应正股",
                systemImage: "tablecells",
                headerTrailing: AnyView(
                    Button {
                        collapsedGroups = allCollapsed ? [] : groupIds
                    } label: {
                        Label(
                            allCollapsed ? "全部展开" : "全部收起",
                            systemImage: allCollapsed
                                ? "rectangle.expand.vertical"
                                : "rectangle.compress.vertical"
                        )
                    }
                    .buttonStyle(.borderless)
                    .disabled(groupIds.isEmpty)
                    .help(allCollapsed ? "展开全部持仓组" : "收起全部持仓组")
                )
            ) {
                GroupedPositionTable(
                    positions: state.currentPositions,
                    quotes: state.currentQuotes,
                    hideAmounts: hideAmounts,
                    collapsedGroups: $collapsedGroups
                )
            }
        }
    }

    private func sensitive(_ value: String) -> String {
        hideAmounts && value != "不可用" ? "••••" : value
    }
}

private enum StrategyOrderSection: String, CaseIterable, Identifiable {
    case openOrders
    case todayDeals
    case historicalOrders
    case historicalDeals

    var id: String { rawValue }

    var title: String {
        switch self {
        case .openOrders: "当前委托"
        case .todayDeals: "今日成交"
        case .historicalOrders: "历史委托"
        case .historicalDeals: "历史成交"
        }
    }
}

private struct StrategyCenterWorkspace: View {
    @Bindable var state: AppState
    let scrollProxy: ScrollViewProxy
    @State private var orderSection: StrategyOrderSection = .openOrders
    @State private var reportScope = "全部报告"

    var body: some View {
        VStack(spacing: FutuTheme.sectionSpacing) {
            HStack(spacing: 8) {
                navigationButton("订单", systemImage: "doc.plaintext", anchor: StrategyCenterAnchor.orders)
                navigationButton("报告", systemImage: "doc.text.magnifyingglass", anchor: StrategyCenterAnchor.reports)
                Spacer()
                Text("最近刷新 \(state.currentBrokerLastUpdatedAt?.formatted(date: .omitted, time: .shortened) ?? "尚未刷新")")
                    .font(FutuTheme.metricNote)
                    .foregroundStyle(FutuTheme.inkMuted)
            }

            WorkbenchPanel(
                "订单",
                subtitle: "当前与历史委托、成交集中查看",
                systemImage: "doc.plaintext"
            ) {
                Picker("订单范围", selection: $orderSection) {
                    ForEach(StrategyOrderSection.allCases) { section in
                        Text(section.title).tag(section)
                    }
                }
                .labelsHidden()
                .pickerStyle(.segmented)

                switch orderSection {
                case .openOrders:
                    OrderTable(orders: state.currentOpenOrders)
                case .todayDeals:
                    FillTable(fills: state.currentRecentDeals)
                case .historicalOrders:
                    OrderTable(orders: state.currentHistoricalOrders)
                case .historicalDeals:
                    FillTable(fills: state.currentHistoricalDeals)
                }
            }
            .id(StrategyCenterAnchor.orders)

            WorkbenchPanel(
                "报告",
                subtitle: "研究结论、策略复盘与审计结果",
                systemImage: "doc.text.magnifyingglass",
                minimumHeight: 250,
                headerTrailing: AnyView(
                    Picker("报告范围", selection: $reportScope) {
                        Text("全部报告").tag("全部报告")
                        Text("量化研究").tag("量化研究")
                        Text("SELL PUT 期权研究").tag("SELL PUT 期权研究")
                    }
                    .labelsHidden()
                    .frame(width: 190)
                )
            ) {
                if reportScope == "全部报告" || reportScope == "SELL PUT 期权研究" {
                    SellPutReportModule(state: state)
                } else {
                    DataUnavailableView(text: "\(reportScope)暂无已生成内容")
                }
            }
            .id(StrategyCenterAnchor.reports)
        }
        .task(id: state.currentProviderId) {
            await state.refreshSellPutResearch()
        }
    }

    private func navigationButton(
        _ title: String,
        systemImage: String,
        anchor: String
    ) -> some View {
        Button {
            withAnimation(.easeOut(duration: 0.2)) {
                scrollProxy.scrollTo(anchor, anchor: .top)
            }
        } label: {
            Label(title, systemImage: systemImage)
        }
        .buttonStyle(.bordered)
    }
}

private struct MetricTile: View {
    let title: String
    let value: String
    let note: String

    init(_ title: String, value: String, note: String) {
        self.title = title
        self.value = value
        self.note = note
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title)
                .font(FutuTheme.metricLabel)
                .foregroundStyle(FutuTheme.inkMuted)
            Text(value)
                .font(FutuTheme.metricValue)
                .foregroundStyle(FutuTheme.ink)
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.72)
            Text(note)
                .font(FutuTheme.metricNote)
                .foregroundStyle(FutuTheme.inkMuted)
        }
        .frame(maxWidth: .infinity, minHeight: 78, alignment: .leading)
        .padding(FutuTheme.panelPadding)
        .background(FutuTheme.surface)
        .overlay {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(FutuTheme.line, lineWidth: 1)
        }
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

private enum ProfitPeriod: String, CaseIterable, Identifiable {
    case today
    case sevenDays
    case thirtyDays
    case year
    case all

    var id: String { rawValue }

    var title: String {
        switch self {
        case .today: "今日"
        case .sevenDays: "近 7 日"
        case .thirtyDays: "近 30 日"
        case .year: "今年"
        case .all: "全部"
        }
    }
}

private struct ProfitMetricTile: View {
    let account: AccountSummary?
    @Binding var period: ProfitPeriod

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                Text("总收益")
                    .font(FutuTheme.metricLabel)
                    .foregroundStyle(FutuTheme.inkMuted)
                Spacer()
                Picker("收益区间", selection: $period) {
                    ForEach(ProfitPeriod.allCases) { item in
                        Text(item.title).tag(item)
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .controlSize(.small)
            }
            Text(value)
                .font(FutuTheme.metricValue)
                .foregroundStyle(valueColor)
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.72)
            Text(note)
                .font(FutuTheme.metricNote)
                .foregroundStyle(FutuTheme.inkMuted)
        }
        .frame(maxWidth: .infinity, minHeight: 78, alignment: .leading)
        .padding(FutuTheme.panelPadding)
        .background(FutuTheme.surface)
        .overlay {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(FutuTheme.line, lineWidth: 1)
        }
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private var value: String {
        period == .all ? signedMoney(account?.totalProfit) : "不可用"
    }

    private var note: String {
        if period == .all {
            return account?.totalProfit == nil
                ? "证券账户资金接口不提供累计盈亏"
                : "累计已实现收益 + 未实现收益"
        }
        return "\(period.title)需资金流水与每日净值序列"
    }

    private var valueColor: Color {
        guard period == .all, let profit = account?.totalProfit else {
            return FutuTheme.ink
        }
        return profit >= 0 ? FutuTheme.profit : FutuTheme.loss
    }
}

private struct PositionGroup: Identifiable {
    let id: String
    let positions: [PositionSummary]

    var marketValue: Decimal? {
        let values = positions.compactMap { position -> Decimal? in
            guard let price = position.lastPrice else { return nil }
            return abs(position.quantity * price)
        }
        return values.isEmpty ? nil : values.reduce(0, +)
    }

    var todayProfit: Decimal? {
        let values = positions.compactMap(\.todayProfit)
        return values.isEmpty ? nil : values.reduce(0, +)
    }
}

private struct GroupedPositionTable: View {
    let positions: [PositionSummary]
    let quotes: [QuoteSummary]
    let hideAmounts: Bool
    @Binding var collapsedGroups: Set<String>

    var body: some View {
        if positions.isEmpty {
            DataUnavailableView(text: "OpenD 暂未返回持仓数据")
        } else {
            VStack(spacing: 12) {
                ForEach(positionGroups(positions)) { group in
                    VStack(spacing: 0) {
                        HStack(spacing: 12) {
                            Button {
                                toggle(group.id)
                            } label: {
                                Image(
                                    systemName: collapsedGroups.contains(group.id)
                                        ? "chevron.right"
                                        : "chevron.down"
                                )
                                .frame(width: 18, height: 18)
                            }
                            .buttonStyle(.borderless)
                            .help(collapsedGroups.contains(group.id) ? "展开该持仓组" : "收起该持仓组")
                            Text(group.id)
                                .font(FutuTheme.bodyStrong)
                            Text(hideAmounts ? "•••• 项" : "\(group.positions.count) 项")
                                .foregroundStyle(FutuTheme.inkMuted)
                            Spacer()
                            Text("市值 \(sensitive(money(group.marketValue)))")
                            Text("今日 \(sensitive(signedMoney(group.todayProfit)))")
                                .foregroundStyle(
                                    hideAmounts ? FutuTheme.ink : profitColor(group.todayProfit)
                                )
                        }
                        .font(FutuTheme.metricNote.weight(.medium))
                        .monospacedDigit()
                        .padding(.horizontal, 10)
                        .frame(height: 34)
                        .background(FutuTheme.orangeSoft.opacity(0.55))

                        if !collapsedGroups.contains(group.id) {
                            positionHeader
                            ForEach(Array(group.positions.enumerated()), id: \.element.id) { index, position in
                                if index > 0 {
                                    DashedDivider()
                                }
                                positionRow(position)
                            }
                        }
                    }
                    .background(FutuTheme.surfaceMuted.opacity(0.7))
                    .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                }
            }
        }
    }

    private var positionHeader: some View {
        HStack(spacing: 8) {
            fixedCell("代码 / 名称", width: nil, alignment: .leading, header: true)
            fixedCell("数量", width: 70, alignment: .trailing, header: true)
            fixedCell("成本", width: 78, alignment: .trailing, header: true)
            fixedCell("昨收", width: 78, alignment: .trailing, header: true)
            fixedCell("当前时段价", width: 112, alignment: .trailing, header: true)
            fixedCell("今日盈亏", width: 80, alignment: .trailing, header: true)
        }
        .padding(.horizontal, 10)
        .frame(minHeight: 30)
    }

    private func positionRow(_ position: PositionSummary) -> some View {
        let quote = quotes.first { $0.symbol == position.symbol }
        let session = sessionPrice(quote: quote, fallback: position.lastPrice)
        return HStack(spacing: 8) {
            fixedCell(
                "\(position.symbol)\n\(position.name)",
                width: nil,
                alignment: .leading,
                header: false,
                lines: 2
            )
            fixedCell(sensitive(decimal(position.quantity)), width: 70, alignment: .trailing, header: false)
            fixedCell(sensitive(money(position.costPrice)), width: 78, alignment: .trailing, header: false)
            fixedCell(sensitive(money(quote?.previousClose)), width: 78, alignment: .trailing, header: false)
            VStack(alignment: .trailing, spacing: 2) {
                Text(session.label)
                    .font(FutuTheme.metricNote.weight(.semibold))
                    .foregroundStyle(session.color)
                Text(sensitive(money(session.price)))
                    .font(FutuTheme.tableCell)
                    .foregroundStyle(FutuTheme.ink)
                    .monospacedDigit()
            }
            .frame(width: 112, alignment: .trailing)
            Text(sensitive(signedMoney(position.todayProfit)))
                .font(FutuTheme.tableCell)
                .foregroundStyle(hideAmounts ? FutuTheme.ink : profitColor(position.todayProfit))
                .monospacedDigit()
                .lineLimit(1)
                .frame(width: 80, alignment: .trailing)
        }
        .padding(.horizontal, 10)
        .frame(minHeight: 46)
    }

    private func toggle(_ groupId: String) {
        if collapsedGroups.contains(groupId) {
            collapsedGroups.remove(groupId)
        } else {
            collapsedGroups.insert(groupId)
        }
    }

    private func sensitive(_ value: String) -> String {
        hideAmounts && value != "不可用" ? "••••" : value
    }

    private func sessionPrice(
        quote: QuoteSummary?,
        fallback: Decimal?
    ) -> (label: String, price: Decimal?, color: Color) {
        switch quote?.marketState {
        case "盘前":
            return ("盘前", quote?.preMarketPrice, FutuTheme.rose)
        case "盘后":
            return ("盘后", quote?.afterHoursPrice, FutuTheme.rose)
        case "夜盘":
            return ("夜盘", quote?.overnightPrice, FutuTheme.rose)
        case "交易中":
            return ("盘中", quote?.lastPrice ?? fallback, FutuTheme.orange)
        case "夜盘结束", "等待开盘":
            return (quote?.marketState ?? "等待开盘", nil, FutuTheme.inkMuted)
        case let state?:
            return (state, quote?.lastPrice ?? fallback, FutuTheme.inkMuted)
        case nil:
            return ("状态未知", quote?.lastPrice ?? fallback, FutuTheme.inkMuted)
        }
    }
}

private struct CompactSecurityGroupRow: View {
    let group: PositionGroup

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(group.id).font(FutuTheme.bodyStrong)
                Text("\(group.positions.count) 项持仓")
                    .font(FutuTheme.metricNote)
                    .foregroundStyle(FutuTheme.inkMuted)
            }
            Spacer()
            Text(money(group.marketValue))
                .font(FutuTheme.bodyStrong)
                .monospacedDigit()
        }
        .foregroundStyle(FutuTheme.ink)
        .padding(.vertical, 5)
    }
}

private func positionGroups(_ positions: [PositionSummary]) -> [PositionGroup] {
    Dictionary(grouping: positions, by: underlyingSymbol)
        .map { PositionGroup(id: $0.key, positions: $0.value) }
        .sorted { $0.id.localizedStandardCompare($1.id) == .orderedAscending }
}

private func underlyingSymbol(_ position: PositionSummary) -> String {
    let components = position.symbol.split(separator: ".", maxSplits: 1)
    let code = String(components.count == 2 ? components[1] : components[0])
    guard let digitIndex = code.firstIndex(where: \.isNumber),
          digitIndex != code.startIndex else {
        return code
    }
    let prefix = String(code[..<digitIndex])
    let suffix = String(code[digitIndex...]).uppercased()
    return suffix.contains("P") || suffix.contains("C") ? prefix : code
}

private func profitColor(_ value: Decimal?) -> Color {
    guard let value else { return FutuTheme.inkMuted }
    return value >= 0 ? FutuTheme.profit : FutuTheme.loss
}

struct DashedDivider: View {
    var body: some View {
        DashedLine()
            .stroke(
                FutuTheme.lineSoft,
                style: StrokeStyle(lineWidth: 1, dash: [4, 4])
            )
            .frame(height: 1)
    }
}

private struct DashedLine: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.midY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
        return path
    }
}

private struct KeyValueRows: View {
    let rows: [(String, String)]

    var body: some View {
        VStack(spacing: FutuTheme.contentSpacing) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack {
                    Text(row.0).foregroundStyle(FutuTheme.inkMuted)
                    Spacer()
                    Text(row.1)
                        .foregroundStyle(FutuTheme.ink)
                        .fontWeight(.medium)
                        .monospacedDigit()
                        .lineLimit(1)
                }
                .font(FutuTheme.body)
                .lineSpacing(2)
                .frame(minHeight: 24)
            }
        }
    }
}

private struct DataAvailabilityRows: View {
    let items: [(String, Bool)]

    var body: some View {
        VStack(spacing: FutuTheme.contentSpacing) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                HStack {
                    Image(systemName: item.1 ? "checkmark.circle.fill" : "minus.circle")
                        .foregroundStyle(item.1 ? FutuTheme.loss : FutuTheme.amber)
                    Text(item.0)
                    Spacer()
                    Text(item.1 ? "可用" : "待接入")
                        .foregroundStyle(FutuTheme.inkMuted)
                }
                .font(FutuTheme.body)
                .lineSpacing(2)
                .frame(minHeight: 24)
            }
        }
    }
}

struct ChecklistRows: View {
    let items: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: FutuTheme.contentSpacing) {
            ForEach(items, id: \.self) { item in
                Label(item, systemImage: "checkmark")
                    .font(FutuTheme.body)
                    .foregroundStyle(FutuTheme.ink)
                    .lineSpacing(2)
                    .frame(minHeight: 24)
            }
        }
    }
}

private struct QuoteTable: View {
    let quotes: [QuoteSummary]

    var body: some View {
        VStack(spacing: 0) {
            quoteRow(["代码 / 名称", "最新", "今开", "最高", "最低", "成交量"], header: true)
            ForEach(Array(quotes.enumerated()), id: \.element.id) { index, quote in
                if index > 0 {
                    DashedDivider()
                }
                quoteRow([
                    "\(quote.symbol)\n\(quote.name)",
                    money(quote.lastPrice),
                    money(quote.openPrice),
                    money(quote.highPrice),
                    money(quote.lowPrice),
                    decimal(quote.volume ?? 0)
                ])
            }
        }
    }

    private func quoteRow(_ values: [String], header: Bool = false) -> some View {
        HStack(spacing: 8) {
            fixedCell(values[0], width: nil, alignment: .leading, header: header, lines: 2)
            ForEach(1..<values.count, id: \.self) { index in
                fixedCell(values[index], width: 82, alignment: .trailing, header: header)
            }
        }
        .frame(minHeight: header ? 30 : 42)
    }
}

private struct BarSummary: View {
    let bars: [CandlestickSummary]

    var body: some View {
        if let latest = bars.last {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text(latest.symbol).font(FutuTheme.bodyStrong)
                    Spacer()
                    Text(latest.time)
                        .font(FutuTheme.metricNote)
                        .foregroundStyle(FutuTheme.inkMuted)
                }
                KeyValueRows(rows: [
                    ("开盘", money(latest.open)),
                    ("最高", money(latest.high)),
                    ("最低", money(latest.low)),
                    ("收盘", money(latest.close)),
                    ("成交量", decimal(latest.volume)),
                    ("已加载", "\(bars.count) 根")
                ])
            }
            .frame(minHeight: 146, alignment: .top)
        } else {
            DataUnavailableView(text: "OpenD 未返回分钟 K 线")
                .frame(minHeight: 146, alignment: .top)
        }
    }
}

private struct OrderBookView: View {
    let books: [OrderBookSummary]

    var body: some View {
        if let book = books.first {
            VStack(spacing: 4) {
                Text(book.symbol)
                    .font(FutuTheme.tableHeader)
                    .frame(maxWidth: .infinity, alignment: .leading)
                ForEach(Array(book.asks.prefix(5).reversed())) { level in
                    levelRow(level, color: FutuTheme.profit)
                }
                Divider()
                ForEach(book.bids.prefix(5)) { level in
                    levelRow(level, color: FutuTheme.loss)
                }
            }
            .frame(minHeight: 146, alignment: .top)
        } else {
            DataUnavailableView(text: "OpenD 未返回盘口")
                .frame(minHeight: 146, alignment: .top)
        }
    }

    private func levelRow(_ level: OrderBookLevel, color: Color) -> some View {
        HStack {
            Text("\(level.side == "ASK" ? "卖" : "买") \(level.level)")
                .foregroundStyle(color)
            Spacer()
            Text(money(level.price))
            Text(decimal(level.volume)).frame(width: 70, alignment: .trailing)
        }
        .font(FutuTheme.tableCell)
        .monospacedDigit()
    }
}

private struct TickerTable: View {
    let tickers: [TickerSummary]

    var body: some View {
        if tickers.isEmpty {
            DataUnavailableView(text: "OpenD 未返回逐笔成交")
        } else {
            let rows = Array(tickers.suffix(12).reversed())
            VStack(spacing: 0) {
                tickerRow(["代码", "时间", "方向", "价格", "成交量"], header: true)
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, ticker in
                    if index > 0 {
                        DashedDivider()
                    }
                    tickerRow([
                        ticker.symbol,
                        ticker.time,
                        ticker.direction == 1 ? "买入" : ticker.direction == 2 ? "卖出" : "中性",
                        money(ticker.price),
                        decimal(ticker.volume)
                    ])
                }
            }
        }
    }

    private func tickerRow(_ values: [String], header: Bool = false) -> some View {
        HStack(spacing: 8) {
            fixedCell(values[0], width: nil, alignment: .leading, header: header)
            fixedCell(values[1], width: 118, alignment: .leading, header: header)
            fixedCell(values[2], width: 54, alignment: .center, header: header)
            fixedCell(values[3], width: 86, alignment: .trailing, header: header)
            fixedCell(values[4], width: 78, alignment: .trailing, header: header)
        }
        .frame(minHeight: header ? 30 : 36)
    }
}

private struct OrderTable: View {
    let orders: [BrokerOrderSummary]

    var body: some View {
        if orders.isEmpty {
            DataUnavailableView(text: "当前查询范围内没有订单，或账户权限不足")
                .frame(minHeight: 90, alignment: .top)
        } else {
            let rows = Array(orders.prefix(20))
            VStack(spacing: 0) {
                orderRow(["代码 / 名称", "方向", "数量", "委托价", "已成交", "状态"], header: true)
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, order in
                    if index > 0 {
                        DashedDivider()
                    }
                    orderRow([
                        "\(order.symbol)\n\(order.name)",
                        order.side == 1 ? "买入" : "卖出",
                        decimal(order.quantity),
                        money(order.price),
                        decimal(order.filledQuantity),
                        "\(order.status)"
                    ], side: order.side)
                }
            }
        }
    }

    private func orderRow(
        _ values: [String],
        header: Bool = false,
        side: Int? = nil
    ) -> some View {
        HStack(spacing: 8) {
            fixedCell(values[0], width: nil, alignment: .leading, header: header, lines: 2)
            fixedCell(values[1], width: 54, alignment: .center, header: header)
                .foregroundStyle(header ? FutuTheme.inkMuted : side == 1 ? FutuTheme.profit : FutuTheme.loss)
            fixedCell(values[2], width: 76, alignment: .trailing, header: header)
            fixedCell(values[3], width: 88, alignment: .trailing, header: header)
            fixedCell(values[4], width: 76, alignment: .trailing, header: header)
            fixedCell(values[5], width: 64, alignment: .trailing, header: header)
        }
        .frame(minHeight: header ? 30 : 42)
    }
}

private struct FillTable: View {
    let fills: [BrokerFillSummary]

    var body: some View {
        if fills.isEmpty {
            DataUnavailableView(text: "当前查询范围内没有成交，或账户权限不足")
                .frame(minHeight: 90, alignment: .top)
        } else {
            let rows = Array(fills.prefix(20))
            VStack(spacing: 0) {
                fillRow(["代码 / 名称", "成交时间", "方向", "数量", "成交价"], header: true)
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, fill in
                    if index > 0 {
                        DashedDivider()
                    }
                    fillRow([
                        "\(fill.symbol)\n\(fill.name)",
                        fill.createdAt,
                        fill.side == 1 ? "买入" : "卖出",
                        decimal(fill.quantity),
                        money(fill.price)
                    ], side: fill.side)
                }
            }
        }
    }

    private func fillRow(
        _ values: [String],
        header: Bool = false,
        side: Int? = nil
    ) -> some View {
        HStack(spacing: 8) {
            fixedCell(values[0], width: nil, alignment: .leading, header: header, lines: 2)
            fixedCell(values[1], width: 142, alignment: .leading, header: header)
            fixedCell(values[2], width: 54, alignment: .center, header: header)
                .foregroundStyle(header ? FutuTheme.inkMuted : side == 1 ? FutuTheme.profit : FutuTheme.loss)
            fixedCell(values[3], width: 76, alignment: .trailing, header: header)
            fixedCell(values[4], width: 88, alignment: .trailing, header: header)
        }
        .frame(minHeight: header ? 30 : 42)
    }
}

private func fixedCell(
    _ value: String,
    width: CGFloat?,
    alignment: Alignment,
    header: Bool,
    lines: Int = 1
) -> some View {
    Text(value)
        .font(header ? FutuTheme.tableHeader : FutuTheme.tableCell)
        .foregroundStyle(header ? FutuTheme.inkMuted : FutuTheme.ink)
        .monospacedDigit()
        .lineLimit(lines)
        .frame(maxWidth: width == nil ? .infinity : width, alignment: alignment)
}

private struct RiskSummary: View {
    let account: AccountSummary?
    let positions: [PositionSummary]
    var hideAmounts = false

    var body: some View {
        let values = positions.compactMap { position -> Decimal? in
            guard let price = position.lastPrice else { return nil }
            return abs(price * position.quantity)
        }
        let total = values.reduce(0, +)
        let largest = values.max() ?? 0
        let concentration = total > 0
            ? NSDecimalNumber(decimal: largest / total * 100).doubleValue
            : nil
        VStack(spacing: FutuTheme.contentSpacing) {
            KeyValueRows(rows: [
                ("持仓数量", sensitive("\(positions.count)")),
                ("最大单项占比", sensitive(concentration.map { String(format: "%.1f%%", $0) } ?? "不可用")),
                ("现金占总资产", sensitive(cashRatio))
            ])
            if let concentration, concentration >= 40 {
                DataUnavailableView(text: "单项持仓集中度较高")
            }
        }
    }

    private var cashRatio: String {
        guard let account, account.totalAssets != 0 else { return "不可用" }
        let value = NSDecimalNumber(decimal: account.cash / account.totalAssets * 100).doubleValue
        return String(format: "%.1f%%", value)
    }

    private func sensitive(_ value: String) -> String {
        hideAmounts && value != "不可用" ? "••••" : value
    }
}

private func money(_ value: Decimal?) -> String {
    guard let value else { return "不可用" }
    return value.formatted(.number.precision(.fractionLength(2)))
}

private func signedMoney(_ value: Decimal?) -> String {
    guard let value else { return "不可用" }
    let prefix = value > 0 ? "+" : ""
    return prefix + value.formatted(.number.precision(.fractionLength(2)))
}

private func decimal(_ value: Decimal) -> String {
    value.formatted(.number.precision(.fractionLength(0...4)))
}
