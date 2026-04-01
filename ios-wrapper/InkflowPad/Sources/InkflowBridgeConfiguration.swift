import Foundation

enum InkflowBridgeConfiguration {
    static let defaultBaseURL = URL(string: "http://127.0.0.1:3000")!

    static var baseWebURL: URL {
        if let envValue = ProcessInfo.processInfo.environment["INKFLOW_BASE_URL"],
           let envURL = URL(string: envValue.trimmingCharacters(in: .whitespacesAndNewlines)),
           envURL.scheme != nil {
            return envURL
        }

        if let plistValue = Bundle.main.object(forInfoDictionaryKey: "InkflowBaseURL") as? String,
           let plistURL = URL(string: plistValue.trimmingCharacters(in: .whitespacesAndNewlines)),
           plistURL.scheme != nil {
            return plistURL
        }

        return defaultBaseURL
    }
}
