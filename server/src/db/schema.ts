export const schemaSql = `
  CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#7b8794',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('notebook', 'pdf')),
    cover_color TEXT NOT NULL DEFAULT '#315f85',
    page_count INTEGER NOT NULL DEFAULT 0,
    bookmark_page_id TEXT,
    bookmark_updated_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    storage_key TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    page_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pages (
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
    annotation_revision INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS page_updates (
    id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK (mode IN ('append', 'replace')),
    client_id TEXT NOT NULL,
    client_revision INTEGER NOT NULL,
    base_revision INTEGER NOT NULL,
    annotation_revision INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    annotation_text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_documents_folder ON documents (folder_id);
  CREATE INDEX IF NOT EXISTS idx_documents_updated_at ON documents (updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_files_document ON files (document_id);
  CREATE INDEX IF NOT EXISTS idx_pages_document_position ON pages (document_id, position);
  CREATE INDEX IF NOT EXISTS idx_page_updates_page_created ON page_updates (page_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_page_updates_document_created ON page_updates (document_id, created_at DESC);

  CREATE VIRTUAL TABLE IF NOT EXISTS page_search_fts USING fts5(
    page_id UNINDEXED,
    document_id UNINDEXED,
    content
  );
`;

export const schemaVersion = '2';
