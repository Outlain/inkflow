# Inkflow Issue Log

Use this log during development to record bugs by root cause, not just symptom.

## Entries

### 2026-03-20: Multipart folder field typing bug

- Bug: PDF import route assumed multipart fields always exposed `.value` directly.
- Root cause: `@fastify/multipart` exposes fields as a union of single field, file, or array values.
- Fix: added safe field unwrapping in [`server/src/routes/library.ts`](./server/src/routes/library.ts) before validation.

### 2026-03-20: Multipart field order broke insert-PDF-pages

- Bug: insert-PDF-pages failed with `"Anchor page and placement are required."` even when the client sent both fields.
- Root cause: `request.file()` only made route logic reliable when multipart fields arrived in the expected order around the file part.
- Fix: replaced the route-level upload parsing with an order-independent multipart collector in [`server/src/routes/library.ts`](./server/src/routes/library.ts).

### 2026-03-20: Missing byte-range support would force whole-PDF downloads

- Bug: the PDF content route originally streamed full files only, which would have pushed pdf.js toward unnecessary full-document downloads on large assets.
- Root cause: the route returned a raw stream without parsing the `Range` header or sending `206 Partial Content`.
- Fix: added explicit byte-range handling and `Accept-Ranges` support in [`server/src/routes/library.ts`](./server/src/routes/library.ts).

### 2026-03-20: Search index could appear incomplete after schema expansion

- Bug: large-PDF search could report `indexing: true` and return no results on older documents after the FTS table changed.
- Root cause: the search path trusted existing `page_search_fts` row counts without rebuilding the FTS content for documents created before the newer indexing flow.
- Fix: search now self-heals by rebuilding FTS rows on demand in [`server/src/services/libraryService.ts`](./server/src/services/libraryService.ts), and a full rebuild utility exists in [`scripts/rebuild-search-index.mjs`](./scripts/rebuild-search-index.mjs).

### 2026-03-20: Modal accessibility warnings during build

- Bug: the library modals emitted Svelte accessibility warnings during the first production build.
- Root cause: clickable dialog wrappers relied on inner click handlers, and unlabeled color-swatch buttons lacked accessible names.
- Fix: moved close handling to the backdrop, added dialog `tabindex`, and added explicit labels for color swatches in the library UI.

### 2026-03-20: Page interaction layer emitted Svelte accessibility warnings

- Bug: the pointer-driven page overlay triggered Svelte warnings because a static `div` handled drawing gestures.
- Root cause: the overlay was intentionally pointer-active but lacked explicit presentational semantics.
- Fix: marked the interaction layer as `role="presentation"` and `aria-hidden="true"` in [`client/src/lib/components/PageShell.svelte`](./client/src/lib/components/PageShell.svelte).

### 2026-03-20: Docker verification blocked locally

- Bug: `docker compose up -d --build` could not be completed on one local pass.
- Root cause: the local Docker daemon was unavailable through the socket at that moment.
- Fix: Docker verification had already passed earlier in the session history, and the current repo state still keeps the same single-container deployment model.

### 2026-03-20: Production start script launched in development mode

- Bug: `npm run start` served the API but not the built frontend shell.
- Root cause: the start script did not set `NODE_ENV=production`, so the production static-serving branch never activated.
- Fix: updated [`package.json`](./package.json) so `npm run start` explicitly sets `NODE_ENV=production`.

### 2026-03-20: Active scroll still competed with render and annotation work

- Bug: large-document scrolling could still feel unstable because newly visible pages were allowed to start PDF renders and cold annotation loads while momentum scroll was active.
- Root cause: the reader windowing logic limited how many shells mounted, but it did not pause expensive page work during scroll-active windows.
- Fix: the reader now suspends new PDF renders during active scroll, defers untouched-page annotation loads until scroll settles, and bounds active-page calculation to the visible window in [`client/src/lib/components/ReaderView.svelte`](./client/src/lib/components/ReaderView.svelte), [`client/src/lib/components/PageShell.svelte`](./client/src/lib/components/PageShell.svelte), and [`client/src/lib/reader/layout.ts`](./client/src/lib/reader/layout.ts).

### 2026-03-20: Interrupted Pencil capture could drop very short strokes

- Bug: rapid pen lifts, dots, or Safari-side pointer interruptions could discard in-flight stylus strokes instead of committing them.
- Root cause: the page overlay treated `pointercancel` and lost pointer capture as hard resets, which was too aggressive for fast Pencil interactions on iPad-style browsers.
- Fix: the page shell now finalizes strokes on `pointercancel` and `lostpointercapture`, uses `pointerrawupdate` for denser pen sampling, and clears selection/callout state on pen down in [`client/src/lib/components/PageShell.svelte`](./client/src/lib/components/PageShell.svelte).

### 2026-03-20: Compact iPad reader chrome still felt like squeezed desktop UI

- Bug: the compact reader kept too much header chrome and allowed overlapping trays, which pulled focus away from the document on portrait tablet layouts.
- Root cause: the original compact mode reused the desktop toolbar structure instead of switching to a document-first floating control model.
- Fix: compact mode now uses a minimal header, a floating dark single-row toolbar, icon-first controls, and mutually exclusive page/action trays in [`client/src/lib/components/ReaderView.svelte`](./client/src/lib/components/ReaderView.svelte) and [`client/src/styles.css`](./client/src/styles.css).

### 2026-03-20: First-view PDF pages were spending too much time on iPad-scale raster work

- Bug: large PDF pages felt slow to appear on repeat visits and on first-view iPad reads.
- Root cause: the browser kept only the parsed PDF document in memory, but it re-rasterized every page at full device pixel ratio with a small `256 KB` range chunk size and no rendered-page reuse.
- Fix: the PDF client now uses a bounded in-memory render-surface cache, raises range chunk size to `1 MB`, and caps compact/coarse-pointer render scale in [`client/src/lib/pdf.ts`](./client/src/lib/pdf.ts).

### 2026-03-20: Compact page tray still looked like full-size document cards

- Bug: the compact page tray opened a list whose cards still felt close to full document size instead of true mini previews.
- Root cause: the compact tray reused the desktop thumbnail-card sizing and preview fetch width.
- Fix: compact mode now renders row-style thumbnail cards with smaller preview fetches and compact metadata in [`client/src/lib/components/ReaderView.svelte`](./client/src/lib/components/ReaderView.svelte) and [`client/src/styles.css`](./client/src/styles.css).

### 2026-03-20: Pen contact could still drag the reader during inking

- Bug: Apple Pencil writing could still move the page while drawing, especially when a render or scroll state change overlapped the pen gesture.
- Root cause: the reader allowed the scroll container and annotation layer to remain pan-friendly during active pen contact, so the inking gesture was not treated as a hard scroll-lock window.
- Fix: active pen contact now locks scroll position, pauses cold page work, and switches the annotation layer to `touch-action: none` for the live ink session in [`client/src/lib/components/ReaderView.svelte`](./client/src/lib/components/ReaderView.svelte), [`client/src/lib/components/PageShell.svelte`](./client/src/lib/components/PageShell.svelte), and [`client/src/styles.css`](./client/src/styles.css).

### 2026-03-20: iPad Safari could still pan the outer webpage while inking

- Bug: Apple Pencil could drag the entire browser page on iPad even after reader-local scroll locking was added.
- Root cause: the document reader route still allowed the outer document to exceed the viewport height, so Safari could scroll the page outside the inner reader scroller; Safari stylus touch handling also needed a direct touch-event guard.
- Fix: document view now locks `html` and `body` to a fixed-height reader route, moves scroll responsibility fully into the inner reader scroller, and adds non-passive stylus touch suppression in [`client/src/App.svelte`](./client/src/App.svelte), [`client/src/lib/components/PageShell.svelte`](./client/src/lib/components/PageShell.svelte), and [`client/src/styles.css`](./client/src/styles.css).

### 2026-03-20: Blank skeletons made large PDF pages feel slower than they were

- Bug: visible pages stayed blank until full pdf.js rasterization finished, which made large textbook loads feel slower than the underlying layout actually was.
- Root cause: the main shell intentionally avoided size-changing previews, but it did not yet use same-size preview imagery inside the shell while the sharper raster layer caught up.
- Fix: PDF page shells now display same-size preview images immediately and fade them behind the high-resolution canvas once the full render is ready in [`client/src/lib/components/PageShell.svelte`](./client/src/lib/components/PageShell.svelte) and [`client/src/styles.css`](./client/src/styles.css).

### 2026-03-20: Active pages could stay half-preview and half-sharp

- Bug: a PDF page could remain with one half high-quality and the other half stuck at preview quality even after it became the focused page.
- Root cause: segmented rendering treated the currently visible segments as sufficient for "ready" state, so a focused page that had only rendered its top segment would not necessarily demand the bottom segment to completion.
- Fix: the page shell now distinguishes visible-segment readiness from full-page readiness, always requests both top and bottom segments for the active page, and only fades the preview layer after the whole page is high-quality in [`client/src/lib/components/PageShell.svelte`](./client/src/lib/components/PageShell.svelte).

### 2026-03-20: Compact header swipe testing was hiding the wrong surface

- Bug: the compact reader could reveal the top header while effectively hiding or displacing the always-needed writing toolbar, and the left/right swipe reveal path remained unreliable on iPad Safari.
- Root cause: compact-header state was still coupled to reader padding and relied too heavily on one pointer-event path, so the wrong chrome could appear to move while touch-only Safari gesture delivery remained under-instrumented.
- Fix: compact mode now initializes directly from the real viewport, keeps the writing toolbar separate from reader-content padding, adds both touch and pointer swipe detection paths, and shows a temporary on-screen swipe-debug toast to confirm which event path fired in [`client/src/lib/components/ReaderView.svelte`](./client/src/lib/components/ReaderView.svelte) and [`client/src/styles.css`](./client/src/styles.css).
