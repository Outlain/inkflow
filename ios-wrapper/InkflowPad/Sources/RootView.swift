import SwiftUI

struct RootView: View {
    private let baseURL = InkflowBridgeConfiguration.baseWebURL

    var body: some View {
        InkflowWebView(baseURL: baseURL)
            .ignoresSafeArea()
    }
}
