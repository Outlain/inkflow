# Inkflow iPad Wrapper

This folder contains a minimal native iPad host for the existing self-hosted Inkflow web app.

The wrapper is intentionally small:

- a SwiftUI app entry point
- a `WKWebView` host
- a Pencil squeeze bridge
- a launch screen so iPadOS uses the correct viewport sizing
- an XcodeGen project spec

The web app stays local. The wrapper only loads the configured base URL and forwards Pencil squeeze events into the page via JavaScript.

## Why Portrait Was Overzoomed

The important fix was native, not CSS.

On iPad, the wrapper needs a valid launch screen. Without one, iPadOS can run the app with compatibility-style sizing behavior, which makes portrait report the wrong effective viewport and causes the whole app to look overzoomed or horizontally overflow. That is why:

- landscape could look mostly fine
- portrait could look like a horizontally sized layout squeezed into a vertical screen
- the issue affected the whole app, including the library view, not just the PDF reader

The wrapper now includes:

- `InkflowPad/Resources/LaunchScreen.storyboard`
- `UILaunchStoryboardName = LaunchScreen` in `Info.plist`

That change keeps the native app in the normal iPad sizing path, so the web app receives the correct portrait viewport.

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

Important detail:

- `InkflowBaseURL` in `InkflowPad/Resources/Info.plist` overrides the Swift fallback in `InkflowBridgeConfiguration.swift`
- if you only change `defaultBaseURL` in Swift and leave `Info.plist` untouched, the app will still load whatever is in `Info.plist`

Examples:

- Simulator against local dev server: `http://127.0.0.1:5173`
- Physical iPad on the same LAN against Vite dev server: `http://192.168.1.20:5173`
- Physical iPad on the same LAN against the production-style Fastify server: `http://192.168.1.20:3000`

For a physical iPad, the most reliable local path is:

1. run Inkflow on your computer
2. find your computer's LAN IP
3. open `InkflowPad/Resources/Info.plist`
4. change `InkflowBaseURL` to `http://YOUR-LAN-IP:3000`
5. rebuild and reinstall the wrapper app

Example:

```xml
<key>InkflowBaseURL</key>
<string>http://192.168.68.193:3000</string>
```

If the app loads a blank page or the wrong host, check `Info.plist` first.

## Generate The Xcode Project

This scaffold uses XcodeGen. On a Mac with Xcode installed:

```bash
cd ios-wrapper
xcodegen generate
open InkflowPad.xcodeproj
```

Regenerate the Xcode project again whenever you change:

- `project.yml`
- native resource files such as `LaunchScreen.storyboard`
- the native source layout in `InkflowPad/Sources/`

If you do not want to use `xcodegen`, you can still copy the Swift sources into a manual Xcode project.

## Running The Wrapper

Recommended local flow:

```bash
npm run build
npm run start
```

Then point `InkflowBaseURL` at:

```text
http://YOUR-LAN-IP:3000
```

Before debugging the wrapper, verify that the same URL opens from Safari on the iPad. If Safari cannot load it, the wrapper will not load it either.

## Files

- `project.yml` - XcodeGen project spec
- `InkflowPad/Sources/InkflowPadApp.swift` - app entry point
- `InkflowPad/Sources/RootView.swift` - SwiftUI root view
- `InkflowPad/Sources/InkflowBridgeConfiguration.swift` - base URL config
- `InkflowPad/Sources/InkflowWebView.swift` - `WKWebView` host and Pencil squeeze bridge
- `InkflowPad/Resources/Info.plist` - bundle metadata and local networking ATS exceptions
- `InkflowPad/Resources/LaunchScreen.storyboard` - launch screen required for correct iPad sizing

## Notes

- This scaffold assumes iPadOS 18 or later for Pencil squeeze support.
- The wrapper does not bundle the Inkflow web app.
- The page should expose the two bridge functions above before squeeze support is considered complete.
- The wrapper logs viewport metrics to Xcode while debugging portrait sizing issues.
