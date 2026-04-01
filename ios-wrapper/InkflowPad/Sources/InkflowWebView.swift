import SwiftUI
import UIKit
import WebKit

struct InkflowWebView: UIViewRepresentable {
    let baseURL: URL

    func makeUIView(context: Context) -> BridgedInkflowWebView {
        BridgedInkflowWebView(baseURL: baseURL)
    }

    func updateUIView(_ uiView: BridgedInkflowWebView, context: Context) {
        uiView.updateBaseURL(baseURL)
    }
}

final class BridgedInkflowWebView: WKWebView, WKNavigationDelegate, UIPencilInteractionDelegate {
    private lazy var pencilInteraction: UIPencilInteraction = UIPencilInteraction(delegate: self)
    private var baseURL: URL
    private var loadedURL: URL?
    private var pendingJavaScript: [String] = []
    private var isPageReady = false
    private var lastLoggedBounds: CGSize = .zero

    init(baseURL: URL) {
        self.baseURL = baseURL

        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.suppressesIncrementalRendering = false

        super.init(frame: .zero, configuration: configuration)

        backgroundColor = .systemBackground
        isOpaque = true
        allowsBackForwardNavigationGestures = true
        navigationDelegate = self
        scrollView.contentInsetAdjustmentBehavior = .never
        addInteraction(pencilInteraction)
        loadIfNeeded(force: true)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func updateBaseURL(_ nextBaseURL: URL) {
        guard nextBaseURL != baseURL else {
            return
        }

        baseURL = nextBaseURL
        loadIfNeeded(force: true)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        isPageReady = true
        flushQueuedJavaScript()
        logViewportMetrics(reason: "didFinish")
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        isPageReady = false
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        isPageReady = false
    }

    override func layoutSubviews() {
        super.layoutSubviews()

        let currentBounds = bounds.size
        guard currentBounds != .zero, currentBounds != lastLoggedBounds else {
            return
        }

        lastLoggedBounds = currentBounds
        logViewportMetrics(reason: "layout")
    }

    func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveSqueeze squeeze: UIPencilInteraction.Squeeze) {
        guard UIPencilInteraction.preferredSqueezeAction != .ignore else {
            return
        }

        guard squeeze.phase == .ended else {
            return
        }

        switch UIPencilInteraction.preferredSqueezeAction {
        case .showContextualPalette:
            dispatchPencilSqueeze(at: squeeze.hoverPose?.location)
        case .switchPrevious:
            dispatchSwitchPreviousTool()
        default:
            break
        }
    }

    private func loadIfNeeded(force: Bool) {
        guard force || loadedURL != baseURL else {
            return
        }

        loadedURL = baseURL
        isPageReady = false
        pendingJavaScript.removeAll()
        stopLoading()
        load(URLRequest(url: baseURL))
    }

    private func dispatchPencilSqueeze(at point: CGPoint?) {
        var payload: [String: Any] = ["source": "apple-pencil-pro"]
        if let point {
            payload["clientX"] = Double(point.x)
            payload["clientY"] = Double(point.y)
        }

        let script = "(() => { const fn = window.__inkflowDispatchPencilSqueeze; if (typeof fn === 'function') { fn(\(jsonString(from: payload))); } })();"
        evaluateBridgedJavaScript(script)
    }

    private func dispatchSwitchPreviousTool() {
        let script = "(() => { const fn = window.__inkflowDispatchSwitchPreviousTool; if (typeof fn === 'function') { fn(); } })();"
        evaluateBridgedJavaScript(script)
    }

    private func evaluateBridgedJavaScript(_ script: String) {
        pendingJavaScript.append(script)
        flushQueuedJavaScript()
    }

    private func flushQueuedJavaScript() {
        guard isPageReady else {
            return
        }

        while !pendingJavaScript.isEmpty {
            let script = pendingJavaScript.removeFirst()
            evaluateJavaScript(script, completionHandler: nil)
        }
    }

    private func jsonString(from payload: [String: Any]) -> String {
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
              let string = String(data: data, encoding: .utf8) else {
            return "{}"
        }

        return string
    }

    private func logViewportMetrics(reason: String) {
        let nativeWidth = bounds.width
        let nativeHeight = bounds.height
        print("[InkflowPad] \(reason) native bounds: \(nativeWidth)x\(nativeHeight)")

        guard isPageReady else {
            return
        }

        let script = """
        (() => JSON.stringify({
          href: window.location.href,
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          clientWidth: document.documentElement ? document.documentElement.clientWidth : null,
          clientHeight: document.documentElement ? document.documentElement.clientHeight : null,
          visualViewportWidth: window.visualViewport ? window.visualViewport.width : null,
          visualViewportHeight: window.visualViewport ? window.visualViewport.height : null,
          visualViewportScale: window.visualViewport ? window.visualViewport.scale : null,
          screenWidth: window.screen ? window.screen.width : null,
          screenHeight: window.screen ? window.screen.height : null,
          devicePixelRatio: window.devicePixelRatio,
          orientation: window.screen && window.screen.orientation ? window.screen.orientation.type : null
        }))();
        """

        evaluateJavaScript(script) { result, error in
            if let error {
                print("[InkflowPad] \(reason) viewport metrics error: \(error.localizedDescription)")
                return
            }

            if let metrics = result as? String {
                print("[InkflowPad] \(reason) viewport metrics: \(metrics)")
            }
        }
    }
}
