// wiser iOS DAT — app entry (stub).
// Not wired into an Xcode project yet; this is the seed for the native DAT work.
//
// Uncomment the MWDATCore bits once the SwiftPM dependency is added.

import SwiftUI
// import MWDATCore

@main
struct WiserDATApp: App {
    init() {
        // do {
        //     try Wearables.configure()
        // } catch {
        //     assertionFailure("Failed to configure Wearables SDK: \(error)")
        // }
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .onOpenURL { _ in
                    // Task { _ = try? await Wearables.shared.handleUrl(url) }
                }
        }
    }
}
