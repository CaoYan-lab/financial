import ChangFuDomain
import SwiftUI

struct SettingsView: View {
    @Bindable var state: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var appKey = ""
    @State private var appSecret = ""
    @State private var accessToken = ""
    @State private var isSaving = false
    @State private var resultMessage: String?

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("连接设置")
                        .font(FutuTheme.pageTitle)
                    Text("Longbridge 券商连接")
                        .font(FutuTheme.pageSubtitle)
                        .foregroundStyle(FutuTheme.inkMuted)
                }
                Spacer()
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark")
                        .frame(width: 30, height: 30)
                }
                .buttonStyle(.borderless)
                .help("关闭")
            }
            .padding(20)

            Divider()

            longbridgeForm
        }
        .frame(width: 640, height: 520)
        .background(FutuTheme.canvas)
    }

    private var longbridgeForm: some View {
        VStack(spacing: 0) {
            Form {
                Section("连接状态") {
                    LabeledContent("当前状态", value: state.longbridgeBroker.connectionState.label)
                    LabeledContent(
                        "API 凭据",
                        value: state.hasLongbridgeCredentials ? "已配置" : "未配置"
                    )
                }
                Section("Legacy API Key") {
                    TextField("App Key", text: $appKey)
                        .textContentType(.username)
                    SecureField("App Secret", text: $appSecret)
                    SecureField("Access Token", text: $accessToken)
                }
                if let resultMessage {
                    Text(resultMessage)
                        .font(FutuTheme.body)
                        .foregroundStyle(FutuTheme.inkMuted)
                }
            }
            .formStyle(.grouped)
            Divider()
            HStack {
                Button(role: .destructive) {
                    state.clearLongbridgeCredentials()
                    clearInputs()
                    resultMessage = "已删除 API 凭据"
                } label: {
                    Label("删除配置", systemImage: "trash")
                }
                .disabled(!state.hasLongbridgeCredentials || isSaving)
                Spacer()
                Button {
                    saveAndConnect()
                } label: {
                    if isSaving {
                        ProgressView().controlSize(.small)
                    } else {
                        Label("保存并连接", systemImage: "link")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!isLongbridgeComplete || isSaving)
            }
            .padding(20)
        }
    }

    private var isLongbridgeComplete: Bool {
        !appKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !appSecret.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !accessToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func saveAndConnect() {
        isSaving = true
        resultMessage = nil
        Task {
            let connected = await state.saveLongbridgeCredentials(
                appKey: appKey,
                appSecret: appSecret,
                accessToken: accessToken
            )
            clearInputs()
            resultMessage = connected
                ? "Longbridge 已连接"
                : state.longbridgeStatusMessage ?? state.longbridgeBroker.connectionState.label
            isSaving = false
        }
    }

    private func clearInputs() {
        appKey = ""
        appSecret = ""
        accessToken = ""
    }

}
