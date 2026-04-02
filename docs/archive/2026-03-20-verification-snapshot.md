# Inkflow Verification Snapshot (Archived)

This document preserves the detailed verification pass from `2026-03-20`.
For current release status, use [`../status/release-gates.md`](../status/release-gates.md).

Date: 2026-03-20

## Automated Checks

- `npm run build`: PASS
- `npm test`: PASS
- Layout engine deterministic shell sizing: PASS
- Visible-window active-page calculation on large layouts: PASS
- SQLite insert/delete ordering tests: PASS
- Append vs replace save behavior tests: PASS
- Draft timestamp precedence tests: PASS
- PDF import integration test: PASS
- Insert-PDF-pages integration test: PASS
- Bookmark reopen integration test: PASS

## Live Runtime Checks Performed

- Production server start on `http://127.0.0.1:3000`: PASS
- `GET /health`: PASS
- `GET /api/library`: PASS
- `GET /api/documents/:id`: PASS on large imported documents
- `GET /api/files/:id/content` byte-range response (`206 Partial Content`): PASS
- `GET /api/pages/:id/preview`: PASS on deep large-PDF page
- `POST /api/pages/:id/annotations` append save: PASS on deep large-PDF page
- `POST /api/documents/:id/pages/blank`: PASS on large imported document
- `PATCH /api/documents/:id/bookmark`: PASS on deep large-PDF page
- `GET /api/documents/:id/search`: PASS on freshly imported baseline and stress PDFs
- `POST /api/documents/:id/pages/import-pdf`: PASS after multipart fix, including large-document insertion target
- `GET /api/documents/:id/export`: PASS on a freshly imported and modified 1620-page document
- `GET /api/documents/:id` reopen after bookmark/save/insert flow: PASS

## Real PDF Assets Used

- Anonymized baseline textbook PDF
  - Fresh import on current pipeline: PASS
  - Server-side search on current pipeline: PASS
  - Insert-PDF-pages source on current pipeline: PASS
  - Fresh baseline comparison import on current build: PASS (`875` pages, import `11.95s`)
- Anonymized stress textbook PDF
  - Fresh import on current pipeline: PASS (`1620` pages, `191 MB`, import `31.65s`)
  - Large-document search: PASS (`40` hits for the test query, first hit page index `2`)
  - Deep-page preview generation: PASS (`200 image/jpeg`, `1.08s`)
  - Deep-page bookmark save/reopen: PASS on page `1418`
  - Deep-page append annotation save: PASS (`revision 1`)
  - Insert blank page after page `1418`: PASS (`1621` pages; `pdf`, `grid`, `pdf`)
  - Insert baseline pages after page `1418`: PASS (`1623` pages; `pdf`, `pdf`, `pdf`, `grid`)
  - Byte-range content request: PASS (`206 Partial Content`)
  - Export after annotation and structural edits: PASS (`200`, `192,497,151` bytes, `2.43s`)

## Measured Runtime Snapshot

- Large stress import: `31.65s`
- Large search query: `203ms`
- Large bookmark update: `26ms`
- Large range response setup: `2.43ms`
- Deep-page preview generation: `1.08s`
- Deep-page append save: `10.26ms`
- Large blank-page insert: `45.44ms`
- Large insert-PDF-pages transaction: `1.64s`
- Large export: `2.43s`
- Baseline import: `11.95s`
- Baseline search query: `22.72ms`

## Gate Snapshot

- Phase 0: PASS
- Phase 1: PASS
- Phase 2: Engine pass, physical iPad QA blocked
- Phase 3: Live large-PDF workflow pass, physical iPad scroll QA blocked
- Phase 4: Input hardened, physical Pencil QA blocked
- Phase 5: Code complete, manual write-during-save QA pending
- Phase 6: PASS
- Phase 7: Compact polish landed, physical iPad usability QA blocked
- Phase 8: Code/docs pass, physical QA closeout blocked

## Remaining Non-Code Blockers

- Physical iPad Safari scroll QA on the current reader build
- Physical Apple Pencil QA for dots, rapid pen lifts, stylus-only writing, and page stability
- Physical compact-toolbar usability review in iPad portrait
- Physical continuous-writing-during-save QA
