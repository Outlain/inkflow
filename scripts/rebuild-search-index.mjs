import path from 'node:path';
import Database from 'better-sqlite3';

const dataDir = process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data');
const dbPath = path.join(dataDir, 'inkflow.db');
const db = new Database(dbPath);

db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const pages = db.prepare('SELECT id, document_id, base_text, annotation_text FROM pages ORDER BY document_id, position').all();
const clear = db.prepare('DELETE FROM page_search_fts');
const insert = db.prepare('INSERT INTO page_search_fts (page_id, document_id, content) VALUES (?, ?, ?)');

const rebuild = db.transaction(() => {
  clear.run();
  for (const page of pages) {
    const content = `${page.base_text}\n${page.annotation_text}`.replace(/\s+/g, ' ').trim();
    insert.run(page.id, page.document_id, content);
  }
});

rebuild();
db.close();

console.log(`Rebuilt page_search_fts for ${pages.length} pages using ${dbPath}`);
