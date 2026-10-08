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
                        "Top 5 候选",
                        items: report.summary?.topFive ?? [],
                        report: report
                    )
                    rankedSection(
                        "观察名单",
                        items: report.summary?.watchlist ?? [],
                        report: report
                    )
                    rankedSection(
                        "Bottom 5 风险",
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
                    Text("长富Pro · 五层证据独立评分")
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
                        text: report.candidateCount > 0 ? "可用" : "数据不足",
                        color: report.candidateCount > 0 ? FutuTheme.profit : FutuTheme.amber
                    )
                }
            }
            if let report = state.quantitativeReport {
                HStack(spacing: 10) {
                    Label("生成于 \(displayTime(report.startedAt))", systemImage: "clock")
                    Spacer(minLength: 8)
                    Text("\(report.terminalCount)/\(report.symbolCount) 完成")
                    Text("\(report.candidateCount) 合格")
                    Text("\(report.dataGapCount) 缺口")
                }
                .font(FutuTheme.metricNote)
                .foregroundStyle(FutuTheme.inkMuted)
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
                Text("暂无满足条件的标的")
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
                Text("点击详情查看五维评分、证据、风险与失效条件")
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
                    score: "总分",
                    fundamentals: "基本面",
                    filings: "申报",
                    shortActivity: "卖空",
                    price: "价格",
                    macro: "宏观",
                    status: "状态",
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
                            status: statusLabel(selection.analysis.candidateStatus),
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
                                        + " · \(report.candidateCount) 合格"
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
        reportItem: QuantitativeReportItem?
    ) -> QuantitativeDetailSelection {
        let evidence = (reportItem?.brokerObservation?.evidence ?? [])
            + (reportItem?.officialEvidence ?? [])
        var evidenceById: [String: QuantitativeEvidence] = [:]
        for item in evidence {
            evidenceById[item.id] = item
        }
        return QuantitativeDetailSelection(
            analysis: analysis,
            evidenceById: evidenceById
        )
    }

    private func score(_ value: QuantitativeDimensionScore?) -> String {
        value?.score.map(String.init) ?? "—"
    }

    private func statusLabel(_ value: String) -> String {
        switch value {
        case "ELIGIBLE": "合格"
        case "DATA_INSUFFICIENT": "数据不足"
        case "REJECTED": "评分失败"
        default: "待处理"
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
    let evidenceById: [String: QuantitativeEvidence]

    var id: String { analysis.requestId }
}

private struct QuantitativeItemDetailSheet: View {
    @Environment(\.dismiss) private var dismiss
    let selection: QuantitativeDetailSelection

    private var item: QuantitativeItemAnalysis { selection.analysis }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("\(item.ticker) · \(item.totalScore.map(String.init) ?? "不可用") 分")
                        .font(FutuTheme.pageTitle)
                    Text(item.displayName)
                        .font(FutuTheme.pageSubtitle)
                        .foregroundStyle(FutuTheme.inkMuted)
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
                        Text("研究结论").font(FutuTheme.panelTitle)
                        Text(item.summary)
                            .font(FutuTheme.body)
                            .lineSpacing(3)
                            .textSelection(.enabled)
                    }
                    evidenceSection("支持证据", ids: item.evidenceIds)
                    evidenceSection("反对证据", ids: item.counterEvidenceIds)
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

    @ViewBuilder
    private func evidenceSection(_ title: String, ids: [String]) -> some View {
        let evidence = ids.compactMap { selection.evidenceById[$0] }
        if !ids.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text(title).font(FutuTheme.panelTitle)
                ForEach(evidence) { item in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 8) {
                            Text(sourceLabel(item.source))
                                .font(FutuTheme.metricNote.weight(.semibold))
                                .foregroundStyle(FutuTheme.orange)
                                .frame(width: 112, alignment: .leading)
                            Text(item.title)
                                .font(FutuTheme.bodyStrong)
                                .foregroundStyle(FutuTheme.ink)
                            Spacer(minLength: 8)
                            Text(displayDate(item.asOf ?? item.capturedAt))
                                .font(FutuTheme.metricNote)
                                .foregroundStyle(FutuTheme.inkMuted)
                        }
                        HStack(alignment: .top, spacing: 8) {
                            Text(item.layer.displayName)
                                .font(FutuTheme.metricNote)
                                .foregroundStyle(FutuTheme.inkMuted)
                                .frame(width: 112, alignment: .leading)
                            Text(evidenceValue(item))
                                .font(FutuTheme.body)
                                .foregroundStyle(FutuTheme.ink)
                                .lineLimit(3)
                                .textSelection(.enabled)
                        }
                    }
                    .padding(.vertical, 7)
                    Divider()
                }
                if evidence.count < ids.count {
                    Text("\(ids.count - evidence.count) 条历史证据未保存可读详情")
                        .font(FutuTheme.metricNote)
                        .foregroundStyle(FutuTheme.amber)
                }
            }
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

    private func sourceLabel(_ source: String) -> String {
        switch source.uppercased() {
        case "SEC": "SEC 官方申报"
        case "FINRA": "FINRA 官方成交"
        case "FUTU": "富途 OpenD"
        case "LONGBRIDGE": "Longbridge"
        default: "其他数据源"
        }
    }

    private func evidenceValue(_ evidence: QuantitativeEvidence) -> String {
        guard case .number(let value) = evidence.value else {
            return evidence.value.displayText
        }
        if evidence.title.contains("市盈率") {
            return String(format: "%.2f 倍", value)
        }
        if evidence.title.contains("趋势")
            || evidence.title.contains("占比")
            || evidence.title.contains("波动率")
            || evidence.title.contains("距 52 周") {
            return String(format: "%.2f%%", value)
        }
        return compactNumber(value)
    }

    private func compactNumber(_ value: Double) -> String {
        let absolute = abs(value)
        if absolute >= 1_000_000_000_000 {
            return String(format: "%.2f 万亿", value / 1_000_000_000_000)
        }
        if absolute >= 100_000_000 {
            return String(format: "%.2f 亿", value / 100_000_000)
        }
        if absolute >= 10_000 {
            return String(format: "%.2f 万", value / 10_000)
        }
        return String(format: "%.2f", value)
    }

    private func displayDate(_ value: String) -> String {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = fractional.date(from: value)
            ?? ISO8601DateFormatter().date(from: value) else { return "日期不可用" }
        return date.formatted(date: .abbreviated, time: .omitted)
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
