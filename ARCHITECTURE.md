# Inkflow Architecture

## Phase 0 Status

This document is the design contract for a clean rebuild of Inkflow in this repository.
The archived predecessor repos are reference-only.
They inform migration and failure analysis, but this codebase is being rebuilt with a simpler architecture and stricter engine boundaries.

## Goals

Priority order:

1. Very smooth handling of large PDFs, including 175 MB+ and 1400+ page textbooks.
2. Excellent iPad Safari and Apple Pencil behavior.
3. Zero page self-movement, zero layout shift, and zero mixed-size loading in the main reader.
4. Reliable writing with no dropped strokes during save, render, or sync.
5. Single-container deployment with one persistent mount.
6. Polished desktop and iPad portrait UI.

## Why This Rebuild Is Less Bug-Prone

The archived reference code shows two patterns that created much of the historical instability:

1. Document-wide state and UI logic were too tightly coupled to the reader.
2. Structural page ordering used integer positions and compensating reorder logic.

Concrete evidence from the archived references:

- the archived `goodnotes-clone` database layer uses `UNIQUE(document_id, position)` with integer positions, plus multi-step shift-and-normalize logic around insert/delete
- the archived `goodnotes-clone` editor route is a very large route component, which is a warning sign for reader coupling and hot-path complexity
- the archived `inkflow` PDF service already moved toward precomputing width and height, which is a good lesson we keep

The new design reduces risk by changing the ownership model:

- Svelte owns app chrome, dialogs, library UI, and inspector surfaces.
- Imperative TypeScript engine modules own scroll, render, page visibility, pointer input, and page-local annotation state.
- The server owns import, page metadata, preview generation, search, export, and storage bootstrap.
- SQLite uses gap-based `REAL` positions instead of integer position shifting as the primary insertion model.

This makes the design less bug-prone because:

- A stroke no longer flows through document-level reactive UI state.
- Page shell dimensions are known before DOM mount and do not depend on render completion.
- Scroll/render/input are coordinated by a small engine boundary instead of cross-cutting framework state.
- Save and sync operate on snapshots and append-only records instead of blocking the active drawing buffer.
- Page insert/delete operations stop depending on fragile row-by-row integer renumbering.

## Top-Level System

```text
+--------------------------------------------------------------+
| Browser                                                      |
|                                                              |
|  Svelte UI layer                                             |
|  - library                                                   |
|  - header + toolbar                                          |
|  - desktop inspector / iPad trays                            |
|  - dialogs, sheets, settings                                 |
|                                                              |
|  Imperative reader engine                                    |
|  - shell layout engine                                       |
|  - scroll + visibility engine                                |
|  - pdf.js render coordinator                                 |
|  - annotation scene + input engine                           |
|  - local draft + save queue                                  |
|  - debug overlay/log emitter                                 |
+------------------------------+-------------------------------+
                               |
                               | HTTP + WebSocket
                               v
+--------------------------------------------------------------+
| Fastify server                                               |
|                                                              |
|  API routes                                                  |
|  - library, folders, documents                               |
|  - uploads / PDF import                                      |
|  - page structure actions                                    |
|  - bookmark, search, export                                  |
|  - auth gate (optional app password)                         |
|  - realtime status and sync                                  |
|                                                              |
|  Services                                                    |
|  - storage bootstrap                                         |
|  - import / optimize / preview                               |
|  - document/page ordering                                    |
|  - search index                                              |
|  - export assembler                                          |
|  - sync coordinator                                          |
|                                                              |
|  SQLite (better-sqlite3, WAL)                                |
|  /app/data/inkflow.db                                        |
|                                                              |
|  Filesystem under /app/data                                  |
|  - uploads                                                   |
|  - temp                                                      |
|  - previews                                                  |
|  - exports                                                   |
|  - logs                                                      |
+--------------------------------------------------------------+
```

## Repository Layout

Planned module layout for the clean rebuild:

```text
/
  client/
    src/
      app/
      components/
      engine/
      routes/
      styles/
      types/
  server/
    src/
      app/
      db/
      routes/
      services/
      ws/
      utils/
  shared/
    src/
      contracts/
      ids/
      math/
      time/
  scripts/
  tests/
  data/                  # runtime-only in local dev, bind-mounted in Docker
```

## Module Boundaries

### Frontend

`client/src/app`
- Svelte application shell, route state, responsive layout mode, and app-level stores for non-hot-path state.

`client/src/components`
- Library cards, folder list, document tiles, dialogs, sheets, toolbar controls, inspector sections.

`client/src/engine`
- Pure imperative modules for hot paths. No Svelte reactivity inside these modules.

Planned engine modules:

- `ReaderSession.ts`
  Creates and coordinates one open-document session.
- `ShellLayout.ts`
  Computes shell width and height from stored page metadata, viewport width, and zoom.
- `VisibilityTracker.ts`
  Computes visible page window and active page with throttled measurement.
- `PdfRenderQueue.ts`
  Manages visible-page renders, cancellation, and scroll-aware priority.
- `ThumbnailQueue.ts`
  Separate queue for thumbnails and side previews.
- `InputRouter.ts`
  Pointer event routing, stylus detection, palm rejection, finger-scroll separation.
- `StrokeScene.ts`
  Per-page live stroke model, canvas invalidation, append-only stroke snapshots.
- `DraftStore.ts`
  Local-first page draft persistence.
- `SaveQueue.ts`
  Background persistence without blocking input.
- `SyncChannel.ts`
  WebSocket subscription and conflict filtering.
- `DebugEvents.ts`
  Timestamped logs and optional overlay feed.

### Backend

`server/src/db`
- SQLite connection bootstrap, WAL configuration, migrations, and transaction helpers.

`server/src/routes`
- Fastify routes only. Thin layer over services.

`server/src/services`
- `libraryService`
- `documentService`
- `pageStructureService`
- `pdfImportService`
- `previewService`
- `searchService`
- `exportService`
- `authService`
- `syncService`

`server/src/ws`
- WebSocket connection registry, presence/status messages, document-scoped broadcast.

`shared/src/contracts`
- Request and response shapes, DTOs, validation schemas, shared enums.

## Non-Negotiable Reader Model

### Fixed Page Shells

The main reader is built around fixed page shells.
Every page shell must know its final width and height before mount.

Inputs:

- stored page width
- stored page height
- viewport width available to the reader column
- current zoom
- known shell padding/gap rules

Formula:

```text
contentWidth = floor(readerColumnWidth * zoom)
contentHeight = floor((pageHeight / pageWidth) * contentWidth)
shellHeight = contentHeight + fixed chrome/overlay padding
```

Rules:

- Outer shell size is set once when the shell is mounted.
- The shell does not resize when PDF pixels arrive.
- Skeletons use the same final shell size as rendered pages.
- The main reader never swaps between small preview pages and full-size pages.
- Thumbnail rail is a separate system and may use server preview images.

### Why This Avoids Whole-Document Rerenders

The reader does not bind document-wide annotation arrays into Svelte component trees.

Instead:

- Each visible page gets a stable shell.
- Each page owns its own render layers.
- Input mutates page-local imperative state.
- Svelte sees only coarse session state such as active tool, zoom, save status, and selected page.

As a result:

- A stroke on page 514 does not ask the framework to reconcile the entire document.
- Save completion does not trigger document-wide page rerender.
- Scroll position changes do not cause all pages to recompose.

## Input Architecture

Pointer events are the foundation.

Rules:

- Apple Pencil writes.
- Finger touch scrolls or pans.
- Stylus-only mode is explicit and reliable.
- `getCoalescedEvents()` is used when available.
- `pointerrawupdate` is evaluated behind a feature gate for Pencil fidelity if it improves actual capture quality.
- Canvas and overlay surfaces suppress selection/callouts and do not expose editable DOM in the writing path.

Important design choices:

- Writing canvases are layered over content, not mixed into selectable text DOM.
- Pointer capture is page-local and released only after final flush.
- Save operations read snapshots, never the mutable live stroke buffer.
- Render queue and save queue cannot synchronously block the pointer pipeline.

## Scroll and Render Architecture

### Visible-Only Rendering

- Full-page PDF renders are limited to visible pages plus a tiny neighbor window.
- Thumbnails use their own queue and cache.
- Background work is cancelable and pauses while active scrolling is detected.
- The system prefers blank same-size shells over aggressive pre-rendering.

### Scroll Stability

- Active page changes are computed from stable shell geometry.
- No snap-to-nearest-page behavior in normal continuous reading.
- No observers are allowed to mutate layout dimensions post-mount.
- Zoom changes trigger one explicit relayout pass for all shells, not piecemeal page resizing.

## Saving and Sync

### Local-First

- Page-local working state is authoritative for live writing.
- Drafts persist locally without waiting for the network.
- Save queue flushes append-only stroke records where possible.
- Replace-style saves are reserved for structural changes or non-append edits.

### Conflict Safety

- Dirty local pages reject stale remote payload application.
- Every draft/save record carries timestamps and monotonic client revision metadata.
- Recovery chooses the newest safe state and never blindly overwrites newer local work with older remote snapshots.

## Data Model

The new schema preserves compatibility with the logical structure the user requested while allowing a cleaner internal implementation.

### Core Tables

```sql
CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#7b8794',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('notebook', 'pdf')),
  cover_color TEXT NOT NULL DEFAULT '#1f5f8b',
  page_count INTEGER NOT NULL DEFAULT 0,
  bookmark_page_id TEXT,
  bookmark_updated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE files (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  page_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  position REAL NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('blank', 'ruled', 'grid', 'dot', 'pdf')),
  source_file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
  source_page_index INTEGER,
  template TEXT,
  width REAL NOT NULL,
  height REAL NOT NULL,
  annotations_json TEXT NOT NULL DEFAULT '[]',
  base_text TEXT NOT NULL DEFAULT '',
  annotation_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### Additional Internal Tables

These support the architecture without breaking import compatibility:

```sql
CREATE TABLE page_drafts (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE stroke_commits (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  op_kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE page_search (
  page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  source_text TEXT NOT NULL,
  annotation_text TEXT NOT NULL
);

CREATE VIRTUAL TABLE page_search_fts USING fts5(
  page_id UNINDEXED,
  document_id UNINDEXED,
  source_text,
  annotation_text,
  tokenize = 'unicode61'
);
```

### Ordering Strategy

`pages.position` is `REAL`, not integer.

Why:

- It avoids the `UNIQUE(document_id, position)` write hazard seen in the archived reference implementation.
- Most inserts become local midpoint inserts instead of whole-tail renumbering.
- Rebalancing becomes rare, explicit, and transactional.

Rules:

- Initial positions are `1024, 2048, 3072, ...` for large gaps.
- Insert between `2048` and `3072` becomes `2560`.
- If gap gets too small, rebalance the document in one transaction.

## Storage Layout

Runtime layout inside the container:

```text
/app/data/
  inkflow.db
  uploads/
  temp/
  previews/
  exports/
  logs/
```

Rules:

- The app creates all directories on boot.
- Uploaded PDFs are stored unchanged except optional linearization/optimization in place.
- Temporary import/export files live under `temp/`.
- Preview artifacts are cached under `previews/`.
- The single bind mount is `./data:/app/data`.

## Deployment Model

Single container, Portainer-friendly:

- Node 20 runtime
- SQLite database in mounted volume
- Fastify serves API and built Svelte frontend
- WebSocket served from the same container and origin
- `qpdf` and Poppler CLI tools installed in the container
- no Redis
- no Postgres
- no second worker service

## Large-PDF Validation Assets

These local files are the current planned validation set:

- Baseline PDF:
  anonymized baseline textbook PDF
  `46 MB`, `875 pages`, letter-size pages
- Stress PDF:
  anonymized stress textbook PDF
  `191 MB`, `1620 pages`
- Extended stress fallback:
  anonymized extended stress PDF
  `117 MB`, `2390 pages`

The stress asset is required for import, first open, scrolling, page rendering, thumbnail generation, search, insert-PDF-pages behavior, bookmark reopen, and export validation.

## Debug and Instrumentation Contract

Debug mode is built in from the start.

It must provide timestamped logs for:

- scroll start/end
- touch momentum start/end
- active page changes
- visible range changes
- shell mount/unmount
- PDF render start/end by page
- save queue start/end
- draft persistence start/end
- WebSocket receive/apply
- page width and zoom recalculations

Planned implementation:

- a lightweight client log ring buffer
- optional on-screen overlay
- structured server logs for import/preview/search/export timings

## Phase Boundaries

Phase 0 defines architecture and migration only.
Phase 1 may implement only:

- Dockerfile
- `docker-compose.yml`
- storage bootstrap
- SQLite schema and migration bootstrap
- library view
- notebook creation
- PDF import pipeline

No reader hot-path code should be implemented until the Phase 0 gate is satisfied.
