# Inkflow iPad Wrapper

This folder contains a minimal native iPad host for the existing self-hosted Inkflow web app.

The wrapper is intentionally small:

- a SwiftUI app entry point
- a `WKWebView` host
- a Pencil squeeze bridge
- an XcodeGen project spec

The web app stays local. The wrapper only loads the configured base URL and forwards Pencil squeeze events into the page via JavaScript.

## What Squeeze Does

The native host listens for Apple Pencil Pro squeeze using `UIPencilInteraction`.

- `preferredSqueezeAction == .showContextualPalette` calls `window.__inkflowDispatchPencilSqueeze({...})`
- `preferredSqueezeAction == .switchPrevious` calls `window.__inkflowDispatchSwitchPreviousTool()`
- `preferredSqueezeAction == .ignore` does nothing

The payload sent to the page is local-only and currently includes the hover anchor point when available:

```ts
{
  clientX?: number
  clientY?: number
  source: "apple-pencil-pro"
}
```

## Base URL

The wrapper loads the web app from a configurable base URL.

Priority:

1. `INKFLOW_BASE_URL` environment variable
2. `InkflowBaseURL` Info.plist value
3. Default `http://127.0.0.1:3000`

Examples:

- Simulator against local dev server: `http://127.0.0.1:5173`
- Physical iPad on the same LAN: `http://192.168.1.20:5173`

## Generate The Xcode Project

This scaffold uses XcodeGen. On a Mac with Xcode installed:

```bash
cd ios-wrapper
xcodegen generate
open InkflowPad.xcodeproj
```

If you do not want to use `xcodegen`, you can still copy the Swift sources into a manual Xcode project.

## Files

- `project.yml` - XcodeGen project spec
- `InkflowPad/Sources/InkflowPadApp.swift` - app entry point
- `InkflowPad/Sources/RootView.swift` - SwiftUI root view
- `InkflowPad/Sources/InkflowBridgeConfiguration.swift` - base URL config
- `InkflowPad/Sources/InkflowWebView.swift` - SwiftUI wrapper around the web view
- `InkflowPad/Sources/InkflowWebViewController.swift` - web view host and Pencil bridge
- `InkflowPad/Resources/Info.plist` - bundle metadata and local networking ATS exceptions

## Notes

- This scaffold assumes iPadOS 18 or later for Pencil squeeze support.
- The wrapper does not bundle the Inkflow web app.
- The page should expose the two bridge functions above before squeeze support is considered complete.
