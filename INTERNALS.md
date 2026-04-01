# Inkflow Technical Internals

This document explains how the reader engine works under the hood. It covers the page loading pipeline, adaptive network behavior, PDF rendering strategy, background pre-downloading, and scroll/navigation coordination. It is intended for contributors and anyone wanting to understand the system beyond what `ARCHITECTURE.md` covers.

For deployment, configuration, and project overview, see [`README.md`](./README.md).
For high-level system design, see [`ARCHITECTURE.md`](./ARCHITECTURE.md).

---

## Table of Contents

- [Network Quality Detection](#network-quality-detection)
- [Page Loading Pipeline](#page-loading-pipeline)
- [PDF Rendering Strategy](#pdf-rendering-strategy)
- [Preview Images](#preview-images)
- [Background Pre-Downloading](#background-pre-downloading)
- [Scroll and Navigation Coordination](#scroll-and-navigation-coordination)
- [Service Worker Caching](#service-worker-caching)
- [Connection Slot Management](#connection-slot-management)
- [Render Scheduler](#render-scheduler)
- [Dark / Light Theme](#dark--light-theme)

---

## Network Quality Detection

**File:** `client/src/lib/networkMonitor.ts`

The app adapts its behavior based on detected connection speed. There are three quality levels: `fast`, `medium`, and `slow`.

### Detection Signals (in priority order)

1. **Manual override** — the user can force a quality level via Low Data Mode in settings, persisted in `localStorage`.
2. **Measured throughput** — a `PerformanceObserver` measures real `transferSize` and `duration` of HTTP requests. Only transfers over 50KB are sampled to avoid false readings from small JSON API responses. After 4+ samples, the median throughput determines quality:
   - `< 100 KB/s` → slow
   - `< 500 KB/s` → medium
   - `≥ 500 KB/s` → fast
3. **Startup probe** — on startup, the app fetches one or two small first-party probe payloads from `/api/network-probe` and classifies the connection before the reader has produced enough real traffic to stabilize the measured-throughput path.
4. **Navigator.connection API** — `effectiveType`, `downlink`, `rtt`, `type`, and `saveData` from the browser's Network Information API when available. `saveData` forces an immediate `slow` seed.

### Hysteresis

Quality **downgrades happen immediately** to protect the user. Quality **upgrades require 10 seconds of sustained improvement** before applying. This prevents flickering between quality levels on unstable connections while still letting the startup probe and later real traffic improve the initial guess.

The library UI now also exposes the current detection source:

- `manual override`
- `measured traffic`
- `startup probe`
- `browser hint`
- `default fallback`

and includes a `Retest Network` action for cases where the device changes Wi-Fi, VPN, or hotspot state while the app is already open.

### What Each Quality Level Changes

| Setting | Fast | Medium | Slow |
|---------|------|--------|------|
| PDF source | Full file (streamed) | Per-page extract (~100-500KB) | Per-page extract |
| Range chunk size | 1 MB | 256 KB | 128 KB |
| Preview image max width | 960px | 480px | 480px |
| Thumbnail max width | 240px | 180px | 120px |
| Prefetch radius | ±4 pages | ±1 page | 0 (none) |
| Preview radius | All visible | ±2 pages | ±1 page |
| Background pre-download | Off (not needed) | Active | Active |
| Thumbnail annotation loading | Eager | Skipped | Skipped |

The prefetch and preview radii are runtime-configurable through server environment variables:

- `INKFLOW_PREFETCH_RADIUS_FAST|MEDIUM|SLOW`
- `INKFLOW_PREVIEW_RADIUS_FAST|MEDIUM|SLOW`

`INKFLOW_PREVIEW_RADIUS_FAST=all` means "no distance cutoff for eligible visible/working-set pages", not "eagerly fetch every preview in the document."

---

## Page Loading Pipeline

### Document Open

When a user opens a document, `ReaderView.loadDocument()` runs this sequence:

```
fetchDocument(id)              GET /api/documents/:id
       │                       Returns JSON bundle: pages metadata,
       │                       annotations, file records
       │                       (compressed by @fastify/compress)
       ▼
recalcLayout()                 Computes top/left/width/height for every
       │                       page from stored dimensions + viewport width
       ▼
scrollToPage(bookmark)         Scrolls to the bookmarked page (or page 1)
       │
       ▼
startBackgroundDownload()      On slow/medium only: begins pre-downloading
                               per-page PDFs outward from the active page
```

### Single Page Lifecycle

Each visible page is rendered by a `PageShell` component. When a page enters the visible window:

```
┌─────────────────────────────────────────────────────────────────┐
│  1. SKELETON                                                    │
│     Gray placeholder at exact page dimensions.                  │
│     Shown immediately on mount. No network requests.            │
│                                                                 │
│  2. PREVIEW IMAGE                                               │
│     Low-res JPEG loaded via <img> tag.                          │
│     Source: GET /api/pages/:id/preview?width=480                │
│     Replaces skeleton once loaded.                              │
│                                                                 │
│  3. PDF CANVAS RENDER                                           │
│     Full-resolution PDF.js render to <canvas>.                  │
│     Source depends on connection quality:                        │
│       Fast:   PDF.js ranges into the full PDF file              │
│       Slow/Medium: PDF.js loads a per-page extract (~100-500KB) │
│     Canvas overlays the preview with a CSS transition.          │
│     Preview fades out once the canvas is ready.                 │
│                                                                 │
│  4. EAGER OFF-SCREEN SEGMENTS                                   │
│     After visible segments render, remaining segments           │
│     render in the background (see PDF Rendering Strategy).      │
└─────────────────────────────────────────────────────────────────┘
```

### Per-Page PDF Extracts

On slow/medium connections, the app avoids ranging into the full PDF (which can be 81-191 MB). Instead, the server provides self-contained single-page PDF extracts via `GET /api/pages/:id/pdf`. Each extract:

- Contains just one page with embedded fonts and images
- Is typically 100-500KB
- Downloads in a single request (no range requests needed)
- Is cached by the service worker for instant subsequent access

The full PDF streaming approach is only used on fast connections where bandwidth is plentiful.

---

## PDF Rendering Strategy

**Files:** `client/src/lib/pdf.ts`, `client/src/lib/components/PageShell.svelte`

### Segment-Based Rendering

Pages are divided into three vertical segments: `top`, `middle`, and `bottom`. Only the segments currently visible in the viewport are rendered first. This means:

- If the user is looking at the top of a tall page, only the `top` segment renders initially
- The page becomes interactive faster because less data needs to be fetched and rendered
- Remaining segments render eagerly in the background after visible segments complete

```
┌──────────────────────┐
│                      │  ◄── top segment
│                      │
├──────────────────────┤
│                      │  ◄── middle segment
│                      │
├──────────────────────┤
│                      │  ◄── bottom segment
│                      │
└──────────────────────┘
```

### Segment Render Order

Visible segments render first, ordered by how much of each segment overlaps the viewport. If two segments have the same overlap, the one whose center is closer to the viewport center wins; exact ties keep natural top-to-bottom order.

Then remaining off-screen segments render ordered by proximity to the visible area:

- If `top` is visible → renders `middle` then `bottom`
- If `bottom` is visible → renders `middle` then `top`
- If `middle` is visible → renders `top` then `bottom`

This means the most visible part of the page renders first, and the segment the user is most likely to scroll into next renders before the one further away.

### Segment Geometry Source of Truth

The segment boundaries are computed once in `client/src/lib/pdf.ts` using the same device-pixel-aware split math that the rasterizer uses. `PageShell.svelte` then reuses those exact bounds for:

- DOM slot placement
- visible-segment detection
- segment canvas sizing

This matters because independent CSS thirds such as `33.333%` do not always match integer device-pixel splits. On compact/mobile layouts that mismatch can surface as thin horizontal seams, clipped bottoms, or startup stretch while stale geometry settles.

### Render Invalidation

Each PDF page shell tracks a `renderStateKey` that combines:

- page shell geometry (`scale`, `width`, `height`)
- render strategy (`segmented` vs `full-page`)
- connection-driven mode changes that affect which canvas path is active

When that key changes, the page shell cancels queued scheduler work, invalidates in-flight segment renders, and resets readiness state before the next paint. This prevents stale work from landing in a resized shell or from mixing segmented and full-page canvases during startup or network-mode transitions.

### Render Surface Cache

Rendered segments are cached as `ImageBitmap` (or fallback `HTMLCanvasElement`) objects in memory. The cache has a pixel budget:

- Desktop: ~100M pixels (~400MB, ~34 full A4 pages at 2× DPR)
- Touch devices: ~50M pixels (~200MB, ~17 pages)

These defaults are runtime-configurable through:

- `INKFLOW_RENDER_CACHE_DESKTOP_PIXELS`
- `INKFLOW_RENDER_CACHE_TOUCH_PIXELS`

When the budget is exceeded, the oldest cached surfaces are evicted (LRU). Cache hits skip PDF.js entirely — the cached bitmap is drawn directly to the canvas.

### Device Scale

The DPR (device pixel ratio) used for rendering adapts to conditions:

- **Fast connection, desktop (>1080px):** full native DPR for crisp rendering
- **Fast connection, touch:** capped at 2× DPR
- **Slow connection:** no forced DPR downgrade for the final PDF canvas; bandwidth savings come from per-page PDF extracts, reduced preview fetches, and disabled prefetching

---

## Preview Images

**File:** `client/src/lib/components/PageShell.svelte`

Preview images are low-resolution JPEGs generated server-side by Poppler (`pdftoppm`). They serve as a fast visual placeholder while the full PDF.js render completes.

### Preview Radius

Not all visible pages load preview images. The `previewRadius` setting controls how many pages around the active page get previews:

- **Fast:** all visible pages (no limit)
- **Medium:** active page ±2
- **Slow:** active page ±1

Pages outside the radius show a skeleton placeholder until they become active or move within radius.

### Priority, Deferral, and Scroll Gating

On slow/medium connections, preview images for non-active pages are deferred by 200ms. This gives the active page's preview and PDF render a head start on claiming browser connection slots.

- Active page preview: loads immediately with `fetchpriority="high"`
- Neighbor previews: deferred 200ms, then load with `fetchpriority="low"`
- On fast connections: all previews load immediately (no deferral)

The `fetchpriority` attribute is a browser hint that affects request queuing order. It does not affect requests already in flight.

### Scroll Gate (`allowRender`)

On slow/medium connections, preview `<img>` tags are **not mounted** while `allowRender` is false (during fast scroll or large navigation jumps). This prevents intermediate pages from starting preview downloads that would occupy connection slots when the user arrives at the destination.

- `allowRender = false` + preview not yet loaded → `<img>` not in DOM → zero network requests
- `allowRender = false` + preview already loaded → `<img>` stays (no visual flash)
- Fast connections bypass this gate entirely — bandwidth is plentiful

Without this gate, a 100-page navbar jump would queue preview downloads for every page that briefly enters the visible window during the scroll animation. Those downloads occupy the browser's ~6 connection slots, delaying the active page's PDF render.

---

## Background Pre-Downloading

**File:** `client/src/lib/backgroundDownloader.ts`

On slow/medium connections, the background downloader pre-fetches per-page PDFs so they are cached by the service worker before the user scrolls to them. This is the difference between every page requiring a visible loading pause vs. pages rendering instantly from cache.

### How It Works

```
1. Document opens
2. Build a priority queue of all PDF pages
   Priority = |pageIndex - activePageIndex|   (closest pages first)
3. Check service worker cache — skip already-cached pages
4. Start downloading, expanding outward from the active page:

   Active page = 10
   Download order: 9, 11, 8, 12, 7, 13, 6, 14, ...

5. Each download:
   fetch('/api/pages/:id/pdf', { priority: 'low' })
   The browser deprioritizes these vs. the active page's requests.
   The service worker caches the response.

6. Continue until every page in the document is cached.
```

### Concurrency Limits

- **Slow:** 1 concurrent background download
- **Medium:** 2 concurrent downloads
- **Fast:** 3 concurrent downloads (though the downloader is typically not active on fast connections)

### On Page Change

When `activePageIndex` changes:

1. All priorities are recalculated relative to the new active page
2. All in-flight background downloads are **aborted** via `AbortController`
3. Aborted downloads go back to `pending` state
4. The drain restarts, now downloading pages closest to the new active page
5. Previously aborted pages will eventually get their turn again as the queue expands outward

Aborting in-flight downloads is more effective than priority hints because it **actually frees the connection slot immediately**. A `priority: 'low'` request that is already receiving data cannot be preempted by a higher-priority request.

### Session Counter

A monotonic session counter prevents stale async `finally` blocks from corrupting state. When `stopBackgroundDownload()` is called, it resets `activeDownloads` to 0 and increments the session. Any in-flight download's `finally` block checks `mySession === session` and becomes a no-op if the session has advanced.

### Macrotask Drain

`drainQueue()` is always called via `setTimeout(drainQueue, 0)` (macrotask), never synchronously from a download's `finally` block. This prevents tight microtask chains when multiple downloads complete rapidly (e.g., cache hits), which would starve the browser's render loop and freeze the tab.

---

## Scroll and Navigation Coordination

**File:** `client/src/lib/components/ReaderView.svelte`

### The `scrolling` Flag

The `scrolling` flag controls whether pages are allowed to render. When `scrolling = true`, `allowRender = false` is passed to all `PageShell` components, which suspends PDF rendering and cancels in-progress renders.

`scrolling` becomes `true` when:
- Scroll velocity exceeds 2.0 px/ms (fast flicking)
- A navbar jump spans more than 3 pages

`scrolling` becomes `false` when:
- 140ms pass with no scroll events (scroll-end debounce)

This prevents intermediate pages from wasting connection slots with PDF downloads during fast scrolls or long navigation jumps.

### Visible Window

The `visibleWindow` determines which `PageShell` components are mounted in the DOM. It includes the viewport-visible pages plus a buffer:

- During scroll: ±1 extra page beyond the viewport
- When idle: ±2 extra pages beyond the viewport

Pages outside this window are unmounted entirely (no DOM, no network requests).

### Active Page

The active page is the page whose vertical center is closest to the viewport center. It gets:

- `isActive = true` prop (affects preview priority and render scheduling)
- `fetchpriority="high"` on its preview image
- Highest priority in the render scheduler
- The background downloader recenters around it

### Navigation via Navbar

When the user clicks a page number in the navbar (as opposed to scrolling):

1. `scrollToPage()` is called
2. If the jump is >3 pages, `scrolling = true` is set immediately to prevent intermediate pages from rendering
3. The browser smooth-scrolls to the target page
4. The scroll-end timer fires after 140ms of no scroll events
5. `scrolling = false`, rendering begins for the target page

Without the >3 page check, navbar navigation would leave `allowRender = true` during the scroll animation, causing every intermediate page to start (and immediately cancel) PDF downloads.

---

## Service Worker Caching

**File:** `client/public/sw.js`

The service worker intercepts fetch requests matching two URL patterns:

### Per-Page PDFs (`/api/pages/:id/pdf`)

**Strategy: cache-first.** These are small, self-contained, and immutable (the PDF content for a given page never changes).

1. Check the cache — if hit, return immediately (no network)
2. If miss, fetch from network
3. Cache the 200 response for future use
4. Background pre-downloads go through this same path, effectively warming the cache

### Full PDF Files (`/api/files/:id/content`)

**Strategy: cache-first with range request handling.**

- Non-range requests: cache-first like per-page PDFs
- Range requests with a cached full response: the service worker synthesizes a 206 Partial Content response from the cached full file, avoiding a network round-trip
- Range requests without cache: passed through to the network

This means on fast connections, if the full PDF was previously streamed and cached, subsequent range requests from PDF.js are served entirely from the local cache.

---

## Connection Slot Management

Browsers limit concurrent HTTP connections to ~6 per origin (HTTP/1.1). On slow connections, these slots are the critical bottleneck. Multiple systems compete for them:

```
┌───────────────────────────────────────────────────────────┐
│  SLOT 1: Active page preview image (HIGH priority)        │
│  SLOT 2: Active page PDF.js render (AUTO priority)        │
│  SLOT 3: Neighbor preview image (LOW, deferred 200ms)     │
│  SLOT 4: Neighbor preview image (LOW, deferred 200ms)     │
│  SLOT 5: Background PDF pre-download (LOW priority)       │
│  SLOT 6: Background PDF pre-download (LOW priority)       │
└───────────────────────────────────────────────────────────┘
```

### Priority Mechanisms

The app uses three mechanisms to manage slot contention, from strongest to weakest:

1. **AbortController** — terminates in-flight requests, immediately freeing the slot. Used by the background downloader when the active page changes.

2. **Request deferral** — delays setting `<img src>` for non-active previews by 200ms on slow/medium connections. Ensures the active page's requests start first.

3. **Fetch Priority API** — `fetchpriority="high"` on the active page's preview, `priority: 'low'` on background downloads. Affects browser queuing order but cannot preempt in-flight requests.

### Why Priority Alone Is Not Enough

`fetchpriority` is a scheduling hint that only affects how the browser **queues** pending requests. Once a request has been assigned a connection slot and is receiving data, no priority change can preempt it. This is why:

- The background downloader **aborts** all in-flight downloads on page change (not just reprioritizes)
- Non-active preview images are **deferred** by 200ms (not just set to low priority)

---

## Render Scheduler

**File:** `client/src/lib/renderScheduler.ts`

The render scheduler ensures pages render in priority order regardless of DOM mount order. When multiple `PageShell` components request renders simultaneously:

1. Each render job is keued with `priority = |pageIndex - activePageIndex|`
2. The scheduler picks the lowest-priority-number job (closest to active page)
3. Jobs run sequentially — one page renders at a time
4. When the queue drains, `waitForIdle()` promises resolve

On slow/medium connections, `prefetchAdjacentPages()` awaits `waitForIdle()` before firing. This ensures prefetch requests don't start until the active page and its neighbors have finished rendering, avoiding connection slot contention.

---

## Response Compression

**File:** `server/src/index.ts`

The server uses `@fastify/compress` with a 1KB threshold. This compresses JSON API responses (including annotation data which can be 37MB+ uncompressed for large documents) to ~2-3MB with gzip/brotli. On slow/medium connections, thumbnail sidebar annotation loading is skipped entirely to avoid these large payloads.

---

## Dark / Light Theme

**File:** `client/src/lib/theme.ts`, `client/src/styles.css`

### How It Works

The theme system is CSS-only — no JavaScript re-rendering is needed. All theme-sensitive colors are defined as `--ink-*` CSS custom properties in `:root`, and `[data-theme="dark"]` overrides those variables. Switching themes changes a single `data-theme` attribute on `<html>`, and the browser recalculates all `var()` references automatically.

### Flash Prevention

An inline `<script>` in `index.html` runs synchronously before any CSS or JS loads. It reads `localStorage('inkflow-theme')` or checks `prefers-color-scheme`, and sets `data-theme="dark"` on `<html>` immediately if needed. This prevents the page from rendering with light variables and then flashing to dark after the Svelte app mounts.

### What the Theme Does NOT Affect

- **PDF page paper** — stays `#fffdfa` in both themes. PDF content is a rendered bitmap and needs a light background for readability. Notebook templates (ruled, grid, dot) also stay light.
- **Drawing toolbar and stroke popover** — these are dark overlays (`--ink-dark-toolbar`) by design. They use white-on-dark text internally and work in both themes. In dark mode the toolbar background is slightly adjusted for contrast against the dark surrounding UI.
- **Decorative colors** — pen/highlighter colors, sticky note colors, tape strip colors, folder/notebook cover colors are not themed. They are display colors chosen by the user or the system and are independent of light/dark mode.
- **Network toasts** — use semantic background colors (orange for slow, yellow for medium, green for fast) that work independently of the theme.

### System Preference and Persistence

On first visit with no stored preference, the app reads `prefers-color-scheme` from the browser. A `matchMedia` change listener updates the theme live if the OS setting changes and the user hasn't made an explicit choice. Once the user clicks the toggle, their choice is persisted to `localStorage` and the system preference listener is ignored.
