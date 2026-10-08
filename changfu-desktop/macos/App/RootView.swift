import ChangFuDomain
import SwiftUI

struct RootView: View {
    @Bindable var state: AppState

    var body: some View {
        ZStack {
            VStack(spacing: 0) {
                topBar
                Divider()
                HStack(spacing: 0) {
                    navigation
                        .layoutPriority(2)
                    Divider()
                    workspace
                        .frame(minWidth: 0, maxWidth: .infinity)
                        .layoutPriority(1)
                    if !isGlobalWorkspaceOpen && !state.isConversationCollapsed {
                        Divider()
                        conversation
                            .frame(minWidth: 300, idealWidth: state.conversationWidth, maxWidth: 560)
                            .layoutPriority(2)
                    }
                }
            }
            .background(FutuTheme.canvas)
            .ignoresSafeArea()

            if state.startupAd != nil {
                StartupAdView(remainingSeconds: state.startupAdRemainingSeconds) {
                    state.dismissStartupAd()
                }
                .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.18), value: state.startupAd != nil)
        .tint(FutuTheme.orange)
        .onChange(of: state.platform) {
            guard state.platform.isAvailable else { return }
            Task { await state.refreshCurrentBrokerData() }
        }
        .sheet(isPresented: $state.isSettingsOpen) {
            SettingsView(state: state)
        }
    }

    private var topBar: some View {
        HStack(spacing: 16) {
            Text("长富")
                .font(.system(size: 22, weight: .bold))
                .foregroundStyle(FutuTheme.ink)
                .frame(width: 128, alignment: .leading)

            Picker("交易平台", selection: $state.platform) {
                ForEach(TradingPlatform.allCases) { platform in
                    Text(platform.title).tag(platform)
                }
            }
            .pickerStyle(.segmented)
            .frame(width: 360)

            Spacer()

            if !isGlobalWorkspaceOpen {
                statusLabel(
                    state.currentMarket.map { "\($0.name)：\($0.state)" } ?? "市场待同步",
                    color: marketStatusColor
                )
                statusLabel(state.currentConnectionLabel, color: brokerStatusColor)
                readOnlyDeviceLabel

                Button {
                    state.isConversationCollapsed.toggle()
                } label: {
                    Image(systemName: "sidebar.right")
                }
                .buttonStyle(.borderless)
                .help(state.isConversationCollapsed ? "展开模型对话" : "收起模型对话")
            }

            Menu {
                Button("Longbridge 连接") {
                    state.isSettingsOpen = true
                }
                Button("退出登录", role: .destructive) {
                    Task { await state.logout() }
                }
            } label: {
                Image(systemName: "gearshape")
            }
            .help("设置")
        }
        .padding(.leading, 112)
        .padding(.trailing, 20)
        .padding(.top, 10)
        .frame(height: 70)
        .background(FutuTheme.surface)
    }

    private var navigation: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(state.platform.title)
                .font(FutuTheme.metricLabel)
                .foregroundStyle(FutuTheme.inkMuted)
                .padding(.horizontal, 14)
                .padding(.top, 14)

            if state.platform.isAvailable {
                ForEach(FutuWorkspace.allCases) { item in
                    Button {
                        state.isSubscriptionCenterOpen = false
                        state.isModelCenterOpen = false
                        state.workspace = item
                    } label: {
                        Label(item.title, systemImage: item.systemImage)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 12)
                            .frame(height: 38)
                            .background(
                                !isGlobalWorkspaceOpen && state.workspace == item
                                    ? FutuTheme.orangeSoft
                                    : Color.clear
                            )
                            .foregroundStyle(
                                !isGlobalWorkspaceOpen && state.workspace == item
                                    ? FutuTheme.orange
                                    : FutuTheme.ink
                            )
                            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    }
                    .buttonStyle(.plain)
                }
            } else {
                ContentUnavailableView(
                    "规划中",
                    systemImage: "hammer",
                    description: Text("当前平台尚未接入真实能力")
                )
                .frame(maxHeight: .infinity)
            }
            Spacer()
            Divider()
                .padding(.vertical, 6)
            Button {
                state.isSubscriptionCenterOpen = false
                state.isModelCenterOpen = true
            } label: {
                Label("模型", systemImage: "cpu")
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .frame(height: 38)
                    .background(
                        state.isModelCenterOpen ? FutuTheme.orangeSoft : Color.clear
                    )
                    .foregroundStyle(
                        state.isModelCenterOpen ? FutuTheme.orange : FutuTheme.ink
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            .buttonStyle(.plain)
            .help("管理全局对话模型")
            Button {
                state.isModelCenterOpen = false
                state.isSubscriptionCenterOpen = true
            } label: {
                Label("套餐", systemImage: "creditcard")
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .frame(height: 38)
                    .background(
                        state.isSubscriptionCenterOpen ? FutuTheme.orangeSoft : Color.clear
                    )
                    .foregroundStyle(
                        state.isSubscriptionCenterOpen ? FutuTheme.orange : FutuTheme.ink
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            .buttonStyle(.plain)
            .help("查看全局套餐与支付方式")
        }
        .padding(.horizontal, 8)
        .frame(width: 184)
        .fixedSize(horizontal: true, vertical: false)
        .background(FutuTheme.surface)
    }

    @ViewBuilder
    private var workspace: some View {
        if state.isModelCenterOpen {
            GlobalModelWorkspace(state: state)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if state.isSubscriptionCenterOpen {
            SubscriptionWorkspace(state: state)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if !state.platform.isAvailable {
            ContentUnavailableView(
                "\(state.platform.title) 规划中",
                systemImage: "calendar.badge.clock",
                description: Text("当前平台尚未接入真实能力")
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            VStack(spacing: 0) {
                MarketStatusBanner(state: state)
                FutuWorkspaceView(state: state)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var conversation: some View {
        ConversationView(state: state) {
            state.isConversationCollapsed = true
        }
    }

    private var isGlobalWorkspaceOpen: Bool {
        state.isSubscriptionCenterOpen || state.isModelCenterOpen
    }

    private var brokerStatusColor: Color {
        state.isCurrentBrokerConnected ? FutuTheme.loss : FutuTheme.inkMuted
    }

    private var marketStatusColor: Color {
        state.currentMarket == nil ? FutuTheme.inkMuted : FutuTheme.orange
    }

    private func statusLabel(_ text: String, color: Color) -> some View {
        HStack(spacing: 6) {
            Circle()
                .fill(color)
                .frame(width: 7, height: 7)
            Text(text)
                .font(FutuTheme.metricNote)
                .lineLimit(1)
        }
    }

    private var readOnlyDeviceLabel: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(Color.secondary)
                .frame(width: 7, height: 7)
            Text("只读设备")
                .font(FutuTheme.metricNote)
                .lineLimit(1)
                .onTapGesture(count: 5) {
                    Task { await state.enableDebugMode() }
                }
        }
    }
}

private struct MarketStatusBanner: View {
    @Bindable var state: AppState

    var body: some View {
        HStack(spacing: 16) {
            Label(
                state.currentMarket.map { "\($0.name)：\($0.state)" } ?? "市场状态：待同步",
                systemImage: "clock"
            )
            Label(state.currentConnectionLabel, systemImage: "network")
            Label(
                "交易租约：\(state.currentTradingLeaseLabel)",
                systemImage: "lock.shield"
            )
            if let updatedAt = state.currentBrokerLastUpdatedAt {
                Text("更新于 \(updatedAt.formatted(date: .omitted, time: .standard))")
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if state.platform == .longbridge, !state.isCurrentBrokerConnected {
                Button {
                    state.isSettingsOpen = true
                } label: {
                    Label("配置", systemImage: "key")
                }
                .help("配置 Longbridge API 凭据")
            }
            Button {
                Task { await state.refreshCurrentBrokerData() }
            } label: {
                if state.isRefreshingCurrentBroker {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Label("刷新", systemImage: "arrow.clockwise")
                }
            }
            .disabled(state.isRefreshingCurrentBroker)
            .help("重新连接当前券商并刷新账户数据")
        }
        .font(FutuTheme.body)
        .padding(.horizontal, 18)
        .frame(height: 44)
        .foregroundStyle(FutuTheme.ink)
        .background(FutuTheme.orangeSoft.opacity(0.76))
        .overlay(alignment: .bottom) {
            Rectangle().fill(FutuTheme.line).frame(height: 1)
        }
    }
}

private struct ConversationView: View {
    @Bindable var state: AppState
    let close: () -> Void
    @State private var draft = ""

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("模型对话").font(FutuTheme.panelTitle)
                    Text("全局能力 · \(state.conversationResearchSymbols.count) 个标的")
                        .font(FutuTheme.panelSubtitle)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Picker("模型", selection: $state.selectedConversationModelRoute) {
                    ForEach(state.conversationModelOptions) { option in
                        Text(option.displayName).tag(option.id)
                    }
                }
                .labelsHidden()
                .frame(width: 150)
                .disabled(state.isSendingMessage)
                .help("选择本轮对话使用的模型")
                Button(action: close) {
                    Image(systemName: "chevron.right")
                }
                .buttonStyle(.borderless)
                .help("收起模型对话")
            }
            .padding(14)
            Divider()

            if state.conversationMessages.isEmpty {
                ContentUnavailableView(
                    "开始对话",
                    systemImage: "sparkles",
                    description: Text("直接提问，输入 @ 添加本轮能力，输入 / 选择研究标的")
                )
                .frame(maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(state.conversationMessages) { message in
                            conversationMessage(message)
                        }
                        if state.isSendingMessage {
                            HStack(spacing: 8) {
                                ProgressView().controlSize(.small)
                                Text("正在分析")
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    .padding(14)
                }
                .frame(maxHeight: .infinity)
            }

            VStack(spacing: 0) {
                if let query = mentionQuery {
                    mentionSuggestions(query: query)
                    Divider()
                } else if let query = slashQuery {
                    slashSuggestions(query: query)
                    Divider()
                }
                if !draftCapabilities.isEmpty || !state.conversationResearchSymbols.isEmpty {
                    conversationContextBar
                    Divider()
                }
                HStack(alignment: .bottom, spacing: 8) {
                    TextField("输入问题，@ 添加能力，/ 选择标的", text: $draft, axis: .vertical)
                        .textFieldStyle(.plain)
                        .lineLimit(1...6)
                        .padding(10)
                        .background(Color(nsColor: .textBackgroundColor))
                        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                    Button(action: send) {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.title2)
                    }
                    .buttonStyle(.borderless)
                    .disabled(
                        state.isSendingMessage
                            || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    )
                    .help("发送")
                }
                .padding(12)
            }
        }
    }

    private var conversationContextBar: some View {
        VStack(alignment: .leading, spacing: 7) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(draftCapabilities) { capability in
                        Button {
                            removeMention(capability)
                        } label: {
                            Label(
                                "\(capability.kind.title) · \(capability.title)",
                                systemImage: "xmark.circle.fill"
                            )
                            .font(FutuTheme.metricNote)
                        }
                        .buttonStyle(.borderless)
                        .help("从本轮请求移除 \(capability.title)")
                    }

                    ForEach(state.conversationResearchSymbols.sorted(), id: \.self) { symbol in
                        Button {
                            state.toggleConversationResearchSymbol(symbol)
                        } label: {
                            Label(symbol, systemImage: "xmark.circle.fill")
                                .font(FutuTheme.metricNote)
                        }
                        .buttonStyle(.borderless)
                        .help("从当前对话移除 \(symbol)")
                    }
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(FutuTheme.surfaceMuted)
    }

    private var draftCapabilities: [ConversationCapability] {
        state.conversationCapabilities.filter { $0.isMentioned(in: draft) }
    }

    private var mentionQuery: String? {
        guard let marker = draft.lastIndex(of: "@") else { return nil }
        if marker != draft.startIndex {
            let previous = draft.index(before: marker)
            guard draft[previous].isWhitespace else { return nil }
        }
        let query = String(draft[draft.index(after: marker)...])
        guard !query.contains("\n"), !query.hasSuffix(" "), query.count <= 48 else {
            return nil
        }
        return query
    }

    private var slashQuery: String? {
        guard let token = draft.split(
            omittingEmptySubsequences: false,
            whereSeparator: \.isWhitespace
        ).last,
        token.first == "/" else {
            return nil
        }
        return String(token.dropFirst()).uppercased()
    }

    private func mentionSuggestions(query: String) -> some View {
        let matches = state.conversationCapabilities.filter {
            query.isEmpty
                || $0.title.localizedCaseInsensitiveContains(query)
                || $0.kind.title.contains(query)
        }
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(matches.prefix(8)) { capability in
                Button {
                    insertMention(capability)
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: capability.systemImage)
                            .frame(width: 18)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(capability.mention)
                                .font(FutuTheme.bodyStrong)
                            Text("\(capability.kind.title) · \(capability.detail)")
                                .font(FutuTheme.metricNote)
                                .foregroundStyle(FutuTheme.inkMuted)
                                .lineLimit(1)
                        }
                        Spacer()
                    }
                    .frame(height: 42)
                }
                .buttonStyle(.plain)
            }
            if matches.isEmpty {
                Text("没有匹配的技能、智能体或工具")
                    .font(FutuTheme.body)
                    .foregroundStyle(FutuTheme.inkMuted)
                    .padding(10)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(FutuTheme.surface)
    }

    private func slashSuggestions(query: String) -> some View {
        let matches = state.researchPool.filter {
            query.isEmpty
                || $0.symbol.uppercased().contains(query)
                || $0.displayName.contains(query)
        }
        return VStack(alignment: .leading, spacing: 0) {
            if query.isEmpty || "全部".contains(query) {
                slashSuggestionButton(
                    title: "/全部",
                    detail: "选择标的池内全部标的",
                    systemImage: "checkmark.square.fill"
                ) {
                    state.selectAllConversationResearchSymbols()
                    removeSlashToken()
                }
            }
            ForEach(matches.prefix(6)) { item in
                slashSuggestionButton(
                    title: "/\(item.symbol)",
                    detail: item.displayName,
                    systemImage: state.conversationResearchSymbols.contains(item.symbol)
                        ? "checkmark.square.fill"
                        : "square"
                ) {
                    state.toggleConversationResearchSymbol(item.symbol)
                    removeSlashToken()
                }
            }
            if matches.isEmpty && !(query.isEmpty || "全部".contains(query)) {
                Text("标的池内没有匹配项")
                    .font(FutuTheme.body)
                    .foregroundStyle(FutuTheme.inkMuted)
                    .padding(10)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(FutuTheme.surface)
    }

    private func slashSuggestionButton(
        title: String,
        detail: String,
        systemImage: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: systemImage)
                    .frame(width: 18)
                Text(title)
                    .font(FutuTheme.bodyStrong)
                Spacer()
                Text(detail)
                    .font(FutuTheme.metricNote)
                    .foregroundStyle(FutuTheme.inkMuted)
                    .lineLimit(1)
            }
            .frame(height: 34)
        }
        .buttonStyle(.plain)
    }

    private func removeSlashToken() {
        guard let slash = draft.lastIndex(of: "/") else { return }
        draft = String(draft[..<slash]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func insertMention(_ capability: ConversationCapability) {
        guard let marker = draft.lastIndex(of: "@") else { return }
        draft.replaceSubrange(marker..., with: "\(capability.mention) ")
    }

    private func removeMention(_ capability: ConversationCapability) {
        draft = draft.replacingOccurrences(of: capability.mention, with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    @ViewBuilder
    private func conversationMessage(_ message: ConversationMessage) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(message.role == .user ? "我" : "长富")
                .font(FutuTheme.metricNote.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(message.content)
                .font(FutuTheme.body)
                .lineSpacing(3)
                .textSelection(.enabled)
            if !message.evidence.isEmpty {
                Divider()
                Text("证据").font(FutuTheme.metricLabel)
                ForEach(message.evidence) { evidence in
                    Text("• \(evidence.summary)")
                        .font(FutuTheme.body)
                        .lineSpacing(3)
                        .foregroundStyle(.secondary)
                }
            }
            if !message.risks.isEmpty {
                Text("风险").font(FutuTheme.metricLabel)
                ForEach(message.risks, id: \.self) { risk in
                    Text("• \(risk)")
                        .font(FutuTheme.body)
                        .lineSpacing(3)
                        .foregroundStyle(.orange)
                }
            }
            if let exitCondition = message.exitCondition {
                Text("退出条件：\(exitCondition)")
                    .font(FutuTheme.body)
                    .lineSpacing(3)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(
            message.role == .user
                ? FutuTheme.orangeSoft
                : FutuTheme.surfaceMuted
        )
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func send() {
        let message = draft
        let capabilities = draftCapabilities
        draft = ""
        Task {
            await state.sendMessage(message, capabilities: capabilities)
        }
    }
}

private struct StartupAdView: View {
    let remainingSeconds: Int
    let dismiss: () -> Void

    var body: some View {
        ZStack {
            Color(nsColor: .windowBackgroundColor)
                .ignoresSafeArea()
            VStack(spacing: 18) {
                Text("长富")
                    .font(.system(size: 42, weight: .bold))
                Text("静态启动内容")
                    .font(.title3)
                    .foregroundStyle(.secondary)
                Button(action: dismiss) {
                    Label("跳过 \(remainingSeconds) 秒", systemImage: "forward.end")
                }
                .buttonStyle(.borderedProminent)
            }
        }
    }
}
