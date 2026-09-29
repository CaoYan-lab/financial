import SwiftUI

struct AuthenticationGateView: View {
    @Bindable var state: AppState

    var body: some View {
        Group {
            switch state.authenticationPhase {
            case .checking:
                authenticationCheck
            case .signedOut(let message):
                LoginView(
                    message: message,
                    isSubmitting: state.isAuthenticating,
                    reservesDebugBannerSpace: state.isDebugMode
                ) { username, password in
                    await state.login(username: username, password: password)
                }
            case .passwordChangeRequired(let message):
                PasswordChangeView(
                    message: message,
                    isSubmitting: state.isChangingPassword,
                    reservesDebugBannerSpace: state.isDebugMode
                ) { nextPassword in
                    await state.changePassword(nextPassword: nextPassword)
                }
            case .signedIn:
                RootView(state: state)
            }
        }
        .overlay(alignment: .topLeading) {
            if state.isDebugMode {
                DebugModeBanner(isClosing: state.isSwitchingBackendEnvironment) {
                    Task { await state.disableDebugMode() }
                }
                .padding(.leading, 12)
                .padding(.top, 8)
            }
        }
    }

    private var authenticationCheck: some View {
        ZStack {
            Color(nsColor: .windowBackgroundColor)
                .ignoresSafeArea()
            VStack(spacing: 14) {
                Text("长富")
                    .font(.system(size: 30, weight: .bold))
                ProgressView()
                    .controlSize(.small)
                Text("正在校验登录状态")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

private struct PasswordChangeView: View {
    let message: String?
    let isSubmitting: Bool
    let reservesDebugBannerSpace: Bool
    let submit: (String) async -> Void

    @State private var nextPassword = ""
    @State private var confirmation = ""
    @State private var localMessage: String?
    @FocusState private var focusedField: Field?

    private enum Field {
        case nextPassword
        case confirmation
    }

    var body: some View {
        ZStack {
            Color(nsColor: .windowBackgroundColor)
                .ignoresSafeArea()

            VStack(spacing: 0) {
                HStack {
                    Text("长富")
                        .font(.system(size: 24, weight: .bold))
                    Spacer()
                    Text("首次登录安全设置")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                .padding(.leading, reservesDebugBannerSpace ? 188 : 28)
                .padding(.trailing, 28)
                .frame(height: 64)

                Divider()

                HStack {
                    Spacer(minLength: 40)
                    VStack(alignment: .leading, spacing: 20) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("修改初始密码")
                                .font(.system(size: 28, weight: .semibold))
                            Text("完成修改后，使用新密码重新登录")
                                .font(.callout)
                                .foregroundStyle(.secondary)
                        }

                        passwordField(
                            title: "新密码",
                            placeholder: "至少 12 位，包含字母和数字",
                            text: $nextPassword,
                            field: .nextPassword
                        )
                        passwordField(
                            title: "确认新密码",
                            placeholder: "请再次输入新密码",
                            text: $confirmation,
                            field: .confirmation
                        )

                        if let displayedMessage = localMessage ?? message,
                           !displayedMessage.isEmpty {
                            Label(displayedMessage, systemImage: "exclamationmark.circle")
                                .font(.callout)
                                .foregroundStyle(.red)
                                .fixedSize(horizontal: false, vertical: true)
                        }

                        Button(action: changePassword) {
                            HStack(spacing: 8) {
                                if isSubmitting {
                                    ProgressView()
                                        .controlSize(.small)
                                }
                                Text(isSubmitting ? "正在修改" : "修改密码")
                                    .fontWeight(.semibold)
                            }
                            .frame(maxWidth: .infinity)
                            .frame(height: 46)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .disabled(
                            isSubmitting
                                || nextPassword.isEmpty
                                || confirmation.isEmpty
                        )
                    }
                    .frame(width: 360)
                    Spacer(minLength: 40)
                }
                .frame(maxHeight: .infinity)
            }
            .background(Color(nsColor: .controlBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
            .padding(8)
        }
        .onAppear { focusedField = .nextPassword }
    }

    @ViewBuilder
    private func passwordField(
        title: String,
        placeholder: String,
        text: Binding<String>,
        field: Field
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.callout.weight(.medium))
            SecureField(placeholder, text: text)
                .textFieldStyle(.plain)
                .focused($focusedField, equals: field)
                .onSubmit {
                    switch field {
                    case .nextPassword:
                        focusedField = .confirmation
                    case .confirmation:
                        changePassword()
                    }
                }
                .padding(.horizontal, 14)
                .frame(height: 46)
                .background(Color(nsColor: .textBackgroundColor))
                .overlay {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .stroke(Color(nsColor: .separatorColor))
                }
        }
    }

    private func changePassword() {
        guard !isSubmitting else { return }
        guard nextPassword == confirmation else {
            localMessage = "两次输入的新密码不一致"
            return
        }
        localMessage = nil
        let submittedNextPassword = nextPassword
        nextPassword = ""
        confirmation = ""
        Task {
            await submit(submittedNextPassword)
        }
    }
}

private struct LoginView: View {
    let message: String?
    let isSubmitting: Bool
    let reservesDebugBannerSpace: Bool
    let submit: (String, String) async -> Void

    @State private var username = ""
    @State private var password = ""
    @FocusState private var focusedField: Field?

    private enum Field {
        case username
        case password
    }

    var body: some View {
        ZStack {
            Color(nsColor: .windowBackgroundColor)
                .ignoresSafeArea()

            VStack(spacing: 0) {
                HStack {
                    Text("长富")
                        .font(.system(size: 24, weight: .bold))
                    Spacer()
                    Text("安全登录")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                .padding(.leading, reservesDebugBannerSpace ? 188 : 28)
                .padding(.trailing, 28)
                .frame(height: 64)

                Divider()

                HStack {
                    Spacer(minLength: 40)
                    VStack(alignment: .leading, spacing: 22) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("登录长富")
                                .font(.system(size: 28, weight: .semibold))
                            Text("使用已启用的长富账号")
                                .font(.callout)
                                .foregroundStyle(.secondary)
                        }

                        VStack(alignment: .leading, spacing: 14) {
                            fieldLabel("用户名")
                            TextField("请输入用户名", text: $username)
                                .textFieldStyle(.plain)
                                .focused($focusedField, equals: .username)
                                .onSubmit { focusedField = .password }
                                .padding(.horizontal, 14)
                                .frame(height: 46)
                                .background(Color(nsColor: .textBackgroundColor))
                                .overlay {
                                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                                        .stroke(Color(nsColor: .separatorColor))
                                }

                            fieldLabel("密码")
                            SecureField("请输入密码", text: $password)
                                .textFieldStyle(.plain)
                                .focused($focusedField, equals: .password)
                                .onSubmit { authenticate() }
                                .padding(.horizontal, 14)
                                .frame(height: 46)
                                .background(Color(nsColor: .textBackgroundColor))
                                .overlay {
                                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                                        .stroke(Color(nsColor: .separatorColor))
                                }
                        }

                        if let message, !message.isEmpty {
                            Label(message, systemImage: "exclamationmark.circle")
                                .font(.callout)
                                .foregroundStyle(.red)
                                .fixedSize(horizontal: false, vertical: true)
                        }

                        Button(action: authenticate) {
                            HStack(spacing: 8) {
                                if isSubmitting {
                                    ProgressView()
                                        .controlSize(.small)
                                }
                                Text(isSubmitting ? "正在登录" : "登录")
                                    .fontWeight(.semibold)
                            }
                            .frame(maxWidth: .infinity)
                            .frame(height: 46)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .disabled(
                            isSubmitting
                                || username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                || password.isEmpty
                        )
                    }
                    .frame(width: 360)
                    Spacer(minLength: 40)
                }
                .frame(maxHeight: .infinity)
            }
            .background(Color(nsColor: .controlBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
            .padding(8)
        }
        .onAppear { focusedField = .username }
    }

    private func fieldLabel(_ title: String) -> some View {
        Text(title)
            .font(.callout.weight(.medium))
    }

    private func authenticate() {
        guard !isSubmitting else { return }
        let submittedUsername = username
        let submittedPassword = password
        password = ""
        Task {
            await submit(submittedUsername, submittedPassword)
        }
    }
}

private struct DebugModeBanner: View {
    let isClosing: Bool
    let close: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            Text("Debug 模式开启中")
                .font(.system(size: 11, weight: .semibold))
            Button(action: close) {
                Image(systemName: "xmark.circle.fill")
            }
            .buttonStyle(.plain)
            .disabled(isClosing)
            .help("关闭调试模式")
        }
        .foregroundStyle(.white)
        .padding(.leading, 8)
        .padding(.trailing, 6)
        .frame(height: 24)
        .background(Color.red.opacity(0.92))
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }
}
