import ChangFuDomain
import SwiftUI

struct ProviderPoolManagerView: View {
    @Bindable var state: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var providerId = ""
    @State private var query = ""
    @State private var market: BrokerMarket = .us
    @State private var discoveryMode: DiscoveryMode = .security
    @State private var selectedExpiry = ""
    @State private var optionSide: OptionSide = .all
    @State private var underlyingSymbol = ""
    @State private var pendingRemoval: ProviderPoolItem?

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            Divider()
            if let message = state.providerPoolStatusMessage {
                statusBanner(message)
            }
            HSplitView {
                currentPoolPane
                    .frame(minWidth: 360, idealWidth: 420)
                discoveryPane
                    .frame(minWidth: 560)
            }
        }
        .background(FutuTheme.canvas)
        .task {
            if state.providerPoolSummaries.isEmpty {
                await state.refreshProviderPools()
            }
            if providerId.isEmpty {
                providerId = preferredProviderId
            }
        }
        .onChange(of: providerId) { _, _ in
            query = ""
            selectedExpiry = ""
            underlyingSymbol = ""
        }
        .alert(
            "移除标的？",
            isPresented: Binding(
                get: { pendingRemoval != nil },
                set: { if !$0 { pendingRemoval = nil } }
            ),
            presenting: pendingRemoval
        ) { item in
            Button("移除", role: .destructive) {
                Task {
                    await state.removeProviderPoolItem(
                        providerId: item.providerId,
                        itemId: item.itemId
                    )
                    pendingRemoval = nil
                }
            }
            Button("取消", role: .cancel) {
                pendingRemoval = nil
            }
        } message: { item in
            Text("移除 \(item.providerSymbol) 将计入本期替换额度。")
        }
    }

    private var toolbar: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Provider 标的池")
                    .font(FutuTheme.panelTitle)
                    .foregroundStyle(FutuTheme.ink)
                Text("Futu 与 Longbridge 代码、容量和替换额度分别管理")
                    .font(FutuTheme.panelSubtitle)
                    .foregroundStyle(FutuTheme.inkMuted)
            }
            Spacer(minLength: 0)
            Picker("券商", selection: $providerId) {
                ForEach(state.providerPoolSummaries) { summary in
                    Text(providerName(summary.providerId)).tag(summary.providerId)
                }
            }
            .labelsHidden()
            .pickerStyle(.segmented)
            .frame(width: 250)
            Button {
                Task { await state.refreshProviderPools(force: true) }
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.bordered)
            .disabled(state.isProviderPoolLoading)
            .help("重新加载全部分页")
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
            }
            .buttonStyle(.bordered)
            .help("关闭")
        }
        .padding(16)
        .background(FutuTheme.surface)
    }

    private var currentPoolPane: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let pool {
                HStack(spacing: 18) {
                    metric("已用", "\(pool.entitlement.used)")
                    metric("容量", pool.entitlement.capacity.map(String.init) ?? "不限")
                    metric(
                        "替换",
                        replacementText(pool.entitlement)
                    )
                    Spacer(minLength: 0)
                    StatusPill(
                        text: state.providerPoolOnlineValidated && pool.entitlement.active
                            ? "可编辑"
                            : (state.providerPoolOnlineValidated ? "已冻结" : "缓存只读"),
                        color: state.providerPoolOnlineValidated && pool.entitlement.active
                            ? FutuTheme.loss
                            : FutuTheme.amber
                    )
                }
                .padding(.bottom, 2)

                HStack {
                    Text("池内标的")
                        .font(FutuTheme.bodyStrong)
                    Spacer()
                    Text("\(pool.items.count) 项")
                        .font(FutuTheme.metricNote)
                        .foregroundStyle(FutuTheme.inkMuted)
                }

                if pool.items.isEmpty {
                    DataUnavailableView(text: "当前券商标的池为空")
                } else {
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(pool.items) { item in
                                poolItemRow(item, editable: pool.entitlement.active)
                                if item.id != pool.items.last?.id {
                                    Divider()
                                }
                            }
                        }
                    }
                }
            } else {
                DataUnavailableView(text: "该券商尚无有效标的池")
            }
        }
        .padding(16)
        .background(FutuTheme.surface)
    }

    private var discoveryPane: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Picker("类型", selection: $discoveryMode) {
                    ForEach(DiscoveryMode.allCases) { mode in
                        Label(mode.title, systemImage: mode.systemImage).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .frame(width: 220)
                Picker("市场", selection: $market) {
                    ForEach(BrokerMarket.allCases, id: \.rawValue) {
                        Text($0.rawValue).tag($0)
                    }
                }
                .labelsHidden()
                .frame(width: 85)
                TextField(
                    discoveryMode == .security
                        ? "代码、中文名或英文名"
                        : "期权标的代码、中文名或英文名",
                    text: $query
                )
                .textFieldStyle(.roundedBorder)
                .onSubmit { search() }
                Button(action: search) {
                    Image(systemName: "magnifyingglass")
                }
                .buttonStyle(.borderedProminent)
                .tint(FutuTheme.orange)
                .disabled(
                    query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        || state.isInstrumentDiscoveryLoading
                        || !state.providerPoolOnlineValidated
                        || pool?.entitlement.active != true
                )
                .help("搜索 \(providerName(providerId))")
            }

            if state.isInstrumentDiscoveryLoading {
                ProgressView()
                    .controlSize(.small)
            }

            if discoveryMode == .option, !state.optionExpiries.isEmpty {
                HStack(spacing: 10) {
                    Picker("到期日", selection: $selectedExpiry) {
                        ForEach(state.optionExpiries) { expiry in
                            Text(expiry.expiryDate).tag(expiry.expiryDate)
                        }
                    }
                    .frame(width: 180)
                    Button {
                        guard !underlyingSymbol.isEmpty, !selectedExpiry.isEmpty else { return }
                        Task {
                            await state.loadProviderOptionChain(
                                providerId: providerId,
                                underlyingSymbol: underlyingSymbol,
                                expiryDate: selectedExpiry
                            )
                        }
                    } label: {
                        Label("加载期权链", systemImage: "list.bullet.rectangle")
                    }
                    .buttonStyle(.bordered)
                    Picker("方向", selection: $optionSide) {
                        ForEach(OptionSide.allCases) { side in
                            Text(side.title).tag(side)
                        }
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 170)
                    Spacer()
                }
            }

            Divider()

            HStack {
                Text(discoveryMode == .security ? "搜索结果" : "期权合约")
                    .font(FutuTheme.bodyStrong)
                Spacer()
                Text(resultCountText)
                    .font(FutuTheme.metricNote)
                    .foregroundStyle(FutuTheme.inkMuted)
            }

            ScrollView {
                LazyVStack(spacing: 0) {
                    if discoveryMode == .security {
                        ForEach(searchResults) { instrument in
                            instrumentRow(instrument)
                            Divider()
                        }
                    } else if !filteredOptionContracts.isEmpty {
                        ForEach(filteredOptionContracts) { contract in
                            optionRow(contract)
                            Divider()
                        }
                    } else {
                        ForEach(searchResults) { instrument in
                            underlyingRow(instrument)
                            Divider()
                        }
                    }
                }
            }
        }
        .padding(16)
        .background(FutuTheme.canvas)
    }

    private func poolItemRow(_ item: ProviderPoolItem, editable: Bool) -> some View {
        HStack(spacing: 10) {
            instrumentTypeIcon(item.instrumentType)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.providerSymbol)
                    .font(FutuTheme.bodyStrong)
                    .lineLimit(1)
                Text(item.displayName)
                    .font(FutuTheme.metricNote)
                    .foregroundStyle(FutuTheme.inkMuted)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            Text(item.instrumentType.rawValue)
                .font(FutuTheme.metricNote)
                .foregroundStyle(FutuTheme.inkMuted)
            Button {
                pendingRemoval = item
            } label: {
                Image(systemName: "trash")
            }
            .buttonStyle(.borderless)
            .foregroundStyle(FutuTheme.rose)
            .disabled(!editable || !canRemove)
            .help(canRemove ? "移除标的" : "本期替换额度已用尽")
        }
        .frame(height: 48)
    }

    private func instrumentRow(_ instrument: BrokerInstrument) -> some View {
        HStack(spacing: 10) {
            instrumentTypeIcon(instrument.instrumentType)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(instrument.providerSymbol)
                    .font(FutuTheme.bodyStrong)
                Text(instrument.displayName)
                    .font(FutuTheme.metricNote)
                    .foregroundStyle(FutuTheme.inkMuted)
                    .lineLimit(1)
            }
            Spacer()
            Text("\(instrument.market.rawValue) · \(instrument.instrumentType.rawValue)")
                .font(FutuTheme.metricNote)
                .foregroundStyle(FutuTheme.inkMuted)
            Button {
                Task {
                    await state.addProviderPoolInstrument(
                        providerId: providerId,
                        instrument: instrument
                    )
                }
            } label: {
                Image(systemName: isInPool(instrument.providerSymbol) ? "checkmark" : "plus")
            }
            .buttonStyle(.bordered)
            .disabled(!canAdd(instrument.providerSymbol) || !instrument.addable)
            .help(instrument.unavailableReason ?? "加入当前 Provider 标的池")
        }
        .frame(height: 48)
    }

    private func underlyingRow(_ instrument: BrokerInstrument) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "chart.xyaxis.line")
                .foregroundStyle(FutuTheme.orange)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(instrument.providerSymbol)
                    .font(FutuTheme.bodyStrong)
                Text(instrument.displayName)
                    .font(FutuTheme.metricNote)
                    .foregroundStyle(FutuTheme.inkMuted)
            }
            Spacer()
            Button {
                underlyingSymbol = instrument.providerSymbol
                Task {
                    await state.loadProviderOptionExpiries(
                        providerId: providerId,
                        underlyingSymbol: instrument.providerSymbol
                    )
                    selectedExpiry = state.optionExpiries.first?.expiryDate ?? ""
                }
            } label: {
                Label("到期日", systemImage: "calendar")
            }
            .buttonStyle(.bordered)
            .disabled(!instrument.addable)
        }
        .frame(height: 48)
    }

    private func optionRow(_ contract: BrokerOptionContract) -> some View {
        HStack(spacing: 10) {
            Text(contract.optionType == .call ? "CALL" : "PUT")
                .font(FutuTheme.metricNote.weight(.semibold))
                .foregroundStyle(contract.optionType == .call ? FutuTheme.profit : FutuTheme.loss)
                .frame(width: 36)
            VStack(alignment: .leading, spacing: 2) {
                Text(contract.providerSymbol)
                    .font(FutuTheme.bodyStrong)
                    .lineLimit(1)
                Text("\(contract.expiryDate) · \(contract.strikePrice)")
                    .font(FutuTheme.metricNote)
                    .foregroundStyle(FutuTheme.inkMuted)
            }
            Spacer()
            Text("研究可用")
                .font(FutuTheme.metricNote)
                .foregroundStyle(FutuTheme.inkMuted)
            Button {
                Task {
                    await state.addProviderPoolOption(
                        providerId: providerId,
                        contract: contract
                    )
                }
            } label: {
                Image(systemName: isInPool(contract.providerSymbol) ? "checkmark" : "plus")
            }
            .buttonStyle(.bordered)
            .disabled(!canAdd(contract.providerSymbol) || !contract.addable)
            .help(contract.unavailableReason ?? "加入当前 Provider 标的池")
        }
        .frame(height: 48)
    }

    private var pool: ProviderPool? {
        state.providerPools[providerId]
    }

    private var preferredProviderId: String {
        let preferred = state.platform == .longbridge ? "LONGBRIDGE" : "FUTU"
        return state.providerPoolSummaries.contains { $0.providerId == preferred }
            ? preferred
            : state.providerPoolSummaries.first?.providerId ?? ""
    }

    private var searchResults: [BrokerInstrument] {
        state.instrumentSearchResults.filter { $0.providerId == providerId }
    }

    private var filteredOptionContracts: [BrokerOptionContract] {
        state.optionContracts.filter {
            $0.providerId == providerId && optionSide.matches($0.optionType)
        }
    }

    private var resultCountText: String {
        let count = discoveryMode == .security
            ? searchResults.count
            : (state.optionContracts.isEmpty ? searchResults.count : filteredOptionContracts.count)
        return "\(count) 项"
    }

    private var canRemove: Bool {
        guard let entitlement = pool?.entitlement else { return false }
        return state.providerPoolOnlineValidated && (
            entitlement.replacementLimit == nil
            || entitlement.replacementUsed < (entitlement.replacementLimit ?? 0)
        )
    }

    private func canAdd(_ symbol: String) -> Bool {
        guard state.providerPoolOnlineValidated,
              let pool, pool.entitlement.active, !isInPool(symbol) else { return false }
        return pool.entitlement.capacity == nil
            || pool.entitlement.used < (pool.entitlement.capacity ?? 0)
    }

    private func isInPool(_ providerSymbol: String) -> Bool {
        pool?.items.contains { $0.providerSymbol == providerSymbol } == true
    }

    private func search() {
        Task {
            await state.searchProviderInstruments(
                providerId: providerId,
                query: query,
                markets: [market],
                instrumentTypes: [.stock, .etf]
            )
        }
    }

    private func providerName(_ id: String) -> String {
        state.subscriptionCatalog?.providers.first { $0.providerId == id }?.displayName ?? id
    }

    private func replacementText(_ entitlement: ProviderPoolEntitlement) -> String {
        guard let limit = entitlement.replacementLimit else { return "不限" }
        return "\(entitlement.replacementUsed) / \(limit)"
    }

    private func metric(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(FutuTheme.metricNote)
                .foregroundStyle(FutuTheme.inkMuted)
            Text(value)
                .font(FutuTheme.bodyStrong)
                .foregroundStyle(FutuTheme.ink)
        }
    }

    private func statusBanner(_ message: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "info.circle.fill")
                .foregroundStyle(FutuTheme.orange)
            Text(message)
                .font(FutuTheme.body)
                .foregroundStyle(FutuTheme.ink)
            Spacer()
        }
        .padding(.horizontal, 16)
        .frame(height: 38)
        .background(FutuTheme.orangeSoft)
    }

    private func instrumentTypeIcon(_ type: BrokerInstrumentType) -> some View {
        Image(systemName: type == .option ? "option" : (type == .etf ? "square.grid.2x2" : "chart.line.uptrend.xyaxis"))
            .foregroundStyle(FutuTheme.orange)
    }
}

private enum DiscoveryMode: String, CaseIterable, Identifiable {
    case security
    case option

    var id: String { rawValue }
    var title: String { self == .security ? "正股 / ETF" : "CALL / PUT" }
    var systemImage: String { self == .security ? "chart.line.uptrend.xyaxis" : "option" }
}

private enum OptionSide: String, CaseIterable, Identifiable {
    case all
    case call
    case put

    var id: String { rawValue }
    var title: String {
        switch self {
        case .all: "全部"
        case .call: "CALL"
        case .put: "PUT"
        }
    }

    func matches(_ type: BrokerOptionType) -> Bool {
        self == .all || (self == .call && type == .call) || (self == .put && type == .put)
    }
}
