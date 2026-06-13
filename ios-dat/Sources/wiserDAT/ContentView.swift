// wiser iOS DAT — single screen (stub): connect button + status.

import SwiftUI

struct ContentView: View {
    @State private var status = "Not connected"

    var body: some View {
        VStack(spacing: 24) {
            Text("wiser")
                .font(.largeTitle).bold()
                .foregroundStyle(.cyan)

            Text(status)
                .font(.subheadline)
                .foregroundStyle(.secondary)

            Button("Connect glasses") {
                // TODO: Wearables.shared.startRegistration() + create/start a session.
                status = "Connecting… (DAT SDK not wired yet)"
            }
            .buttonStyle(.borderedProminent)
            .tint(.cyan)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black)
    }
}

#Preview {
    ContentView()
}
