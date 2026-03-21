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

## Key Docs

- [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- [`RELEASE_GATES.md`](./RELEASE_GATES.md)
- [`MIGRATION.md`](./MIGRATION.md)
- [`PERFORMANCE_BUDGETS.md`](./PERFORMANCE_BUDGETS.md)
- [`ISSUE_LOG.md`](./ISSUE_LOG.md)

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

- The app has built-in defaults for `HOST`, `PORT`, `DATA_DIR`, `MAX_UPLOAD_BYTES`, and `PDF_LINEARIZE_THRESHOLD_BYTES`.
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
- operator docs such as `README.md`, `ARCHITECTURE.md`, and migration notes

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
