import Database from 'better-sqlite3';
import { config } from '../config.js';
import { ensureDataLayout } from '../lib/fs.js';
import { schemaSql, schemaVersion } from './schema.js';

let database: Database.Database | null = null;

function ensureColumn(db: Database.Database, tableName: string, columnName: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function initialize(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(schemaSql);
  ensureColumn(db, 'pages', 'annotation_revision', "INTEGER NOT NULL DEFAULT 0");
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
