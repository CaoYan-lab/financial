import ChangFuDomain
import SwiftUI

struct GlobalModelWorkspace: View {
    @Bindable var state: AppState

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: FutuTheme.sectionSpacing) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("全局服务")
                        .font(FutuTheme.pageEyebrow)
                        .foregroundStyle(FutuTheme.orange)
                    Text("模型接入")
                        .font(FutuTheme.pageTitle)
                        .foregroundStyle(FutuTheme.ink)
                    Text("管理对话可选模型；配置按账户生效，不随交易平台切换")
                        .font(FutuTheme.pageSubtitle)
                        .foregroundStyle(FutuTheme.inkMuted)
                }
                .padding(.horizontal, 2)

                GlobalModelConfigurationView(state: state)
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(FutuTheme.canvas)
    }
}

struct GlobalModelConfigurationView: View {
    @Bindable var state: AppState
    @State private var displayName = ""
    @State private var modelProtocol: ModelProviderProtocol = .responses
    @State private var endpoint = ""
    @State private var modelId = ""
    @State private var apiKey = ""
    @State private var enabled = true
    @State private var resultMessage: String?

    var body: some View {
        WorkbenchPanel(
            "第三方模型",
            subtitle: "仅旗舰版可用",
            systemImage: "cpu",
            headerTrailing: AnyView(
                StatusPill(
                    text: modelEligible ? "旗舰版权益" : "未开放",
                    color: modelEligible ? FutuTheme.loss : FutuTheme.inkMuted
                )
            )
        ) {
            HStack(alignment: .top, spacing: 24) {
                modelRoutes
                    .frame(width: 220, alignment: .leading)
                Divider()
                configurationForm
            }

            DashedDivider()

            HStack {
                if let message = resultMessage ?? state.thirdPartyModelStatusMessage {
                    Text(message)
                        .font(FutuTheme.body)
                        .foregroundStyle(FutuTheme.inkMuted)
                } else if !modelEligible {
                    Text("升级并保持旗舰版有效后，才能保存和使用第三方模型。")
                        .font(FutuTheme.body)
                        .foregroundStyle(FutuTheme.inkMuted)
                }
                Spacer()
                Button(role: .destructive) {
                    deleteConfiguration()
                } label: {
                    Label("删除配置", systemImage: "trash")
                }
                .disabled(
                    !modelEligible
                        || state.thirdPartyModelConfiguration?.config == nil
                        || state.isThirdPartyModelLoading
                )
                Button {
                    saveConfiguration()
                } label: {
                    if state.isThirdPartyModelLoading {
                        ProgressView().controlSize(.small)
                    } else {
                        Label("保存配置", systemImage: "externaldrive.badge.checkmark")
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(FutuTheme.orange)
                .disabled(!canSave)
            }
        }
        .task {
            await state.refreshThirdPartyModelConfiguration()
            loadConfiguration()
        }
        .onChange(of: state.thirdPartyModelConfiguration) { _, _ in
            loadConfiguration()
        }
    }

    private var modelRoutes: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("对话可选模型")
                .font(FutuTheme.metricLabel)
                .foregroundStyle(FutuTheme.inkMuted)
            modelRouteRow(
                name: "长富Pro",
                detail: "始终可用",
                systemImage: "checkmark.seal.fill"
            )
            if let config = state.thirdPartyModelConfiguration?.config {
                modelRouteRow(
                    name: config.displayName,
                    detail: config.enabled ? config.model : "已停用",
                    systemImage: "cpu"
                )
            } else {
                Text("尚未添加第三方配置")
                    .font(FutuTheme.body)
                    .foregroundStyle(FutuTheme.inkMuted)
            }
        }
    }

    private func modelRouteRow(
        name: String,
        detail: String,
        systemImage: String
    ) -> some View {
        HStack(spacing: 9) {
            Image(systemName: systemImage)
                .foregroundStyle(FutuTheme.orange)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(name)
                    .font(FutuTheme.bodyStrong)
                    .foregroundStyle(FutuTheme.ink)
                Text(detail)
                    .font(FutuTheme.metricNote)
                    .foregroundStyle(FutuTheme.inkMuted)
            }
        }
    }

    private var configurationForm: some View {
        Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 10) {
            GridRow {
                fieldLabel("显示名称")
                TextField("例如：研究模型", text: $displayName)
            }
            GridRow {
                fieldLabel("协议")
                Picker("协议", selection: $modelProtocol) {
                    ForEach(ModelProviderProtocol.allCases) { item in
                        Text(item.title).tag(item)
                    }
                }
                .labelsHidden()
                .pickerStyle(.segmented)
            }
            GridRow {
                fieldLabel("Endpoint")
                TextField("HTTPS Endpoint", text: $endpoint)
            }
            GridRow {
                fieldLabel("模型 ID")
                TextField("模型 ID", text: $modelId)
            }
            GridRow {
                fieldLabel("API Key")
                SecureField(
                    state.thirdPartyModelConfiguration?.config == nil
                        ? "API Key"
                        : "API Key（留空则保留）",
                    text: $apiKey
                )
            }
            GridRow {
                fieldLabel("状态")
                Toggle("允许在对话中选择", isOn: $enabled)
            }
        }
        .disabled(!modelEligible || state.isThirdPartyModelLoading)
    }

    private func fieldLabel(_ text: String) -> some View {
        Text(text)
            .font(FutuTheme.metricLabel)
            .foregroundStyle(FutuTheme.inkMuted)
            .frame(width: 76, alignment: .leading)
    }

    private var modelEligible: Bool {
        state.thirdPartyModelConfiguration?.eligible == true
    }

    private var canSave: Bool {
        modelEligible
            && !state.isThirdPartyModelLoading
            && !displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && URL(string: endpoint)?.scheme == "https"
            && !modelId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && (
                state.thirdPartyModelConfiguration?.config != nil
                    || apiKey.trimmingCharacters(in: .whitespacesAndNewlines).count >= 8
            )
    }

    private func loadConfiguration() {
        guard let config = state.thirdPartyModelConfiguration?.config else { return }
        displayName = config.displayName
        modelProtocol = config.protocol
        endpoint = config.endpoint
        modelId = config.model
        enabled = config.enabled
        apiKey = ""
    }

    private func saveConfiguration() {
        resultMessage = nil
        Task {
            let rawKey = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
            let saved = await state.saveThirdPartyModelConfiguration(
                displayName: displayName.trimmingCharacters(in: .whitespacesAndNewlines),
                protocol: modelProtocol,
                endpoint: endpoint.trimmingCharacters(in: .whitespacesAndNewlines),
                model: modelId.trimmingCharacters(in: .whitespacesAndNewlines),
                apiKey: rawKey.isEmpty ? nil : rawKey,
                enabled: enabled
            )
            apiKey = ""
            resultMessage = saved ? "第三方模型配置已保存" : state.thirdPartyModelStatusMessage
        }
    }

    private func deleteConfiguration() {
        resultMessage = nil
        Task {
            let deleted = await state.deleteThirdPartyModelConfiguration()
            if deleted {
                displayName = ""
                modelProtocol = .responses
                endpoint = ""
                modelId = ""
                apiKey = ""
                enabled = true
                resultMessage = "第三方模型配置已删除"
            } else {
                resultMessage = state.thirdPartyModelStatusMessage
            }
        }
    }
}
