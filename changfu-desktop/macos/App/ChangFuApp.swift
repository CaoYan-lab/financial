import ChangFuInfrastructure
import SwiftUI

@main
struct ChangFuApp: App {
    @State private var state = AppState()

    var body: some Scene {
        WindowGroup("长富") {
            AuthenticationGateView(state: state)
                .frame(minWidth: 1180, minHeight: 720)
                .task {
                    await state.start()
                }
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1440, height: 900)
        .commands {
            CommandGroup(replacing: .newItem) {}
        }
    }
}
