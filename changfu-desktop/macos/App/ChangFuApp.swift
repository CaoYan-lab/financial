import ChangFuInfrastructure
import SwiftUI

@main
struct ChangFuApp: App {
    @State private var state = AppState()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup("长富") {
            AuthenticationGateView(state: state)
                .frame(minWidth: 1180, minHeight: 720)
                .task {
                    await state.start()
                }
                .onChange(of: scenePhase) { _, phase in
                    Task {
                        if phase == .background {
                            await state.shutdownLiveTradingRuntime(
                                reason: "应用进入后台，自动交易会话已停用"
                            )
                        } else if phase == .active {
                            await state.resumeLiveTradingRuntime()
                        }
                    }
                }
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1440, height: 900)
        .commands {
            CommandGroup(replacing: .newItem) {}
        }
    }
}
