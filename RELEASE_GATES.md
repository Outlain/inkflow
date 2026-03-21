# Inkflow Release Gates

## Phase 0: Architecture and Migration Design

Status: `PASS`

- [x] Architecture summary delivered
- [x] Module boundaries documented
- [x] Data model defined
- [x] Migration approach documented
- [x] Deployment model documented
- [x] Architecture explains why this rebuild is less bug-prone than the archived designs
- [x] Architecture explains how whole-document rerender is avoided
- [x] Architecture explains how fixed page shells work

Phase 0 gate notes:

- Reader architecture is explicitly shell-first and metadata-driven.
- Hot paths are kept out of Svelte state.
- Ordering model switches from fragile integer uniqueness handling to gap-based `REAL` positions.
- Large-PDF validation assets are recorded with anonymous baseline/stress labels and measured sizes.

## Phase 1: Storage, Deployment, and Library

Status: `PASS`

- [x] `docker compose up` works
- [x] Portainer-friendly stack exists
- [x] One persistent mount only: `./data:/app/data`
- [x] SQLite schema created with WAL mode
- [x] Imported PDFs appear in library
- [x] Notebook creation works: blank, ruled, grid, dot
- [x] Migration/import path documented
- [x] Healthcheck passes
- [x] Required directories auto-create in `/app/data`

Phase 1 gate notes:

- Verified locally with the built production server plus live API requests.
- Verified built frontend bundle serving from Fastify on `/` and `/assets/*`.
- Verified notebook creation, folder creation, and PDF import with:
  - anonymized stress textbook PDF (`1620` pages, `191 MB`)
  - anonymized baseline textbook PDF (`875` pages, `46 MB`)
- Verified `docker compose up -d --build` and healthy container earlier in the session history.
- Added a dedicated [`docker-compose.portainer.yml`](./docker-compose.portainer.yml) that pulls `ghcr.io/outlain/inkflow-two:latest`.
- Added [`.github/workflows/publish-ghcr.yml`](./.github/workflows/publish-ghcr.yml) so GitHub can publish multi-arch images directly to GHCR.

## Phase 2: Stable Continuous Reader Shell

Status: `ENGINE PASS, PHYSICAL IPAD QA BLOCKED`

- [x] No shell size changes after mount
- [x] No mixed-size pages in main reader
- [x] No page self-movement during first load
- [x] Automated layout-stability checks pass
- [ ] Manual iPad scroll pass completed

Phase 2 gate notes:

- Main reader now uses metadata-derived fixed shells only.
- Shell sizing is driven by stored page width/height, center viewport width, and zoom before shell mount.
- Reader work is windowed to visible pages plus tiny overscan, so off-screen pages do not participate in live rendering.
- Active-page resolution is now bounded to the visible window instead of scanning the whole document on every scroll frame.
- New PDF renders are suspended during active scroll, and untouched-page annotation fetches are deferred until scroll settles.
- Automated coverage lives in `client/src/lib/reader/layout.test.ts`.
- Physical iPad Safari scroll QA is still blocked by environment availability in this session.

## Phase 3: PDF Rendering and Large-PDF Optimization

Status: `LIVE LARGE-PDF WORKFLOW PASS, PHYSICAL SCROLL QA BLOCKED`

- [x] 175 MB+ PDF import succeeds
- [ ] 1400+ page PDF opens and scrolls acceptably
- [ ] No scroll freeze during first-load window
- [x] No background render storm while scrolling
- [x] Performance budgets documented and met or explicitly explained
- [x] Search works server-side for large PDFs

Phase 3 gate notes:

- Added byte-range responses on `/api/files/:fileId/content` for pdf.js.
- Added pdf.js worker-based rendering with visible-page-only canvas work.
- Added preview generation and thumbnail rail separation from main reader shells.
- The client now keeps a bounded in-memory cache of recently rasterized page surfaces, so revisiting nearby pages does not force a full rerender each time.
- Compact/coarse-pointer readers now use a capped render device scale, and pdf.js range chunk size was raised from `256 KB` to `1 MB` to reduce small round-trip overhead on large LAN-served PDFs.
- Main reader shells now show same-size preview images immediately while the higher-resolution canvas catches up, so visible pages no longer present as blank shells during first-view loads.
- Visible PDF shells now sharpen in top/bottom segments over the same-size preview layer, so the currently viewed portion of a page can resolve before the entire page finishes rasterizing.
- Fresh validation on 2026-03-20 against current build:
  - Re-imported anonymized baseline PDF (`875` pages) through the current pipeline in `11.95s`.
  - Re-imported anonymized stress PDF (`1620` pages, `191 MB`) through the current pipeline in `31.65s`.
  - Verified server-side search hits on freshly imported baseline and stress PDFs.
  - Verified large-PDF byte-range serving on the fresh stress import: `206 Partial Content`.
  - Verified deep-page preview generation on the fresh stress import: `200 image/jpeg` in `1.08s`.
  - Verified large-document export on the fresh stress import: `200` and `192,497,151` bytes in `2.43s`.
- Remaining gate work is physical reader smoothness validation on iPad Safari, not missing large-PDF plumbing.

## Phase 4: Pencil Input Engine

Status: `INPUT HARDENED, PHYSICAL IPAD/PENCIL QA BLOCKED`

- [ ] No dropped dots
- [ ] No lost quick pen-lift strokes
- [ ] Pencil does not move page while writing
- [ ] Finger scroll does not block writing
- [ ] No Safari selection or callout artifacts
- [x] Stylus-only mode works reliably in code path
- [ ] Manual iPad QA pass completed

Phase 4 gate notes:

- Pointer Events and coalesced events are wired into page-local overlays.
- Added `pointerrawupdate` handling for pen paths, selection clearing on stylus down, and context-menu suppression on the writing surface.
- Pointer cancellation and lost capture now finish the in-flight stroke instead of discarding rapid dots or short pen-lift strokes.
- Pen/highlighter append strokes locally first, eraser performs local replace operations, and touch-friendly scroll remains separate from stylus writing.
- Active pen contact now locks the reader scroll position, pauses new PDF renders plus cold annotation fetches, and flips the ink overlay to `touch-action: none` for the live stroke window.
- Document view now locks the outer page to the viewport and routes all scrolling through the inner reader scroller, plus it adds a non-passive stylus touch guard for Safari-specific Pencil panning.
- Physical iPad Safari + Apple Pencil validation is still required before this phase can be marked fully passed.

## Phase 5: Local-First Save/Sync

Status: `CODE COMPLETE, MANUAL WRITE-DURING-SAVE QA PENDING`

- [ ] Writing continues while saving
- [x] Save-state UI does not stall input
- [x] Remote updates do not overwrite dirty local edits
- [x] Append-only save path works where applicable
- [x] Draft recovery is timestamp-aware
- [ ] Manual continuous-writing QA pass completed

Phase 5 gate notes:

- Added page-local runtime state, IndexedDB draft persistence, and per-page background save queues.
- Added append saves for strokes and guarded replace saves for structural page annotation edits.
- Added document-scoped WebSocket sync with dirty-page protection.

## Phase 6: Advanced Document Actions

Status: `PASS`

- [x] Insert blank page before/after works
- [x] Insert PDF pages before/after works
- [x] Delete page works
- [x] Delete document works
- [x] Delete folder works
- [x] Bookmark page works
- [x] Reopen to bookmark works
- [x] No SQLite position conflicts

Phase 6 gate notes:

- Blank-page insert, PDF-page insert, delete page, bookmark set, and reopen were verified with live API checks.
- Added a multipart collector so insert-PDF-pages no longer depends on form-field order.
- Gap-based page positions remain ordered and unique under insertion/deletion, with automated coverage in `server/src/services/libraryService.test.ts`.

## Phase 7: Shapes and Polish

Status: `COMPACT UI POLISH LANDED, PHYSICAL IPAD USABILITY QA BLOCKED`

- [x] Shapes creation works
- [x] Shapes move/resize works
- [x] Fill toggle works
- [x] Border style controls work
- [ ] iPad portrait toolbar remains compact and usable
- [x] No layout regressions introduced

Phase 7 gate notes:

- Shape tool now supports rectangle, ellipse, triangle, and diamond with drag-create plus move/resize handles.
- Compact mode now uses a minimal header, a floating dark single-row toolbar over the document, icon-first tool controls, and mutually exclusive page/action trays.
- The compact page tray now uses smaller row-style mini previews instead of desktop-scale thumbnail cards.
- Compact header reveal no longer changes reader-content padding, and the current iPad troubleshooting build exposes both touch and pointer swipe detection through a temporary on-screen toast.
- Shape controls remain integrated into the compact toolbar path, but the final iPad portrait ergonomics still need physical-device QA.

## Phase 8: Export, Docs, and Hardening

Status: `CODE/DOCS PASS, PHYSICAL QA CLOSEOUT BLOCKED`

- [x] Merged annotated PDF export works
- [x] Production README exists
- [x] Tuning guidance documented
- [x] Migration tooling works
- [x] Clean production build passes
- [x] Known-bug list resolved or explicitly justified
- [x] Final verification summary written

Phase 8 gate notes:

- Added merged annotated PDF export using `pdf-lib`.
- Added `scripts/rebuild-search-index.mjs` and `scripts/import-legacy.mjs`.
- `npm run build` and `npm test` both pass on 2026-03-20 after the latest reader/input hardening.
- Final verification includes a fresh large-PDF import plus search, preview, bookmark, save, blank insert, PDF insert, export, and reopen checks.
- Remaining blocker is physical iPad Safari + Apple Pencil QA, which cannot be completed from this environment alone.
