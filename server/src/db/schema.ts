/**
 * SQLite schema DDL — all tables, indexes, and the FTS5 virtual table for full-text search.
 * Executed on startup via database.ts. Uses IF NOT EXISTS for idempotent initialization.
 */

export const schemaSql = `
  -- Core library tables
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

  -- position is a REAL for gap-based ordering (1024, 2048, ...) allowing insert-between
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

  -- Annotation update audit log for conflict resolution
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

  -- Indexes for common query patterns
  CREATE INDEX IF NOT EXISTS idx_documents_folder ON documents (folder_id);
  CREATE INDEX IF NOT EXISTS idx_documents_updated_at ON documents (updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_files_document ON files (document_id);
  CREATE INDEX IF NOT EXISTS idx_pages_document_position ON pages (document_id, position);
  CREATE INDEX IF NOT EXISTS idx_page_updates_page_created ON page_updates (page_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_page_updates_document_created ON page_updates (document_id, created_at DESC);

  -- Full-text search for page content (base PDF text + annotation text)
  CREATE VIRTUAL TABLE IF NOT EXISTS page_search_fts USING fts5(
    page_id UNINDEXED,
    document_id UNINDEXED,
    content
  );

  -- Activity tracking tables
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    avatar_color TEXT NOT NULL DEFAULT '#2d6e96',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS activity_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_type TEXT NOT NULL CHECK (session_type IN ('app', 'study')),
    document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
    device_id TEXT NOT NULL,
    device_label TEXT,
    started_at TEXT NOT NULL,
    last_heartbeat_at TEXT NOT NULL,
    ended_at TEXT,
    idle_timeout_secs INTEGER NOT NULL DEFAULT 300,
    active_secs INTEGER NOT NULL DEFAULT 0,
    heartbeat_count INTEGER NOT NULL DEFAULT 0,
    first_page_index INTEGER,
    last_page_index INTEGER,
    page_range_low INTEGER,
    page_range_high INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user_start ON activity_sessions (user_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_doc_start ON activity_sessions (document_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_open ON activity_sessions (ended_at) WHERE ended_at IS NULL; -- partial index for reaper
  CREATE INDEX IF NOT EXISTS idx_sessions_device ON activity_sessions (device_id, started_at);

  CREATE TABLE IF NOT EXISTS activity_events (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id TEXT REFERENCES activity_sessions(id) ON DELETE SET NULL,
    document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
    page_id TEXT,
    event_type TEXT NOT NULL,
    metadata_json TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_events_user_created ON activity_events (user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_events_doc_created ON activity_events (document_id, created_at);

  CREATE TABLE IF NOT EXISTS page_visits (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES activity_sessions(id) ON DELETE CASCADE,
    document_id TEXT NOT NULL,
    page_id TEXT,
    page_index INTEGER NOT NULL,
    entered_at TEXT NOT NULL,
    exited_at TEXT,
    dwell_secs INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_page_visits_session ON page_visits (session_id);
  CREATE INDEX IF NOT EXISTS idx_page_visits_doc ON page_visits (document_id, entered_at);

  CREATE TABLE IF NOT EXISTS document_chapters (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    start_page_index INTEGER NOT NULL,
    end_page_index INTEGER NOT NULL,
    position REAL NOT NULL,
    color TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_chapters_document ON document_chapters (document_id, position);

  -- Key-value store for activity tracking configuration
  CREATE TABLE IF NOT EXISTS activity_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

export const schemaVersion = '3';
