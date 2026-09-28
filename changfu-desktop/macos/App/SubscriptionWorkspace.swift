import ChangFuDomain
import SwiftUI

struct SubscriptionWorkspace: View {
    @Bindable var state: AppState
    @State private var billingPeriod: SubscriptionBillingPeriod = .monthly
    @State private var planProviderSelections: [String: Set<String>] = [:]
    @State private var slotProviderSelections: [String: String] = [:]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: FutuTheme.sectionSpacing) {
                header

                if let message = state.subscriptionStatusMessage {
                    statusBanner(message)
                }

                if let subscription = state.currentSubscription {
                    currentSubscriptionPanel(subscription)
                    brokerSlotsPanel(subscription)
                }

                if let catalog = state.subscriptionCatalog {
                    planCatalog(catalog)
                    if let order = state.currentSubscriptionOrder {
                        orderPanel(order, catalog: catalog)
                    }
                } else if state.isSubscriptionLoading {
                    ProgressView("正在读取套餐目录…")
                        .frame(maxWidth: .infinity, minHeight: 180)
                } else {
                    DataUnavailableView(text: "套餐目录暂不可用，请刷新后重试")
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(FutuTheme.canvas)
        .task {
            if state.subscriptionCatalog == nil {
                await state.refreshSubscriptionCenter()
            }
            initializeSelections()
        }
        .onChange(of: state.subscriptionCatalog) { _, _ in
            initializeSelections()
        }
        .onChange(of: state.currentSubscription) { _, _ in
            initializeSelections(resetPlans: true)
        }
    }

    private var header: some View {
        HStack(alignment: .bottom, spacing: 16) {
            VStack(alignment: .leading, spacing: 3) {
                Text("全局服务")
                    .font(FutuTheme.pageEyebrow)
                    .foregroundStyle(FutuTheme.orange)
                Text("套餐与券商额度")
                    .font(FutuTheme.pageTitle)
                    .foregroundStyle(FutuTheme.ink)
                Text("权益按账户生效；每个券商拥有独立标的池与容量")
                    .font(FutuTheme.pageSubtitle)
                    .foregroundStyle(FutuTheme.inkMuted)
            }
            Spacer(minLength: 0)
            Picker("计费周期", selection: $billingPeriod) {
                ForEach(SubscriptionBillingPeriod.allCases) { period in
                    Text(period.title).tag(period)
                }
            }
            .pickerStyle(.segmented)
            .frame(width: 240)
            Button {
                Task { await state.refreshSubscriptionCenter() }
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.bordered)
            .disabled(state.isSubscriptionLoading)
            .help("刷新套餐与权益")
        }
        .padding(.horizontal, 2)
    }

    private func planCatalog(_ catalog: SubscriptionCatalog) -> some View {
        LazyVGrid(
            columns: Array(
                repeating: GridItem(.flexible(minimum: 230), spacing: FutuTheme.sectionSpacing),
                count: 3
            ),
            alignment: .leading,
            spacing: FutuTheme.sectionSpacing
        ) {
            ForEach(catalog.plans.filter { $0.status == "ACTIVE" }) { plan in
                planPanel(plan, catalog: catalog)
            }
        }
    }

    private func planPanel(
        _ plan: SubscriptionPlan,
        catalog: SubscriptionCatalog
    ) -> some View {
        let price = plan.prices.first { $0.billingPeriod == billingPeriod }
        let selected = selectedProviders(for: plan)
        let action = state.subscriptionOrderType(for: plan, billingPeriod: billingPeriod)
        let isScheduledChange = action == nil

        return WorkbenchPanel(
            plan.displayName,
            subtitle: planSummary(plan),
            systemImage: plan.planCode == .flagship ? "crown.fill" : "square.stack.3d.up.fill",
            minimumHeight: 390,
            headerTrailing: AnyView(
                statusPill(for: plan)
            )
        ) {
            HStack(alignment: .firstTextBaseline) {
                Text(price?.displayPrice ?? "—")
                    .font(FutuTheme.metricValue)
                    .foregroundStyle(FutuTheme.ink)
                Text("/ \(billingPeriod.title)")
                    .font(FutuTheme.metricNote)
                    .foregroundStyle(FutuTheme.inkMuted)
            }

            VStack(alignment: .leading, spacing: 7) {
                featureRow("券商槽位", value: "\(plan.brokerSlotLimit) 个")
                featureRow(
                    "每券商标的",
                    value: plan.poolCapacityPerProvider.map(String.init) ?? "不限"
                )
                featureRow(
                    "每月替换",
                    value: plan.monthlyReplacementLimit.map(String.init) ?? "不限"
                )
                featureRow("期权能力", value: "研究可用 / 交易禁用")
            }

            DashedDivider()

            Text(isScheduledChange ? "到期后保留券商" : "启用券商")
                .font(FutuTheme.metricLabel)
                .foregroundStyle(FutuTheme.ink)
            ForEach(catalog.providers.filter { $0.status == "ACTIVE" }) { provider in
                Toggle(
                    provider.displayName,
                    isOn: providerBinding(provider.providerId, plan: plan)
                )
                .toggleStyle(.checkbox)
                .font(FutuTheme.body)
                .disabled(!canToggle(provider.providerId, plan: plan))
            }

            Spacer(minLength: 0)

            Button {
                Task {
                    let providers = orderedProviderIds(selected, catalog: catalog)
                    if isScheduledChange {
                        await state.scheduleSubscriptionChange(
                            plan: plan,
                            billingPeriod: billingPeriod,
                            retainedProviderIds: providers
                        )
                    } else {
                        await state.submitSubscriptionPlan(
                            plan: plan,
                            billingPeriod: billingPeriod,
                            providerIds: providers
                        )
                    }
                }
            } label: {
                Label(
                    actionTitle(action, scheduled: isScheduledChange),
                    systemImage: actionIcon(action, scheduled: isScheduledChange)
                )
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(FutuTheme.orange)
            .disabled(
                state.isSubscriptionLoading
                    || price == nil
                    || selected.isEmpty
                    || selected.count > plan.brokerSlotLimit
            )
        }
    }

    private func currentSubscriptionPanel(_ subscription: UserSubscription) -> some View {
        WorkbenchPanel(
            "当前套餐",
            subtitle: "服务端权益状态",
            systemImage: "checkmark.seal.fill",
            headerTrailing: AnyView(
                StatusPill(
                    text: subscription.status == "ACTIVE" ? "生效中" : "已冻结",
                    color: subscription.status == "ACTIVE" ? FutuTheme.loss : FutuTheme.amber
                )
            )
        ) {
            HStack(spacing: 28) {
                metric("套餐", subscription.planName)
                metric("周期", subscription.billingPeriod.title)
                metric("剩余", "\(subscription.remainingDays) 天")
                metric("开始", displayDate(subscription.currentPeriodStart))
                metric("到期", displayDate(subscription.expiresAt))
                Spacer(minLength: 0)
            }
            if let pending = subscription.pendingChange {
                DashedDivider()
                Label(
                    "\(displayPlanCode(pending.planCode))将在 \(displayDate(pending.effectiveAt)) 生效，保留 \(pending.retainedProviderIds.joined(separator: "、"))",
                    systemImage: "calendar.badge.clock"
                )
                .font(FutuTheme.body)
                .foregroundStyle(FutuTheme.inkMuted)
            }
        }
    }

    private func brokerSlotsPanel(_ subscription: UserSubscription) -> some View {
        WorkbenchPanel(
            "券商槽位",
            subtitle: "Provider 标的池严格隔离；换绑后原券商池冻结",
            systemImage: "link"
        ) {
            ForEach(subscription.slots) { slot in
                HStack(spacing: 12) {
                    Text("槽位 \(slot.slotOrdinal)")
                        .font(FutuTheme.bodyStrong)
                        .frame(width: 62, alignment: .leading)
                    Picker(
                        "券商",
                        selection: slotSelectionBinding(slot)
                    ) {
                        Text("未绑定").tag("")
                        ForEach(availableProviders(for: slot)) { provider in
                            Text(provider.displayName).tag(provider.providerId)
                        }
                    }
                    .labelsHidden()
                    .frame(width: 160)
                    Text(slot.providerId.map(providerName) ?? "尚未绑定")
                        .font(FutuTheme.tableCell)
                        .foregroundStyle(FutuTheme.inkMuted)
                        .frame(width: 120, alignment: .leading)
                    Text(slotRebindText(slot))
                        .font(FutuTheme.metricNote)
                        .foregroundStyle(FutuTheme.inkMuted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button {
                        let providerId = slotProviderSelections[slot.slotId] ?? slot.providerId ?? ""
                        Task {
                            await state.bindSubscriptionBrokerSlot(
                                slot: slot,
                                providerId: providerId
                            )
                        }
                    } label: {
                        Label("应用", systemImage: "checkmark")
                    }
                    .buttonStyle(.bordered)
                    .disabled(!canApplySlot(slot))
                }
                if slot.id != subscription.slots.last?.id {
                    Divider()
                }
            }
        }
    }

    private func orderPanel(
        _ order: SubscriptionOrder,
        catalog: SubscriptionCatalog
    ) -> some View {
        WorkbenchPanel(
            "待处理订单",
            subtitle: order.businessOrderNo,
            systemImage: "creditcard.fill",
            headerTrailing: AnyView(
                StatusPill(text: displayOrderStatus(order.status), color: orderStatusColor(order.status))
            )
        ) {
            HStack(spacing: 28) {
                metric("套餐", displayPlanCode(order.planCode))
                metric("类型", displayOrderType(order.orderType))
                metric("原价", money(order.originalAmountMinor))
                metric("抵扣", money(order.creditAmountMinor))
                metric("应付", order.displayPayableAmount)
                metric("报价截止", displayDateTime(order.quoteExpiresAt))
                Spacer(minLength: 0)
            }

            DashedDivider()

            HStack(spacing: 10) {
                ForEach(catalog.paymentChannels) { channel in
                    Button {
                        Task { await state.startSubscriptionPayment(channel: channel.channel) }
                    } label: {
                        Label(channel.displayName, systemImage: paymentIcon(channel.channel))
                    }
                    .buttonStyle(.bordered)
                    .disabled(
                        state.isSubscriptionLoading
                            || !channel.available
                            || !["CREATED", "FAILED"].contains(order.status)
                    )
                    .help(channel.available ? channel.displayName : (channel.unavailableReason ?? "渠道不可用"))
                }
                if let rawURL = order.payment?.paymentUrl, let url = URL(string: rawURL) {
                    Link(destination: url) {
                        Label("打开支付", systemImage: "arrow.up.right.square")
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(FutuTheme.orange)
                }
                Spacer(minLength: 0)
                Button {
                    Task { await state.refreshSubscriptionOrder() }
                } label: {
                    Label("刷新状态", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
                .disabled(state.isSubscriptionLoading)
            }

            Text("客户端回跳不变更权益；仅服务端验签支付回调后订单才会变为已支付。")
                .font(FutuTheme.metricNote)
                .foregroundStyle(FutuTheme.inkMuted)
        }
    }

    private func initializeSelections(resetPlans: Bool = false) {
        guard let catalog = state.subscriptionCatalog else { return }
        let bound = boundProviderIds
        if resetPlans {
            planProviderSelections = [:]
            slotProviderSelections = [:]
        }
        for plan in catalog.plans where planProviderSelections[plan.planVersionId] == nil {
            let defaults = bound.isEmpty
                ? catalog.providers.prefix(plan.brokerSlotLimit).map(\.providerId)
                : Array(bound.prefix(plan.brokerSlotLimit))
            planProviderSelections[plan.planVersionId] = Set(defaults)
        }
        for slot in state.currentSubscription?.slots ?? [] {
            if slotProviderSelections[slot.slotId] == nil {
                slotProviderSelections[slot.slotId] = slot.providerId ?? ""
            }
        }
    }

    private var boundProviderIds: [String] {
        (state.currentSubscription?.slots ?? []).compactMap(\.providerId)
    }

    private func selectedProviders(for plan: SubscriptionPlan) -> Set<String> {
        planProviderSelections[plan.planVersionId] ?? []
    }

    private func providerBinding(
        _ providerId: String,
        plan: SubscriptionPlan
    ) -> Binding<Bool> {
        Binding(
            get: { selectedProviders(for: plan).contains(providerId) },
            set: { enabled in
                var selection = selectedProviders(for: plan)
                if enabled {
                    guard selection.count < plan.brokerSlotLimit else { return }
                    selection.insert(providerId)
                } else {
                    selection.remove(providerId)
                }
                planProviderSelections[plan.planVersionId] = selection
            }
        )
    }

    private func canToggle(_ providerId: String, plan: SubscriptionPlan) -> Bool {
        let action = state.subscriptionOrderType(for: plan, billingPeriod: billingPeriod)
        let selected = selectedProviders(for: plan)
        if action == .renew {
            return false
        }
        if action == nil, !boundProviderIds.contains(providerId) {
            return false
        }
        if action == .upgrade, boundProviderIds.contains(providerId), selected.contains(providerId) {
            return false
        }
        return selected.contains(providerId) || selected.count < plan.brokerSlotLimit
    }

    private func orderedProviderIds(
        _ selected: Set<String>,
        catalog: SubscriptionCatalog
    ) -> [String] {
        catalog.providers.map(\.providerId).filter(selected.contains)
    }

    private func slotSelectionBinding(_ slot: SubscriptionBrokerSlot) -> Binding<String> {
        Binding(
            get: { slotProviderSelections[slot.slotId] ?? slot.providerId ?? "" },
            set: { slotProviderSelections[slot.slotId] = $0 }
        )
    }

    private func availableProviders(
        for slot: SubscriptionBrokerSlot
    ) -> [SubscriptionProvider] {
        let used = Set(
            (state.currentSubscription?.slots ?? [])
                .filter { $0.slotId != slot.slotId }
                .compactMap(\.providerId)
        )
        return (state.subscriptionCatalog?.providers ?? [])
            .filter { $0.status == "ACTIVE" && !used.contains($0.providerId) }
    }

    private func canApplySlot(_ slot: SubscriptionBrokerSlot) -> Bool {
        let selection = slotProviderSelections[slot.slotId] ?? slot.providerId ?? ""
        guard !state.isSubscriptionLoading,
              !selection.isEmpty,
              selection != slot.providerId else { return false }
        guard let nextRebindAt = slot.nextRebindAt,
              let date = ISO8601DateFormatter().date(from: nextRebindAt) else {
            return slot.providerId == nil
        }
        return date <= Date()
    }

    private func planSummary(_ plan: SubscriptionPlan) -> String {
        let capacity = plan.poolCapacityPerProvider.map { "\($0) 标的/券商" } ?? "标的数量不限"
        return "\(plan.brokerSlotLimit) 个券商槽位 · \(capacity)"
    }

    @ViewBuilder
    private func statusPill(for plan: SubscriptionPlan) -> some View {
        if state.currentSubscription?.planVersionId == plan.planVersionId {
            StatusPill(text: "当前套餐", color: FutuTheme.loss)
        }
    }

    private func featureRow(_ label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(FutuTheme.body)
                .foregroundStyle(FutuTheme.inkMuted)
            Spacer(minLength: 8)
            Text(value)
                .font(FutuTheme.bodyStrong)
                .foregroundStyle(FutuTheme.ink)
        }
    }

    private func metric(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .font(FutuTheme.metricNote)
                .foregroundStyle(FutuTheme.inkMuted)
            Text(value)
                .font(FutuTheme.bodyStrong)
                .foregroundStyle(FutuTheme.ink)
                .lineLimit(1)
        }
    }

    private func statusBanner(_ message: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "info.circle.fill")
                .foregroundStyle(FutuTheme.orange)
            Text(message)
                .font(FutuTheme.body)
                .foregroundStyle(FutuTheme.ink)
            Spacer(minLength: 0)
        }
        .padding(10)
        .background(FutuTheme.orangeSoft)
        .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
    }

    private func actionTitle(
        _ action: SubscriptionOrderType?,
        scheduled: Bool
    ) -> String {
        if scheduled { return "预约到期变更" }
        return switch action {
        case .new: "创建订单"
        case .renew: "续费当前套餐"
        case .upgrade: "立即升级并抵扣"
        case nil: "预约到期变更"
        }
    }

    private func actionIcon(
        _ action: SubscriptionOrderType?,
        scheduled: Bool
    ) -> String {
        if scheduled { return "calendar.badge.clock" }
        return action == .renew ? "arrow.clockwise" : "cart.fill"
    }

    private func displayPlanCode(_ code: SubscriptionPlanCode) -> String {
        switch code {
        case .lite: "轻量版"
        case .pro: "高级版"
        case .flagship: "旗舰版"
        }
    }

    private func displayOrderType(_ type: SubscriptionOrderType) -> String {
        switch type {
        case .new: "新购"
        case .renew: "续费"
        case .upgrade: "升级"
        }
    }

    private func displayOrderStatus(_ status: String) -> String {
        switch status {
        case "CREATED": "待支付"
        case "PAYING": "支付中"
        case "PAID": "已支付"
        case "FAILED": "支付失败"
        case "CLOSED": "已关闭"
        case "REFUNDED": "已退款"
        default: status
        }
    }

    private func orderStatusColor(_ status: String) -> Color {
        switch status {
        case "PAID": FutuTheme.loss
        case "FAILED", "CLOSED": FutuTheme.rose
        default: FutuTheme.amber
        }
    }

    private func paymentIcon(_ channel: SubscriptionPaymentChannel) -> String {
        switch channel {
        case .wechat: "message.fill"
        case .alipay: "a.circle.fill"
        case .douyin: "music.note"
        }
    }

    private func providerName(_ providerId: String) -> String {
        state.subscriptionCatalog?.providers
            .first { $0.providerId == providerId }?.displayName ?? providerId
    }

    private func slotRebindText(_ slot: SubscriptionBrokerSlot) -> String {
        guard slot.providerId != nil else { return "可立即绑定" }
        guard let next = slot.nextRebindAt else { return "换绑时间待服务端确认" }
        return "下次可换绑：\(displayDateTime(next))"
    }

    private func displayDate(_ value: String) -> String {
        guard let date = ISO8601DateFormatter().date(from: value) else { return value }
        return date.formatted(date: .abbreviated, time: .omitted)
    }

    private func displayDateTime(_ value: String) -> String {
        guard let date = ISO8601DateFormatter().date(from: value) else { return value }
        return date.formatted(date: .numeric, time: .shortened)
    }

    private func money(_ amountMinor: Int) -> String {
        String(format: "¥%.2f", Double(amountMinor) / 100)
    }
}
