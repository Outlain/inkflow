/**
 * SQLite connection bootstrap — creates the database file, enables WAL mode,
 * runs schema migrations, and exposes a singleton connection via getDb().
 */

import Database from 'better-sqlite3';
import { config } from '../config.js';
import { ensureDataLayout } from '../lib/fs.js';
import { schemaSql, schemaVersion } from './schema.js';

let database: Database.Database | null = null;

/** Adds a column if it doesn't already exist — used for incremental schema migrations. */
function ensureColumn(db: Database.Database, tableName: string, columnName: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function backfillChapterPageAnchors(db: Database.Database): void {
  const chapters = db.prepare(`
    SELECT id, document_id, start_page_index, end_page_index, start_page_id, end_page_id
    FROM document_chapters
    WHERE start_page_id IS NULL OR end_page_id IS NULL
  `).all() as Array<{
    id: string;
    document_id: string;
    start_page_index: number;
    end_page_index: number;
    start_page_id: string | null;
    end_page_id: string | null;
  }>;

  if (chapters.length === 0) {
    return;
  }

  const pagesByDocument = new Map<string, Array<{ id: string }>>();
  const selectPages = db.prepare('SELECT id FROM pages WHERE document_id = ? ORDER BY position ASC');
  const updateChapter = db.prepare('UPDATE document_chapters SET start_page_id = ?, end_page_id = ? WHERE id = ?');

  for (const chapter of chapters) {
    let pages = pagesByDocument.get(chapter.document_id);
    if (!pages) {
      pages = selectPages.all(chapter.document_id) as Array<{ id: string }>;
      pagesByDocument.set(chapter.document_id, pages);
    }

    if (pages.length === 0) {
      continue;
    }

    const startPage = pages[Math.max(0, Math.min(chapter.start_page_index, pages.length - 1))];
    const endPage = pages[Math.max(0, Math.min(chapter.end_page_index, pages.length - 1))];
    updateChapter.run(chapter.start_page_id ?? startPage?.id ?? null, chapter.end_page_id ?? endPage?.id ?? null, chapter.id);
  }
}

function initialize(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(schemaSql);
  ensureColumn(db, 'pages', 'annotation_revision', "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, 'document_chapters', 'start_page_id', 'TEXT REFERENCES pages(id) ON DELETE SET NULL');
  ensureColumn(db, 'document_chapters', 'end_page_id', 'TEXT REFERENCES pages(id) ON DELETE SET NULL');
  backfillChapterPageAnchors(db);
  db.prepare(`
    INSERT INTO schema_meta (key, value)
    VALUES ('schema_version', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(schemaVersion);
}

export function getDb(): Database.Database {
  if (database) {
    return database;
  }

  const paths = ensureDataLayout(config.dataDir);
  database = new Database(paths.database);
  initialize(database);
  return database;
}

export function resetDb(): void {
  if (!database) {
    return;
  }

  database.close();
  database = null;
}
