import ChangFuDomain
import AppKit
import SwiftUI

struct SellPutReportModule: View {
    @Bindable var state: AppState
    @State private var detailSelection: SellPutDetailSelection?
    @State private var isMarkdownPresented = false

    var body: some View {
        HStack(alignment: .top, spacing: FutuTheme.sectionSpacing) {
            reportColumn
                .frame(maxWidth: .infinity)
            historyColumn
                .frame(width: 250)
        }
        .sheet(item: $detailSelection) { selection in
            SellPutReportDetailSheet(item: selection.item)
        }
        .sheet(isPresented: $isMarkdownPresented) {
            if let report = state.sellPutReport {
                SellPutMarkdownSheet(report: report)
            }
        }
    }

    private var reportColumn: some View {
        VStack(alignment: .leading, spacing: 16) {
            reportHeader
            if let report = state.sellPutReport {
                if rateLimitedSymbolCount(report) > 0 {
                    historicalRateLimitNotice(report)
                }
                opportunitySection(report)
                riskSection(report)
                detailSection(report)
            } else {
                DataUnavailableView(text: "尚无报告，请从研究页的 SELL PUT 期权研究模块执行")
                    .frame(maxWidth: .infinity, minHeight: 180)
            }
        }
    }

    private var reportHeader: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("SELL PUT 30 日报告")
                        .font(FutuTheme.panelTitle)
                    Text("长富Pro · Top30 Prompt v3")
                        .font(FutuTheme.pageSubtitle)
                        .foregroundStyle(FutuTheme.inkMuted)
                }
                Spacer()
                if let report = state.sellPutReport {
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
                        text: report.dataQuality.isUsableForAnalysis ? "可生成候选" : "数据不足",
                        color: report.dataQuality.isUsableForAnalysis
                            ? FutuTheme.loss
                            : FutuTheme.amber
                    )
                }
            }
            if let report = state.sellPutReport {
                HStack(spacing: 10) {
                    Label(
                        "生成于 \(displayTime(report.startedAt))",
                        systemImage: "clock"
                    )
                    Spacer(minLength: 8)
                    Text("\(report.symbolCount) 标的")
                    Text("\(report.candidateCount) 候选")
                    Text("\(report.dataGapCount) 缺口")
                }
                .font(FutuTheme.metricNote)
                .foregroundStyle(FutuTheme.inkMuted)
            }
        }
    }

    private func historicalRateLimitNotice(_ report: SellPutReport) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(FutuTheme.amber)
            Text(
                "此历史报告有 \(rateLimitedSymbolCount(report)) 个标的因 OpenD 高频限制采集失败，"
                    + "生成于分批限流修复前。请从研究页重新执行，勿将本报告视为当前数据结果。"
            )
            .font(FutuTheme.body)
            .foregroundStyle(FutuTheme.ink)
            Spacer(minLength: 0)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(FutuTheme.orangeSoft.opacity(0.72))
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }

    private func opportunitySection(_ report: SellPutReport) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Top 5 候选").font(FutuTheme.panelTitle)
            if report.summary?.topOpportunities.isEmpty != false {
                Text("没有同时满足期权链、希腊值、流动性和风险门槛的候选")
                    .font(FutuTheme.body)
                    .foregroundStyle(FutuTheme.inkMuted)
            } else {
                analysisTable(report.summary?.topOpportunities ?? [])
            }
        }
        .padding(.vertical, 12)
        .overlay(alignment: .bottom) { Divider() }
    }

    private func riskSection(_ report: SellPutReport) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Bottom 5 风险").font(FutuTheme.panelTitle)
            analysisTable(report.summary?.bottomRisks ?? [])
        }
        .padding(.vertical, 12)
        .overlay(alignment: .bottom) { Divider() }
    }

    private func detailSection(_ report: SellPutReport) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("逐标的明细").font(FutuTheme.panelTitle)
                Spacer()
                Text("点击详情查看完整指标、风险和退出条件")
                    .font(FutuTheme.metricNote)
                    .foregroundStyle(FutuTheme.inkMuted)
            }
            analysisTable(report.items.map(\.analysis))
        }
    }

    private func analysisTable(_ items: [SellPutItemAnalysis]) -> some View {
        ScrollView(.horizontal) {
            VStack(spacing: 0) {
                analysisTableHeader
                ForEach(Array(items.enumerated()), id: \.element.symbol) { index, item in
                    Button {
                        detailSelection = SellPutDetailSelection(item: item)
                    } label: {
                        analysisTableRow(item, index: index)
                    }
                    .buttonStyle(.plain)
                    if index < items.count - 1 {
                        Divider()
                    }
                }
            }
            .frame(minWidth: 680)
            .overlay {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .stroke(FutuTheme.lineSoft, lineWidth: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        }
        .frame(maxWidth: .infinity)
    }

    private var analysisTableHeader: some View {
        HStack(spacing: 10) {
            tableHeader("标的", width: 100, alignment: .leading)
            tableHeader("状态", width: 62, alignment: .leading)
            tableHeader("到期日", width: 100, alignment: .leading)
            tableHeader("行权价", width: 78, alignment: .trailing)
            tableHeader("安全边际", width: 78, alignment: .trailing)
            tableHeader("年化收益", width: 78, alignment: .trailing)
            tableHeader("IV", width: 66, alignment: .trailing)
            Spacer(minLength: 0)
            Image(systemName: "info.circle")
                .frame(width: 20)
        }
        .padding(.horizontal, 10)
        .frame(height: 34)
        .background(FutuTheme.surfaceMuted)
    }

    private func analysisTableRow(_ item: SellPutItemAnalysis, index: Int) -> some View {
        HStack(spacing: 10) {
            Text(item.symbol)
                .font(FutuTheme.tableCell.weight(.semibold))
                .frame(width: 100, alignment: .leading)
                .lineLimit(1)
            Text(item.candidate ? "候选" : item.liquidity)
                .font(FutuTheme.tableCell)
                .foregroundStyle(item.candidate ? FutuTheme.loss : FutuTheme.inkMuted)
                .frame(width: 62, alignment: .leading)
                .lineLimit(1)
            Text(item.expiryDate ?? "无到期日")
                .font(FutuTheme.tableCell)
                .foregroundStyle(item.expiryDate == nil ? FutuTheme.rose : FutuTheme.ink)
                .frame(width: 100, alignment: .leading)
                .lineLimit(1)
            Text(money(item.strikePrice))
                .frame(width: 78, alignment: .trailing)
            Text(percent(item.safetyMarginPercent))
                .frame(width: 78, alignment: .trailing)
            Text(percent(item.annualizedReturnPercent))
                .foregroundStyle(item.candidate ? FutuTheme.loss : FutuTheme.inkMuted)
                .frame(width: 78, alignment: .trailing)
            Text(percent(item.impliedVolatility))
                .frame(width: 66, alignment: .trailing)
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(FutuTheme.inkMuted)
                .frame(width: 20)
        }
        .font(FutuTheme.tableCell)
        .padding(.horizontal, 10)
        .frame(height: 38)
        .background(index.isMultiple(of: 2) ? FutuTheme.surface : FutuTheme.surfaceMuted.opacity(0.48))
        .contentShape(Rectangle())
    }

    private var historyColumn: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("历史报告").font(FutuTheme.panelTitle)
            LazyVStack(spacing: 4) {
                ForEach(state.sellPutReportHistory) { report in
                    Button {
                        Task { await state.loadSellPutReport(report.runId) }
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(displayTime(report.startedAt))
                                .font(FutuTheme.bodyStrong)
                            Text(
                                "\(report.symbolCount) 标的 · \(report.candidateCount) 候选"
                                    + " · \(report.dataGapCount) 缺口"
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
        .padding(14)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(FutuTheme.surfaceMuted)
    }

    private func tableHeader(
        _ title: String,
        width: CGFloat,
        alignment: Alignment
    ) -> some View {
        Text(title)
            .font(FutuTheme.tableHeader)
            .foregroundStyle(FutuTheme.inkMuted)
            .frame(width: width, alignment: alignment)
    }

    private func money(_ value: Double?) -> String {
        value.map { String(format: "$%.2f", $0) } ?? "不可用"
    }

    private func percent(_ value: Double?) -> String {
        value.map { String(format: "%.2f%%", $0) } ?? "不可用"
    }

    private func number(_ value: Double?) -> String {
        value.map { String(format: "%.2f", $0) } ?? "不可用"
    }

    private func displayTime(_ value: String) -> String {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = fractional.date(from: value)
            ?? ISO8601DateFormatter().date(from: value) else { return value }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    private func rateLimitedSymbolCount(_ report: SellPutReport) -> Int {
        report.items.filter { item in
            (item.sourceSnapshot.dataGaps + item.analysis.dataGaps).contains { gap in
                let normalized = gap.lowercased()
                return normalized.contains("high frequency")
                    || normalized.contains("maximum 10 times per 30 seconds")
                    || gap.contains("请求过于频繁")
            }
        }.count
    }

    private func exportMarkdown(_ report: SellPutReport) {
        guard let markdown = report.markdown else { return }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.plainText]
        panel.nameFieldStringValue = "sell-put-30d-\(report.runId).md"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        try? markdown.write(to: url, atomically: true, encoding: .utf8)
    }
}

private struct SellPutDetailSelection: Identifiable {
    let item: SellPutItemAnalysis
    var id: String { item.symbol }
}

private struct SellPutReportDetailSheet: View {
    @Environment(\.dismiss) private var dismiss
    let item: SellPutItemAnalysis

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.symbol).font(FutuTheme.pageTitle)
                    Text(item.displayName)
                        .font(FutuTheme.pageSubtitle)
                        .foregroundStyle(FutuTheme.inkMuted)
                }
                Spacer()
                StatusPill(
                    text: item.candidate ? "候选" : item.liquidity,
                    color: item.candidate ? FutuTheme.loss : FutuTheme.amber
                )
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
                    LazyVGrid(
                        columns: Array(repeating: GridItem(.flexible(), spacing: 16), count: 4),
                        alignment: .leading,
                        spacing: 14
                    ) {
                        metric("到期日", item.expiryDate ?? "无到期日")
                        metric("现价", money(item.currentPrice))
                        metric("行权价", money(item.strikePrice))
                        metric("权利金", money(item.premium))
                        metric("安全边际", percent(item.safetyMarginPercent))
                        metric("年化收益", percent(item.annualizedReturnPercent))
                        metric("Delta", number(item.delta))
                        metric("IV", percent(item.impliedVolatility))
                        metric("买卖价差", percent(item.bidAskSpreadPercent))
                        metric("成交量", number(item.volume))
                        metric("未平仓量", number(item.openInterest))
                        metric("现金占用", money(item.cashRequired))
                    }
                    Divider()
                    detailSection("数据缺口", values: item.dataGaps, color: FutuTheme.rose)
                    detailSection("风险", values: item.risks, color: FutuTheme.ink)
                    detailSection("退出条件", values: item.exitConditions, color: FutuTheme.ink)
                }
                .padding(20)
            }
        }
        .frame(minWidth: 760, minHeight: 560)
        .background(FutuTheme.canvas)
    }

    private func metric(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(FutuTheme.metricNote).foregroundStyle(FutuTheme.inkMuted)
            Text(value).font(FutuTheme.bodyStrong).lineLimit(1)
        }
    }

    @ViewBuilder
    private func detailSection(_ title: String, values: [String], color: Color) -> some View {
        if !values.isEmpty {
            VStack(alignment: .leading, spacing: 7) {
                Text(title).font(FutuTheme.panelTitle)
                ForEach(values, id: \.self) { value in
                    Text("• \(value)")
                        .font(FutuTheme.body)
                        .foregroundStyle(color)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func money(_ value: Double?) -> String {
        value.map { String(format: "$%.2f", $0) } ?? "不可用"
    }
    private func percent(_ value: Double?) -> String {
        value.map { String(format: "%.2f%%", $0) } ?? "不可用"
    }
    private func number(_ value: Double?) -> String {
        value.map { String(format: "%.2f", $0) } ?? "不可用"
    }
}

private struct SellPutMarkdownSheet: View {
    @Environment(\.dismiss) private var dismiss
    let report: SellPutReport

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("SELL PUT 完整报告").font(FutuTheme.panelTitle)
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
