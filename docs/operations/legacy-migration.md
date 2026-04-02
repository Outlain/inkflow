# Inkflow Migration Plan

## Scope

This rebuild preserves the user's requested logical storage model while allowing a cleaner implementation.
Migration support is required for old SQLite databases and existing upload folders, but migration is not allowed to distort the new runtime architecture.

## Reference Sources Inspected

The migration design is based on the archived references:

- archived `goodnotes-clone` database layer
- archived `goodnotes-clone` storage layer
- archived `goodnotes-clone` library routes
- archived `inkflow` schema module
- archived `inkflow` PDF service

## Compatibility Goal

Preserve or import these logical entities:

- `folders(id, title, color, created_at, updated_at)`
- `documents(id, folder_id, title, kind, cover_color, page_count, bookmark_page_id, bookmark_updated_at, created_at, updated_at)`
- `files(id, document_id, storage_key, original_name, mime_type, size, page_count, created_at)`
- `pages(id, document_id, position, kind, source_file_id, source_page_index, template, width, height, annotations_json, base_text, annotation_text, created_at, updated_at)`

Preserve these storage concepts:

- SQLite database under `/app/data`
- uploaded PDFs under `/app/data/uploads`
- temp files under `/app/data/temp`
- preview cache under `/app/data/previews`

## Key Differences Between Old and New

### Legacy kind and template remap

The archived repos are not fully aligned on semantic values:

- archived `inkflow` uses `documents.kind = 'notebook' | 'pdf'`
- `goodnotes-clone` uses `documents.kind = 'note' | 'pdf'`
- archived `inkflow` stores notebook paper type directly on `pages.kind`
- `goodnotes-clone` stores notebook paper as `pages.kind = 'blank'` plus `pages.template`

Migration implication:

- map legacy `note` to new `notebook`
- map `blank + template=ruled|grid|dot` into the new canonical page representation
- preserve `pdf` page kinds directly

### Old Reference Risk: integer positions with uniqueness pressure

In the archived `goodnotes-clone` schema, `pages.position` is integer-based with `UNIQUE(document_id, position)`.
The insert/delete code has to shift rows away, insert, then normalize back, because SQLite checks uniqueness row by row during update.

Migration implication:

- Old rows import cleanly.
- New runtime should convert positions into gap-based `REAL` positions during import or first normalization.

### Old Reference Risk: bookmark semantics tied to page ids

Bookmarks already point to `documents.bookmark_page_id`.

Migration implication:

- Preserve existing page ids when possible.
- If ids must change, maintain a page id mapping table during migration and rewrite `bookmark_page_id`.

### Old Reference Strength: stored page dimensions

The archived schema already stores `pages.width` and `pages.height`.

Migration implication:

- Preserve those values exactly when present.
- Only re-derive dimensions if missing or clearly invalid.

## Migration Modes

### Mode A: Fresh install

- Create schema from scratch.
- Create required directories.
- No import work.

### Mode B: In-place legacy import

Input:

- existing SQLite file
- existing uploads directory

Steps:

1. Open legacy DB read-only.
2. Validate required tables and columns.
3. Copy core rows into the new schema inside a transaction.
4. Convert page positions to new gap-based `REAL` values.
5. Preserve page ids, document ids, and file ids when safe.
6. Copy or hard-link uploads into the new `uploads/` layout.
7. Rebuild search index and preview cache.
8. Write migration report.

### Mode C: Legacy import into an already-running new install

- Same as Mode B, but through an explicit maintenance command.
- Import runs offline against the target data directory while the app is stopped.

## Proposed Migration Script

Planned script:

```text
scripts/migrate-legacy.ts
```

Responsibilities:

- discover legacy DB path and uploads path
- validate schema compatibility
- create backup of target DB if present
- import rows in dependency order
- rewrite positions
- verify page counts and file existence
- emit a migration summary

Expected CLI shape:

```bash
npm run migrate -- \
  --legacy-db /path/to/inkflow.db \
  --legacy-uploads /path/to/uploads \
  --target-data /app/data
```

## Data Rewrite Rules

### Folders

- Preserve ids and timestamps.
- Normalize null or empty titles only if validation requires it.

### Documents

- Preserve ids, folder relationships, bookmark ids, and timestamps.
- Recompute `page_count` from imported page rows if legacy count is wrong.

### Files

- Preserve ids and `storage_key`.
- Verify each referenced upload exists.
- Mark missing uploads in the migration report and skip dependent PDF page references only if absolutely necessary.

### Pages

- Preserve ids where possible.
- Preserve `kind`, `source_file_id`, `source_page_index`, `template`, `width`, `height`, annotation payloads, and text fields.
- Convert old integer positions to gap-based `REAL` positions such as `1024, 2048, 3072, ...`.
- If legacy data uses `kind='blank'` with a notebook `template`, normalize it into the new page semantics without changing the visible paper style.

### Search

- Never trust old search caches.
- Rebuild search index from `base_text` and `annotation_text`.

### Previews

- Never trust old preview caches as canonical data.
- Regenerate lazily on demand in the new cache structure.
- Do not blindly copy preview trees because the archived repos use different naming layouts.

## Migration Safety Checks

Required checks after import:

- all imported documents exist
- `documents.page_count` equals actual page row count
- all `bookmark_page_id` values reference existing imported pages
- all `source_file_id` references resolve
- all upload files exist on disk
- all page dimensions are positive
- page ordering is strictly increasing per document

## What We Intentionally Do Not Import

- transient preview images
- temp files
- websocket/session state
- stale draft caches from the browser

## Why This Migration Strategy Is Safer

- It preserves the logical content model the user requested.
- It does not carry forward the archived runtime structure that caused ordering complexity and reader instability.
- It treats the database as source data, not as an implementation template.
- It rebuilds derived data like previews and search indexes instead of assuming correctness.
