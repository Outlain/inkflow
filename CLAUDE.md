# Inkflow — Claude Code Project Context

Inkflow is a self-hosted PDF annotation and notebook app (like GoodNotes). Single-container deployment, SQLite + Fastify + Svelte.

## Stack

- **Frontend:** Svelte 4 + TypeScript + Vite
- **Backend:** Node 20 + Fastify + better-sqlite3 (WAL mode)
- **PDF engine:** pdf.js (browser), pdf-lib (export), qpdf + Poppler (server)
- **Realtime:** WebSocket via @fastify/websocket
- **Deployment:** Single Docker container, one persistent mount at `/app/data`

## Key Source Files

### Client — Core Modules (`client/src/lib/`)

| File | Purpose |
|------|---------|
| `pdf.ts` | PDF.js integration — document loading, segment rendering, render cache (100M px desktop / 50M px touch budget) |
| `backgroundDownloader.ts` | Background pre-download of per-page PDFs on slow/medium connections. Priority queue expanding outward from active page |
| `networkMonitor.ts` | Connection quality detection (fast/medium/slow) from PerformanceObserver, Navigator.connection, and manual override |
| `renderScheduler.ts` | Ensures pages render in priority order (closest to active page first). Provides `waitForIdle()` for deferring prefetch |
| `api.ts` | API client — all `fetch()` calls to the backend |
| `annotations.ts` | Stroke creation, erasure, shape paths, stabilization |
| `drafts.ts` | IndexedDB draft persistence for local-first saves |
| `draftConflict.ts` | Merge conflict resolution between local drafts and remote state |
| `strokeSettings.ts` | Pen/pencil/highlighter/eraser preset widths and sizes |
| `activity.ts` | Study session tracking, app session management |
| `router.ts` | Client-side URL routing (library / document views) |
| `reader/layout.ts` | Page layout engine — computes positions from stored dimensions + viewport + zoom |

### Client — Components (`client/src/lib/components/`)

| File | Purpose |
|------|---------|
| `ReaderView.svelte` | Main reader — scroll handling, visible window, page navigation, background downloader integration, save queue |
| `PageShell.svelte` | Single page — skeleton → preview → canvas render pipeline, annotation overlay, pointer input |
| `LibraryView.svelte` | Library browser — folders, documents, import |
| `NetworkToast.svelte` | Connection quality change notifications |
| `DebugOverlay.svelte` | Timestamped event log overlay |

### Server (`server/src/`)

| File | Purpose |
|------|---------|
| `index.ts` | Fastify setup — compression, multipart, websocket, static serving, route registration |
| `config.ts` | Environment variables and defaults |
| `db/schema.ts` | SQLite schema — folders, documents, files, pages, drafts, search FTS |
| `db/database.ts` | SQLite connection bootstrap |
| `routes/library.ts` | REST API — CRUD for folders, documents, pages, files, search, export |
| `routes/activity.ts` | REST API — activity tracking, user setup |
| `routes/realtime.ts` | WebSocket — document sync, presence |
| `services/libraryService.ts` | Core business logic — import, page structure, bookmarks, previews |
| `services/pdfImportService.ts` | PDF import pipeline — linearize, extract metadata, generate previews |
| `services/pdfTools.ts` | qpdf/Poppler CLI wrappers — page extraction, preview generation |
| `services/exportService.ts` | Annotated PDF export via pdf-lib |
| `services/activityService.ts` | Activity/session tracking, reaper for stale sessions |

### Shared (`shared/src/contracts.ts`)

All TypeScript types shared between client and server: `PageRecord`, `FileRecord`, `DocumentBundle`, `Annotation` variants, API request/response shapes.

### Service Worker (`client/public/sw.js`)

Cache-first strategy for per-page PDFs (`/api/pages/:id/pdf`) and full PDF files (`/api/files/:id/content`). Synthesizes 206 range responses from cached full files.

## Architecture Decisions

### Network-Adaptive Rendering

The app detects connection quality and adapts. This is the most complex subsystem.

- **Fast:** PDF.js streams the full file. All previews load. No background downloader.
- **Slow/Medium:** PDF.js loads self-contained per-page PDF extracts (~100-500KB each). Background downloader pre-caches pages expanding outward from the active page. Preview radius is limited. Thumbnail annotations are skipped.

### PDF Rendering Segments

Pages render in thirds (top/middle/bottom). Only viewport-visible segments render first, then remaining segments fill in. This makes pages interactive faster.

### Connection Slot Management

Browsers have ~6 HTTP connections per origin. Three mechanisms manage contention (strongest first):
1. **AbortController** — background downloads abort on page change, freeing slots immediately
2. **Request deferral** — non-active preview images deferred 200ms on slow/medium
3. **Fetch Priority API** — `fetchpriority="high"` on active preview, `priority: 'low'` on background downloads

Priority hints only affect queuing order, NOT in-flight requests. That's why abort and deferral exist.

### Fixed Page Shells

Page dimensions are known before mount (from stored metadata). Shells never resize after mount. No layout shift.

### Local-First Saves

Annotations save to IndexedDB immediately, then flush to server in background. Dirty local pages reject stale remote updates.

## Common Patterns

- **Reactive blocks in Svelte:** `$: if (condition) { ... }` — these run when dependencies change. Be careful about triggering network requests from reactive blocks.
- **Render tokens:** `renderToken++` invalidates in-progress renders. Always check `token === renderToken` after any `await`.
- **Session counters:** The background downloader uses a monotonic session counter to invalidate stale `finally` blocks after `stopBackgroundDownload()`.
- **Gap-based ordering:** Pages use `REAL` positions (1024, 2048, 3072...) for insert-between without renumbering.

## Development

```bash
npm run dev     # Client (5173) + Server (3000)
npm run build   # Production build
npm test        # Vitest
```

## Gotchas

- `getConnectionQuality()` is not reactive in Svelte — it's a function call that reads module state. Wrap in a reactive block that depends on something that changes (like `activePageIndex`).
- `fetchpriority` on `<img>` tags is set at mount time. Changing `isActive` later updates the attribute but doesn't affect an already-in-flight request.
- **Priority only affects queuing, not in-flight requests.** A `priority: 'low'` request already receiving data cannot be preempted. That's why we use AbortController (kills the connection) and request deferral (delays `<img src>` by 200ms) in addition to priority hints.
- `scrollToPage()` bypasses scroll velocity detection. Without the `jumpDistance > 3` guard, navbar navigation would render every intermediate page.
- The service worker cache name is `inkflow-pdf-v2`. The background downloader references it directly in `markCachedPages()`.
- `@fastify/compress` must be registered before routes to compress responses.
- Large annotation payloads (37MB+) need compression. On slow connections, skip loading them for thumbnails entirely.

## Detailed Docs

- [`INTERNALS.md`](./INTERNALS.md) — deep dive into rendering pipeline, background downloading, slot management
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — system design, module boundaries, data model
- [`PERFORMANCE_BUDGETS.md`](./PERFORMANCE_BUDGETS.md) — acceptance targets and measured snapshots
