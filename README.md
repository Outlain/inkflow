# Inkflow

Inkflow is a self-hosted Goodnotes-style notebook and PDF annotation app rebuilt from scratch with a simpler, shell-first architecture.

The rebuild is optimized first for:

1. Very large PDFs
2. Stable page layout in the continuous reader
3. Apple Pencil-friendly input paths
4. Local-first saves
5. Single-container deployment

## Current Status

Implemented in this repository today:

- Library view with folders, notebooks, and PDF import
- Continuous reader with fixed page shells
- pdf.js page rendering with byte-range PDF loading
- Separate thumbnail preview pipeline
- Server-side PDF text search
- Pencil-oriented pen/highlighter/eraser input path
- Local-first page state, IndexedDB drafts, and background save queue
- WebSocket document sync that does not overwrite dirty local pages
- Insert blank pages and insert PDF pages before/after
- Delete page/document/folder
- Bookmark current page and reopen to bookmark
- Shape creation, move, resize, fill, and border-style controls
- Annotated PDF export
- Optional iPad `WKWebView` wrapper scaffold for Apple Pencil Pro squeeze, launch-screen-correct viewport sizing, and LAN-hosted local testing

Recent annotation performance work:

- live pen/pencil/highlighter preview is isolated from committed page annotations
- append saves and IndexedDB draft writes are batched instead of firing per stroke
- active-page thumbnails are deferred while inking and redraw at thumbnail resolution
- pure ink appends avoid unnecessary page-text rescans and server search reindexing

Fresh large-PDF workflow validation now passes on the current build, including import, search, preview, bookmark, save, blank insert, PDF insert, and export on a 1620-page / 191 MB physics PDF.

Physical iPad Safari + Apple Pencil QA is still required for the strict release gates around scroll feel, rapid dots/pen lifts, and compact-toolbar ergonomics.

## Stack

- Frontend: Svelte + TypeScript + Vite
- Reader/input/render hot path: imperative TypeScript modules
- Backend: Node 20 + TypeScript + Fastify
- Database: SQLite via `better-sqlite3` with WAL
- Browser PDF engine: `pdf.js`
- Export: `pdf-lib`
- Server PDF optimization: `qpdf`
- Server previews and text extraction: Poppler CLI tools (`pdfinfo`, `pdftoppm`, `pdftotext`)
- Realtime: WebSocket
- Deployment: single container, single persistent mount

## Documentation

- [`docs/README.md`](./docs/README.md) — documentation map and file-purpose guide
- [`docs/architecture/system-overview.md`](./docs/architecture/system-overview.md) — high-level system design, module boundaries, and data model
- [`docs/architecture/reader-internals.md`](./docs/architecture/reader-internals.md) — reader loading, rendering, caching, and network behavior
- [`docs/status/release-gates.md`](./docs/status/release-gates.md) — current phase status and latest consolidated verification summary
- [`docs/operations/legacy-migration.md`](./docs/operations/legacy-migration.md) — legacy import plan, compatibility rules, and safety checks
- [`docs/reference/performance-budgets.md`](./docs/reference/performance-budgets.md) — acceptance budgets and tuning guardrails
- [`docs/troubleshooting/resolved-issue-history.md`](./docs/troubleshooting/resolved-issue-history.md) — resolved issue history and debugging context
- [`ios-wrapper/README.md`](./ios-wrapper/README.md) — optional native iPad wrapper setup and behavior notes

Dated validation snapshots now live under [`docs/archive/`](./docs/archive/).

## Local Development

Install dependencies:

```bash
npm install
```

Run the app in development:

```bash
npm run dev
```

- Client dev server: `http://localhost:5173`
- Backend dev server: `http://localhost:3000`

Build production assets:

```bash
npm run build
```

Run the production server locally:

```bash
npm run start
```

Run tests:

```bash
npm test
```

### Optional iPad Wrapper

If you want real Apple Pencil Pro squeeze support, the web app alone is not enough. Use the native wrapper under [`ios-wrapper/`](./ios-wrapper/).

Important setup points:

- set `InkflowBaseURL` in [`ios-wrapper/InkflowPad/Resources/Info.plist`](./ios-wrapper/InkflowPad/Resources/Info.plist) to your backend's reachable URL
- for a physical iPad on the same LAN, use your computer's LAN IP such as `http://192.168.1.20:3000`
- `Info.plist` overrides the Swift fallback URL in [`ios-wrapper/InkflowPad/Sources/InkflowBridgeConfiguration.swift`](./ios-wrapper/InkflowPad/Sources/InkflowBridgeConfiguration.swift)
- regenerate the Xcode project with `cd ios-wrapper && xcodegen generate` when wrapper resources or project structure change
- the wrapper now includes a launch screen because iPadOS viewport sizing can break in portrait without one

## Docker / Portainer

Build locally from source:

```bash
docker compose up -d --build
```

What the default [`docker-compose.yml`](./docker-compose.yml) is doing:

- `ports: "3000:3000"` exposes the app
- `volumes: ./data:/app/data` is the single required persistent mount
- `NODE_ENV`, `HOST`, `PORT`, and `DATA_DIR` make the runtime behavior explicit
- `MAX_UPLOAD_BYTES` and `PDF_LINEARIZE_THRESHOLD_BYTES` are optional tuning values
- `INKFLOW_RENDER_CACHE_*`, `INKFLOW_PREFETCH_RADIUS_*`, and `INKFLOW_PREVIEW_RADIUS_*` are optional reader tuning values
- the `healthcheck` asks Docker to probe the app's `/health` endpoint from inside the container

What each environment variable actually changes:

- `NODE_ENV=production`
  Inkflow serves the built Svelte app and static assets directly from Fastify only in production mode. In development mode, the backend does not serve the frontend bundle and is expected to run beside the Vite dev server.
- `HOST=0.0.0.0`
  This is the network interface Fastify binds to. Inside Docker, `0.0.0.0` is important because `127.0.0.1` would make the app reachable only from inside the container.
- `PORT=3000`
  This is the internal Fastify listen port. Docker then maps host port `3000` to that container port with `ports: "3000:3000"`.
- `DATA_DIR=/app/data`
  This is the root runtime storage directory. Inkflow creates and uses `inkflow.db`, `uploads/`, `temp/`, `previews/`, `exports/`, and `logs/` under this path.
- `MAX_UPLOAD_BYTES=1073741824`
  This sets both Fastify's overall request body limit and the multipart file upload limit. In the current code, uploads larger than this are rejected before import.
- `PDF_LINEARIZE_THRESHOLD_BYTES=25165824`
  This controls when Inkflow asks `qpdf` to linearize an uploaded PDF. Files smaller than the threshold are moved directly into storage; larger files go through `qpdf --linearize` first so range-based viewing works better on large documents.
- `INKFLOW_RENDER_CACHE_DESKTOP_PIXELS=100000000`
  Client-side rendered PDF surface cache budget for desktop-class devices. `100000000` pixels is about `400 MB` of raw RGBA surface memory before browser overhead.
- `INKFLOW_RENDER_CACHE_TOUCH_PIXELS=50000000`
  Same cache budget for touch devices. Lower by default to reduce iPad/mobile memory pressure.
- `INKFLOW_PREFETCH_RADIUS_FAST=4`, `INKFLOW_PREFETCH_RADIUS_MEDIUM=1`, `INKFLOW_PREFETCH_RADIUS_SLOW=0`
  How many pages around the active page Inkflow proactively warms for PDF access. Higher values improve likely next-page readiness but cost more network, CPU, and memory.
- `INKFLOW_PREVIEW_RADIUS_FAST=all`, `INKFLOW_PREVIEW_RADIUS_MEDIUM=2`, `INKFLOW_PREVIEW_RADIUS_SLOW=1`
  How far from the active page preview JPEGs are allowed to load. `all` means "no distance cutoff for visible/working-set pages", not "download previews for the whole document at once."

How the healthcheck works:

- Docker runs `node -e "fetch('http://127.0.0.1:3000/health')..."` inside the container on a schedule.
- If `/health` returns a successful response, Docker marks the container `healthy`.
- If it fails repeatedly, Docker marks it `unhealthy`.
- This does not change how Inkflow itself works and does not replace the `restart` policy. It mainly improves observability in Docker and Portainer, and makes it easier to tell the difference between "container process is running" and "app is actually responding".

Minimal source-build compose example:

```yaml
services:
  inkflow:
    build: .
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
```

Minimal GHCR / Portainer pull example:

```yaml
services:
  inkflow:
    image: ghcr.io/outlain/inkflow:latest
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
```

Notes:

- The app has built-in defaults for `HOST`, `PORT`, `DATA_DIR`, `MAX_UPLOAD_BYTES`, `PDF_LINEARIZE_THRESHOLD_BYTES`, and the `INKFLOW_*` reader tuning variables above.
- The container image also sets `NODE_ENV=production`, `HOST=0.0.0.0`, `PORT=3000`, and `DATA_DIR=/app/data`.
- In practice, the only required pieces are the port mapping and the `./data:/app/data` mount.
- Keeping the full compose file is still useful because it makes production behavior explicit, preserves the large-upload defaults, and keeps health reporting visible in Portainer.

Deploy in Portainer from GHCR:

1. Push this repository to GitHub.
2. Let the `Publish GHCR Image` workflow run on `main` or create a tag like `v0.1.0`.
3. In Portainer, deploy the stack from [`docker-compose.portainer.yml`](./docker-compose.portainer.yml).
4. If the package is private, log the Docker host into GHCR first with a GitHub token that has `read:packages`.

The published image path is:

```text
ghcr.io/outlain/inkflow:latest
```

Portainer-ready stack file:

```bash
docker compose -f docker-compose.portainer.yml up -d
```

Persistent data mount:

```text
./data:/app/data
```

The container auto-creates everything it needs inside `/app/data`.
Both compose files keep the deployment single-container and single-volume.

## Repository Hygiene

This repository is meant to stay small, source-focused, and GHCR-friendly.

Keep in GitHub:

- application source under `client/`, `server/`, and `shared/`
- deployment files like `Dockerfile`, compose files, and the GHCR workflow
- operator docs such as `README.md`, `docs/`, and subsystem READMEs like `ios-wrapper/README.md`

Keep local only:

- `./data/` runtime state, uploaded PDFs, previews, exports, and SQLite files
- `node_modules/`, `dist/`, coverage output, logs, and editor caches
- ad hoc test PDFs and other large local validation assets

The ignore files are set up so those local-only artifacts stay out of GitHub and out of the Docker build context.

### GHCR Publishing

This repository now includes [`.github/workflows/publish-ghcr.yml`](./.github/workflows/publish-ghcr.yml).

It publishes a multi-architecture image to GHCR on:

- pushes to `main`
- tags matching `v*`
- manual workflow dispatch

Published tags include:

- `latest` on the default branch
- branch refs like `main`
- version tags like `v0.1.0`
- immutable `sha-*` tags

### GHCR Troubleshooting

If the publish workflow fails with `permission_denied: write_package`, the most common cause is that the package path already exists in GHCR but is not writable by this repository's workflow token.

Check these in GitHub:

1. Open the package at `ghcr.io/outlain/inkflow`.
2. In package settings, make sure the repository `Outlain/inkflow` has Actions access.
3. If this package was created by an older repo, either grant the new repo access or delete the stale package and let the workflow recreate it.
4. In repository Settings -> Actions -> General, make sure workflow permissions allow write access if your org or repo policy has restricted `GITHUB_TOKEN`.

This repository is intended to publish with the standard GitHub Actions `GITHUB_TOKEN`. A fresh repo plus a fresh package path should work without adding custom GHCR secrets.

## Data Layout

Inkflow creates these paths automatically:

```text
/app/data/inkflow.db
/app/data/uploads/
/app/data/temp/
/app/data/previews/
/app/data/exports/
/app/data/logs/
```

## Required Native Tools

Install these on the server or bake them into the container image:

- `qpdf`
- `pdfinfo`
- `pdftoppm`
- `pdftotext`

Without them:

- Large-file linearization falls back to plain file moves
- Preview generation is unavailable
- PDF text extraction/search indexing is limited

## Helpful Scripts

Rebuild the search index from `pages.base_text` and `pages.annotation_text`:

```bash
npm run rebuild-search-index
```

Import legacy SQLite/uploads data into the new app layout:

```bash
npm run import-legacy -- --source-db /path/old.db --source-uploads /path/old/uploads --target-data-dir ./data
```

## Tuning Notes

- Keep `DATA_DIR` on fast local storage.
- For very large PDFs, prefer leaving qpdf linearization enabled.
- The reader depends on stored page dimensions. Avoid editing those values manually.
- Search and preview generation are intentionally server-side for large imported PDFs.
- The main reader uses full-size shells only. Thumbnails and previews are separate on purpose.

### Annotation Performance Notes

The main annotation freeze that showed up on iPad was not a single server or cache limit. It was a client backlog problem caused by several page-size-dependent tasks stacking together after each stroke:

- live preview work was previously coupled to the committed annotation list
- committed strokes forced repeated SVG path regeneration as the page got denser
- the active-page thumbnail could redraw locally while the user was still writing
- IndexedDB draft writes and save draining could wake up between rapid strokes

The current pipeline is designed to keep active inking ahead of background durability work:

- live inking draws into a dedicated preview stroke layer
- committed stroke path data is cached
- active-page thumbnail redraws are deferred during inking and render at thumbnail size
- append saves and draft persistence wait for a short idle window before flushing

If very dense pages still hit a hard limit in the future, the next architectural step is to move committed ink off large live SVG trees and onto a rasterized canvas layer, then eventually move from full-page JSON snapshots toward chunked ink storage.

## Large-PDF Validation Used During Development

Validated against real artifacts, not only synthetic samples:

- baseline textbook PDF: `875` pages, `46 MB`
- stress textbook PDF: `1620` pages, `191 MB`

Fresh current-pipeline validation on 2026-03-20 included:

- import
- server-side search
- insert-PDF-pages
- range-based PDF file serving
- export
