import SwiftUI

enum FutuTheme {
    static let canvas = Color(red: 0.992, green: 0.984, blue: 0.965)
    static let canvasWarm = Color(red: 1.0, green: 0.965, blue: 0.902)
    static let surface = Color.white.opacity(0.94)
    static let surfaceMuted = Color(red: 0.976, green: 0.969, blue: 0.953)
    static let line = Color(red: 0.929, green: 0.824, blue: 0.671)
    static let lineSoft = Color(red: 0.91, green: 0.89, blue: 0.85)
    static let ink = Color(red: 0.16, green: 0.145, blue: 0.13)
    static let inkMuted = Color(red: 0.42, green: 0.39, blue: 0.35)
    static let amber = Color(red: 0.85, green: 0.55, blue: 0.10)
    static let orange = Color(red: 0.93, green: 0.34, blue: 0.09)
    static let orangeSoft = Color(red: 1.0, green: 0.91, blue: 0.80)
    static let rose = Color(red: 0.82, green: 0.20, blue: 0.27)
    static let roseSoft = Color(red: 1.0, green: 0.91, blue: 0.92)
    static let profit = Color(red: 0.78, green: 0.12, blue: 0.16)
    static let loss = Color(red: 0.08, green: 0.55, blue: 0.30)

    static let sectionSpacing: CGFloat = 16
    static let panelPadding: CGFloat = 16
    static let contentSpacing: CGFloat = 12

    static let pageEyebrow = Font.system(size: 13, weight: .semibold)
    static let pageTitle = Font.system(size: 26, weight: .bold)
    static let pageSubtitle = Font.system(size: 15)
    static let panelTitle = Font.system(size: 17, weight: .semibold)
    static let panelSubtitle = Font.system(size: 13)
    static let body = Font.system(size: 14)
    static let bodyStrong = Font.system(size: 14, weight: .semibold)
    static let metricLabel = Font.system(size: 13, weight: .medium)
    static let metricValue = Font.system(size: 22, weight: .bold, design: .rounded)
    static let metricNote = Font.system(size: 12)
    static let tableHeader = Font.system(size: 12, weight: .semibold)
    static let tableCell = Font.system(size: 13)
}

struct WorkbenchPanel<Content: View>: View {
    let title: String
    let subtitle: String?
    let systemImage: String
    let minimumHeight: CGFloat?
    let headerTrailing: AnyView?
    @ViewBuilder let content: Content

    init(
        _ title: String,
        subtitle: String? = nil,
        systemImage: String,
        minimumHeight: CGFloat? = nil,
        headerTrailing: AnyView? = nil,
        @ViewBuilder content: () -> Content
    ) {
        self.title = title
        self.subtitle = subtitle
        self.systemImage = systemImage
        self.minimumHeight = minimumHeight
        self.headerTrailing = headerTrailing
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: FutuTheme.contentSpacing) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: systemImage)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(FutuTheme.orange)
                    .frame(width: 30, height: 30)
                    .background(FutuTheme.orangeSoft)
                    .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(FutuTheme.panelTitle)
                        .foregroundStyle(FutuTheme.ink)
                    if let subtitle {
                        Text(subtitle)
                            .font(FutuTheme.panelSubtitle)
                            .foregroundStyle(FutuTheme.inkMuted)
                            .lineSpacing(2)
                    }
                }
                Spacer(minLength: 0)
                if let headerTrailing {
                    headerTrailing
                }
            }
            content
        }
        .frame(maxWidth: .infinity, minHeight: minimumHeight, alignment: .topLeading)
        .padding(FutuTheme.panelPadding)
        .background(FutuTheme.surface)
        .overlay {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(FutuTheme.line, lineWidth: 1)
        }
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .shadow(color: Color.black.opacity(0.035), radius: 5, y: 2)
    }
}

struct DataUnavailableView: View {
    let text: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.circle")
                .foregroundStyle(FutuTheme.amber)
            Text(text)
                .font(FutuTheme.body)
                .foregroundStyle(FutuTheme.inkMuted)
                .lineSpacing(2)
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(FutuTheme.surfaceMuted)
        .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
    }
}

struct StatusPill: View {
    let text: String
    let color: Color

    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(color)
                .frame(width: 6, height: 6)
            Text(text)
                .font(FutuTheme.metricNote.weight(.medium))
                .lineLimit(1)
        }
        .foregroundStyle(FutuTheme.ink)
        .padding(.horizontal, 9)
        .frame(height: 25)
        .background(color.opacity(0.11))
        .overlay {
            Capsule().stroke(color.opacity(0.28), lineWidth: 1)
        }
        .clipShape(Capsule())
    }
}
