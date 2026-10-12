import AppKit
import ChangFuDomain
import SwiftUI

struct QuantitativeReportModule: View {
    @Bindable var state: AppState
    @State private var detail: QuantitativeDetailSelection?
    @State private var isMarkdownPresented = false
    @State private var isComparisonPresented = false

    var body: some View {
        HStack(alignment: .top, spacing: FutuTheme.sectionSpacing) {
            VStack(alignment: .leading, spacing: 16) {
                header
                if let report = state.quantitativeReport {
                    rankedSection(
                        isSignalReport(report) ? "Top 5 买入推荐" : "Top 5 历史评分",
                        items: report.summary?.topFive ?? [],
                        report: report
                    )
                    rankedSection(
                        isSignalReport(report) ? "观察名单" : "历史观察名单",
                        items: report.summary?.watchlist ?? [],
                        report: report
                    )
                    rankedSection(
                        isSignalReport(report) ? "放弃名单" : "历史低分组",
                        items: report.summary?.bottomFive ?? [],
                        report: report
                    )
                    allItems(report)
                } else {
                    DataUnavailableView(text: "尚无选股结果，请从研究页执行 Top30 选股研究")
                        .frame(maxWidth: .infinity, minHeight: 180)
                }
            }
            .frame(maxWidth: .infinity)
            history
                .frame(width: 250)
        }
        .sheet(item: $detail) { selection in
            QuantitativeItemDetailSheet(selection: selection)
        }
        .sheet(isPresented: $isMarkdownPresented) {
            if let report = state.quantitativeReport {
                QuantitativeMarkdownSheet(report: report)
            }
        }
        .sheet(isPresented: $isComparisonPresented, onDismiss: {
            state.clearQuantitativeComparison()
        }) {
            if let comparison = state.quantitativeComparison {
                QuantitativeComparisonSheet(comparison: comparison)
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Top30 量化选股")
                        .font(FutuTheme.panelTitle)
                    Text(
                        state.quantitativeReport.map {
                            isSignalReport($0)
                                ? "长富Pro · 五层证据独立研判"
                                : "长富Pro · 五层证据历史评分"
                        } ?? "长富Pro · 五层证据独立研判"
                    )
                        .font(FutuTheme.pageSubtitle)
                        .foregroundStyle(FutuTheme.inkMuted)
                }
                Spacer()
                if let report = state.quantitativeReport {
                    Menu {
                        if state.oppositeQuantitativeReportHistory.isEmpty {
                            Text("另一平台暂无历史报告")
                        } else {
                            ForEach(state.oppositeQuantitativeReportHistory) { history in
                                Button(displayTime(history.startedAt)) {
                                    Task {
                                        await state.compareQuantitativeReport(with: history)
                                        isComparisonPresented = state.quantitativeComparison != nil
                                    }
                                }
                            }
                        }
                    } label: {
                        Image(systemName: "rectangle.split.2x1")
                    }
                    .menuStyle(.borderlessButton)
                    .help("选择另一平台报告对比")
                    Button {
                        isMarkdownPresented = true
                    } label: {
                        Image(systemName: "doc.text")
                    }
                    .buttonStyle(.borderless)
                    .help("查看完整报告")
                    .disabled(report.markdown == nil)
                    Button {
                        exportMarkdown(report)
                    } label: {
                        Image(systemName: "square.and.arrow.down")
                    }
                    .buttonStyle(.borderless)
                    .help("导出 Markdown 报告")
                    StatusPill(
                        text: report.status == "COMPLETED" ? "已研判" : "未完成",
                        color: report.status == "COMPLETED" ? FutuTheme.profit : FutuTheme.amber
                    )
                }
            }
            if let report = state.quantitativeReport {
                HStack(spacing: 10) {
                    Label("生成于 \(displayTime(report.startedAt))", systemImage: "clock")
                    Spacer(minLength: 8)
                    Text("\(report.terminalCount)/\(report.symbolCount) 完成")
                    Text(candidateCountLabel(report))
                    Text("\(report.dataGapCount) 缺口")
                }
                .font(FutuTheme.metricNote)
                .foregroundStyle(FutuTheme.inkMuted)
                if isSignalReport(report) {
                    Text("买入、观望、放弃为研究结论，不生成订单或触发交易")
                        .font(FutuTheme.metricNote)
                        .foregroundStyle(FutuTheme.inkMuted)
                }
            }
        }
    }

    private func rankedSection(
        _ title: String,
        items: [QuantitativeItemAnalysis],
        report: QuantitativeReport
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(FutuTheme.panelTitle)
            if items.isEmpty {
                Text(emptyText(for: title))
                    .font(FutuTheme.body)
                    .foregroundStyle(FutuTheme.inkMuted)
            } else {
                table(detailSelections(items, report: report))
            }
        }
        .padding(.vertical, 12)
        .overlay(alignment: .bottom) { Divider() }
    }

    private func allItems(_ report: QuantitativeReport) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("逐标的明细").font(FutuTheme.panelTitle)
                Spacer()
                Text("点击详情查看信号理由、五维研判、风险与失效条件")
                    .font(FutuTheme.metricNote)
                    .foregroundStyle(FutuTheme.inkMuted)
            }
            table(
                report.items.compactMap { reportItem in
                    guard let analysis = reportItem.analysis else { return nil }
                    return detailSelection(analysis, reportItem: reportItem)
                }
            )
        }
    }

    private func table(_ items: [QuantitativeDetailSelection]) -> some View {
        ScrollView(.horizontal) {
            VStack(spacing: 0) {
                row(
                    rank: "排名",
                    symbol: "标的",
                    score: "吸引力",
                    fundamentals: "基本面",
                    filings: "申报",
                    shortActivity: "卖空",
                    price: "价格",
                    macro: "宏观",
                    status: "信号",
                    header: true
                )
                ForEach(Array(items.enumerated()), id: \.element.id) { index, selection in
                    Button {
                        detail = selection
                    } label: {
                        row(
                            rank: selection.analysis.finalRank.map(String.init) ?? "—",
                            symbol: selection.analysis.ticker,
                            score: selection.analysis.totalScore.map(String.init) ?? "—",
                            fundamentals: score(selection.analysis.dimensions?.fundamentals),
                            filings: score(selection.analysis.dimensions?.filings),
                            shortActivity: score(selection.analysis.dimensions?.shortActivity),
                            price: score(selection.analysis.dimensions?.priceTrend),
                            macro: score(selection.analysis.dimensions?.macroFit),
                            status: statusLabel(selection.analysis),
                            header: false
                        )
                    }
                    .buttonStyle(.plain)
                    .background(index.isMultiple(of: 2)
                        ? FutuTheme.surface
                        : FutuTheme.surfaceMuted.opacity(0.48))
                    if index < items.count - 1 { Divider() }
                }
            }
            .frame(minWidth: 760)
            .overlay {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .stroke(FutuTheme.lineSoft, lineWidth: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        }
        .frame(maxWidth: .infinity)
    }

    private func row(
        rank: String,
        symbol: String,
        score: String,
        fundamentals: String,
        filings: String,
        shortActivity: String,
        price: String,
        macro: String,
        status: String,
        header: Bool
    ) -> some View {
        HStack(spacing: 0) {
            cell(rank, 44, .trailing, header)
            Spacer(minLength: 10)
            cell(symbol, 90, .leading, header, emphasized: true)
            Spacer(minLength: 10)
            cell(score, 52, .trailing, header)
            Spacer(minLength: 10)
            cell(fundamentals, 64, .trailing, header)
            Spacer(minLength: 10)
            cell(filings, 54, .trailing, header)
            Spacer(minLength: 10)
            cell(shortActivity, 54, .trailing, header)
            Spacer(minLength: 10)
            cell(price, 54, .trailing, header)
            Spacer(minLength: 10)
            cell(macro, 54, .trailing, header)
            Spacer(minLength: 10)
            cell(status, 86, .leading, header)
            Spacer(minLength: 10)
            if header {
                Image(systemName: "info.circle")
                    .foregroundStyle(FutuTheme.inkMuted)
                    .frame(width: 20)
            } else {
                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(FutuTheme.inkMuted)
                    .frame(width: 20)
            }
        }
        .padding(.horizontal, 10)
        .frame(height: header ? 34 : 38)
        .background(header ? FutuTheme.surfaceMuted : Color.clear)
        .contentShape(Rectangle())
    }

    private func cell(
        _ text: String,
        _ width: CGFloat,
        _ alignment: Alignment,
        _ header: Bool,
        emphasized: Bool = false
    ) -> some View {
        Text(text)
            .font(
                header
                    ? FutuTheme.tableHeader
                    : emphasized ? FutuTheme.tableCell.weight(.semibold) : FutuTheme.tableCell
            )
            .foregroundStyle(header ? FutuTheme.inkMuted : FutuTheme.ink)
            .monospacedDigit()
            .lineLimit(1)
            .frame(width: width, alignment: alignment)
    }

    private var history: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("历史报告").font(FutuTheme.panelTitle)
            if state.quantitativeReportHistory.isEmpty {
                Text("暂无历史报告")
                    .font(FutuTheme.body)
                    .foregroundStyle(FutuTheme.inkMuted)
            } else {
                LazyVStack(spacing: 4) {
                    ForEach(state.quantitativeReportHistory) { report in
                        Button {
                            Task { await state.loadQuantitativeReport(report.runId) }
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(displayTime(report.startedAt))
                                    .font(FutuTheme.bodyStrong)
                                Text(
                                    "\(report.terminalCount)/\(report.symbolCount) 完成"
                                        + " · "
                                        + (
                                            isSignalReport(report)
                                                ? "\(report.candidateCount) 买入"
                                                : "\(report.candidateCount) 历史合格"
                                        )
                                )
                                .font(FutuTheme.metricNote)
                                .foregroundStyle(FutuTheme.inkMuted)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.vertical, 7)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .padding(14)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(FutuTheme.surfaceMuted)
    }

    private func detailSelections(
        _ analyses: [QuantitativeItemAnalysis],
        report: QuantitativeReport
    ) -> [QuantitativeDetailSelection] {
        let reportItems = Dictionary(
            uniqueKeysWithValues: report.items.map { ($0.requestId, $0) }
        )
        return analyses.map { analysis in
            detailSelection(analysis, reportItem: reportItems[analysis.requestId])
        }
    }

    private func detailSelection(
        _ analysis: QuantitativeItemAnalysis,
        reportItem _: QuantitativeReportItem?
    ) -> QuantitativeDetailSelection {
        QuantitativeDetailSelection(analysis: analysis)
    }

    private func score(_ value: QuantitativeDimensionScore?) -> String {
        value?.score.map(String.init) ?? "—"
    }

    private func isSignalReport(_ report: QuantitativeReport) -> Bool {
        signalScoringVersions.contains(report.scoringVersion)
    }

    private func isSignalReport(_ report: QuantitativeReportHistoryItem) -> Bool {
        signalScoringVersions.contains(report.scoringVersion)
    }

    private var signalScoringVersions: Set<String> {
        ["top30-investment-signal-v2", "top30-investment-price-plan-v3"]
    }

    private func candidateCountLabel(_ report: QuantitativeReport) -> String {
        isSignalReport(report)
            ? "\(report.candidateCount) 买入信号"
            : "\(report.candidateCount) 历史合格"
    }

    private func emptyText(for title: String) -> String {
        switch title {
        case "Top 5 买入推荐":
            return "本期暂无同时满足数据门槛的买入信号"
        case "观察名单":
            return "本期暂无观望信号"
        case "放弃名单":
            return "本期暂无放弃信号"
        default:
            return "暂无满足条件的标的"
        }
    }

    private func statusLabel(_ item: QuantitativeItemAnalysis) -> String {
        switch item.candidateStatus {
        case "DATA_INSUFFICIENT": return "数据不足"
        case "REJECTED": return "研判失败"
        default:
            switch item.researchSignal {
            case "BUY": return "买入"
            case "WATCH": return "观望"
            case "AVOID": return "放弃"
            default: return "历史评分"
            }
        }
    }

    private func displayTime(_ value: String) -> String {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = fractional.date(from: value)
            ?? ISO8601DateFormatter().date(from: value) else { return value }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    private func exportMarkdown(_ report: QuantitativeReport) {
        guard let markdown = report.markdown else { return }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.plainText]
        panel.nameFieldStringValue = "top30-quantitative-\(report.runId).md"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        try? markdown.write(to: url, atomically: true, encoding: .utf8)
    }
}

private struct QuantitativeDetailSelection: Identifiable {
    let analysis: QuantitativeItemAnalysis

    var id: String { analysis.requestId }
}

private struct QuantitativeItemDetailSheet: View {
    @Environment(\.dismiss) private var dismiss
    let selection: QuantitativeDetailSelection

    private var item: QuantitativeItemAnalysis { selection.analysis }
    private var signalReason: String {
        let reason = item.signalReason?.trimmingCharacters(in: .whitespacesAndNewlines)
        return reason.flatMap { $0.isEmpty ? nil : $0 }
            ?? item.summary
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text(
                        "\(item.ticker) · "
                        + "\(item.totalScore.map(String.init) ?? "不可用") 投资吸引力"
                    )
                        .font(FutuTheme.pageTitle)
                    HStack(spacing: 8) {
                        Text(item.displayName)
                            .font(FutuTheme.pageSubtitle)
                            .foregroundStyle(FutuTheme.inkMuted)
                        if let signal = item.researchSignal {
                            StatusPill(
                                text: researchSignalLabel(signal),
                                color: researchSignalColor(signal)
                            )
                        }
                    }
                }
                Spacer()
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark")
                }
                .buttonStyle(.borderless)
                .help("关闭")
            }
            .padding(20)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if let dimensions = item.dimensions {
                        LazyVGrid(
                            columns: Array(
                                repeating: GridItem(.flexible(), spacing: 16),
                                count: 5
                            ),
                            alignment: .leading,
                            spacing: 12
                        ) {
                            metric("基本面", dimensions.fundamentals)
                            metric("申报", dimensions.filings)
                            metric("卖空", dimensions.shortActivity)
                            metric("价格", dimensions.priceTrend)
                            metric("宏观", dimensions.macroFit)
                        }
                    }
                    Divider()
                    VStack(alignment: .leading, spacing: 7) {
                        Text("最终研究信号").font(FutuTheme.panelTitle)
                        Text(signalReason)
                            .font(FutuTheme.body)
                            .lineSpacing(3)
                            .textSelection(.enabled)
                    }
                    pricePlanSection(item.pricePlan)
                    assessmentSection(
                        "支持研判",
                        text: item.supportingAssessment,
                        color: FutuTheme.profit,
                        fallback: "该历史报告未保存模型聚合后的支持研判。"
                    )
                    assessmentSection(
                        "反对研判",
                        text: item.opposingAssessment,
                        color: FutuTheme.rose,
                        fallback: "该历史报告未保存模型聚合后的反对研判。"
                    )
                    VStack(alignment: .leading, spacing: 7) {
                        Text("研究结论").font(FutuTheme.panelTitle)
                        Text(item.summary)
                            .font(FutuTheme.body)
                            .lineSpacing(3)
                            .textSelection(.enabled)
                    }
                    if let shortActivity = item.dimensions?.shortActivity {
                        shortActivityAssessment(shortActivity)
                    }
                    detailSection("风险", item.risks, FutuTheme.rose)
                    detailSection("数据缺口", item.dataGaps, FutuTheme.amber)
                    detailSection("失效条件", item.invalidationConditions, FutuTheme.ink)
                }
                .padding(20)
            }
        }
        .frame(minWidth: 900, minHeight: 640)
        .background(FutuTheme.canvas)
    }

    private func metric(_ title: String, _ value: QuantitativeDimensionScore) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(FutuTheme.metricNote).foregroundStyle(FutuTheme.inkMuted)
            Text(value.score.map(String.init) ?? "不可用")
                .font(FutuTheme.bodyStrong)
                .monospacedDigit()
            Text(value.availability.displayName)
                .font(FutuTheme.metricNote)
                .foregroundStyle(FutuTheme.inkMuted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func shortActivityAssessment(
        _ value: QuantitativeDimensionScore
    ) -> some View {
        let assessment = value.assessment?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let assessmentText = assessment.flatMap { $0.isEmpty ? nil : $0 }
            ?? "该历史报告未保存模型聚合后的卖空研判。"
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Text("卖空研判")
                    .font(FutuTheme.panelTitle)
                Text(value.score.map { "\($0) / 10" } ?? "不可用")
                    .font(FutuTheme.metricNote.weight(.semibold))
                    .foregroundStyle(FutuTheme.orange)
                Spacer()
                Text(value.availability.displayName)
                    .font(FutuTheme.metricNote)
                    .foregroundStyle(FutuTheme.inkMuted)
            }
            Text(assessmentText)
            .font(FutuTheme.body)
            .foregroundStyle(FutuTheme.ink)
            .lineSpacing(3)
            .textSelection(.enabled)
        }
        .padding(12)
        .background(FutuTheme.surfaceMuted)
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    private func assessmentSection(
        _ title: String,
        text: String?,
        color: Color,
        fallback: String
    ) -> some View {
        let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines)
        let content = trimmed.flatMap { $0.isEmpty ? nil : $0 } ?? fallback
        return VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(FutuTheme.panelTitle)
                .foregroundStyle(color)
            Text(content)
                .font(FutuTheme.body)
                .foregroundStyle(FutuTheme.ink)
                .lineSpacing(3)
                .textSelection(.enabled)
        }
        .padding(12)
        .background(FutuTheme.surfaceMuted)
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    @ViewBuilder
    private func pricePlanSection(_ plan: QuantitativePricePlan?) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("价格计划").font(FutuTheme.panelTitle)
            if let plan {
                LazyVGrid(
                    columns: Array(
                        repeating: GridItem(.flexible(), spacing: 14),
                        count: 4
                    ),
                    alignment: .leading,
                    spacing: 10
                ) {
                    planMetric("入场判断", entryDecisionLabel(plan.entryDecision))
                    planMetric("买入区间", priceRange(plan.entryPriceLow, plan.entryPriceHigh))
                    planMetric("止盈区间", priceRange(plan.takeProfitLow, plan.takeProfitHigh))
                    planMetric("止损价", price(plan.stopLossPrice))
                    planMetric(
                        "计划有效期",
                        plan.entryExpiryTradingDays.map { "\($0) 个交易日" } ?? "不适用"
                    )
                    planMetric(
                        "预计持有期",
                        dayRange(plan.expectedHoldingDaysLow, plan.expectedHoldingDaysHigh)
                    )
                    planMetric(
                        "收益风险比",
                        plan.riskRewardRatio.map { String(format: "%.2f", $0) } ?? "不适用"
                    )
                    planMetric("置信度", confidenceLabel(plan.confidence))
                }
                Text(plan.rationale)
                    .font(FutuTheme.body)
                    .lineSpacing(3)
                    .textSelection(.enabled)
                detailSection("退出条件", plan.exitConditions, FutuTheme.ink)
            } else {
                Text("该历史报告未生成价格计划。")
                    .font(FutuTheme.body)
                    .foregroundStyle(FutuTheme.inkMuted)
            }
        }
        .padding(12)
        .background(FutuTheme.surfaceMuted)
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    private func planMetric(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(FutuTheme.metricNote)
                .foregroundStyle(FutuTheme.inkMuted)
            Text(value)
                .font(FutuTheme.bodyStrong)
                .monospacedDigit()
                .lineLimit(2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func priceRange(_ low: Double?, _ high: Double?) -> String {
        guard let low, let high else { return "不适用" }
        return "\(price(low)) – \(price(high))"
    }

    private func price(_ value: Double?) -> String {
        value.map { String(format: "$%.2f", $0) } ?? "不适用"
    }

    private func dayRange(_ low: Int?, _ high: Int?) -> String {
        guard let low, let high else { return "不适用" }
        return "\(low)–\(high) 个交易日"
    }

    private func entryDecisionLabel(_ value: String) -> String {
        switch value {
        case "BUY_NOW": return "当前可买"
        case "WAIT_PULLBACK": return "等待回调"
        case "WAIT_BREAKOUT": return "等待突破"
        default: return "暂不入场"
        }
    }

    private func confidenceLabel(_ value: String) -> String {
        switch value {
        case "HIGH": return "高"
        case "MEDIUM": return "中"
        default: return "低"
        }
    }

    @ViewBuilder
    private func detailSection(_ title: String, _ values: [String], _ color: Color) -> some View {
        if !values.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text(title).font(FutuTheme.panelTitle)
                ForEach(values, id: \.self) { value in
                    Text("• \(value)")
                        .font(FutuTheme.body)
                        .foregroundStyle(color)
                        .textSelection(.enabled)
                }
            }
        }
    }

    private func researchSignalLabel(_ signal: String) -> String {
        switch signal {
        case "BUY": return "买入"
        case "WATCH": return "观望"
        case "AVOID": return "放弃"
        default: return "历史评分"
        }
    }

    private func researchSignalColor(_ signal: String) -> Color {
        switch signal {
        case "BUY": return FutuTheme.profit
        case "WATCH": return FutuTheme.amber
        case "AVOID": return FutuTheme.rose
        default: return FutuTheme.inkMuted
        }
    }

}

private struct QuantitativeComparisonSheet: View {
    @Environment(\.dismiss) private var dismiss
    let comparison: QuantitativeReportComparison

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("选股结果对比").font(FutuTheme.pageTitle)
                Spacer()
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark")
                }
                .buttonStyle(.borderless)
                .help("关闭")
            }
            .padding(18)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if comparison.versionWarning {
                        Label("两份报告的评分版本不同，差异仅供参考", systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(FutuTheme.amber)
                    }
                    HStack(spacing: 24) {
                        summary("Top5 重合", "\(comparison.topFiveOverlap.count) / 5")
                        summary(
                            "排名相关性",
                            comparison.spearmanRankCorrelation.map {
                                String(format: "%.3f", $0)
                            } ?? "不可用"
                        )
                        summary(
                            "最大排名差",
                            comparison.maximumRankDifference.map(String.init) ?? "不可用"
                        )
                    }
                    VStack(spacing: 0) {
                        comparisonRow("标的", "左侧分数 / 排名", "右侧分数 / 排名", "差异", true)
                        ForEach(Array(comparison.items.enumerated()), id: \.element.ticker) {
                            index,
                            item in
                            comparisonRow(
                                item.ticker,
                                scoreAndRank(item.left),
                                scoreAndRank(item.right),
                                item.totalScoreDifference.map { String(format: "%+d", $0) } ?? "—",
                                false
                            )
                            .background(index.isMultiple(of: 2)
                                ? FutuTheme.surface
                                : FutuTheme.surfaceMuted.opacity(0.48))
                        }
                    }
                    .overlay {
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .stroke(FutuTheme.lineSoft, lineWidth: 1)
                    }
                }
                .padding(18)
            }
        }
        .frame(minWidth: 860, minHeight: 620)
        .background(FutuTheme.canvas)
    }

    private func summary(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(FutuTheme.metricNote).foregroundStyle(FutuTheme.inkMuted)
            Text(value).font(FutuTheme.bodyStrong).monospacedDigit()
        }
    }

    private func comparisonRow(
        _ ticker: String,
        _ left: String,
        _ right: String,
        _ difference: String,
        _ header: Bool
    ) -> some View {
        HStack(spacing: 12) {
            compareCell(ticker, 100, .leading, header)
            compareCell(left, 180, .trailing, header)
            compareCell(right, 180, .trailing, header)
            compareCell(difference, 100, .trailing, header)
            Spacer()
        }
        .padding(.horizontal, 10)
        .frame(height: 36)
        .background(header ? FutuTheme.surfaceMuted : Color.clear)
    }

    private func compareCell(
        _ value: String,
        _ width: CGFloat,
        _ alignment: Alignment,
        _ header: Bool
    ) -> some View {
        Text(value)
            .font(header ? FutuTheme.tableHeader : FutuTheme.tableCell)
            .frame(width: width, alignment: alignment)
            .lineLimit(1)
    }

    private func scoreAndRank(_ item: QuantitativeItemAnalysis?) -> String {
        guard let item else { return "仅另一侧" }
        return "\(item.totalScore.map(String.init) ?? "—") / \(item.finalRank.map(String.init) ?? "—")"
    }
}

private struct QuantitativeMarkdownSheet: View {
    @Environment(\.dismiss) private var dismiss
    let report: QuantitativeReport

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("选股研究完整结果").font(FutuTheme.panelTitle)
                Spacer()
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark")
                }
                .buttonStyle(.borderless)
                .help("关闭")
            }
            .padding(16)
            Divider()
            ScrollView {
                Text(report.markdown ?? "")
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(18)
            }
        }
        .frame(minWidth: 820, minHeight: 620)
        .background(FutuTheme.canvas)
    }
}
