import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';

function argValue(flag, fallback = '') {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return fallback;
  }

  return process.argv[index + 1] ?? fallback;
}

const sourceDbPath = argValue('--source-db');
const sourceUploadsDir = argValue('--source-uploads');
const targetDataDir = argValue('--target-data-dir', path.resolve(process.cwd(), 'data'));

if (!sourceDbPath || !sourceUploadsDir) {
  console.error('Usage: node scripts/import-legacy.mjs --source-db /path/old.db --source-uploads /path/uploads [--target-data-dir ./data]');
  process.exit(1);
}

const targetDbPath = path.join(targetDataDir, 'inkflow.db');
const targetUploadsDir = path.join(targetDataDir, 'uploads');

await mkdir(targetDataDir, { recursive: true });
await mkdir(targetUploadsDir, { recursive: true });

const source = new Database(sourceDbPath, { readonly: true });
const target = new Database(targetDbPath);

target.pragma('foreign_keys = ON');
target.pragma('journal_mode = WAL');

const folders = source.prepare('SELECT id, title, color, created_at, updated_at FROM folders').all();
const documents = source.prepare(`
  SELECT id, folder_id, title, kind, cover_color, page_count, bookmark_page_id, bookmark_updated_at, created_at, updated_at
  FROM documents
`).all();
const files = source.prepare(`
  SELECT id, document_id, storage_key, original_name, mime_type, size, page_count, created_at
  FROM files
`).all();
const pages = source.prepare(`
  SELECT id, document_id, position, kind, source_file_id, source_page_index, template, width, height,
         annotations_json, base_text, annotation_text, created_at, updated_at
  FROM pages
`).all();

const importRows = target.transaction(() => {
  const insertFolder = target.prepare(`
    INSERT OR REPLACE INTO folders (id, title, color, created_at, updated_at)
    VALUES (@id, @title, @color, @created_at, @updated_at)
  `);
  const insertDocument = target.prepare(`
    INSERT OR REPLACE INTO documents (
      id, folder_id, title, kind, cover_color, page_count,
      bookmark_page_id, bookmark_updated_at, created_at, updated_at
    ) VALUES (
      @id, @folder_id, @title, @kind, @cover_color, @page_count,
      @bookmark_page_id, @bookmark_updated_at, @created_at, @updated_at
    )
  `);
  const insertFile = target.prepare(`
    INSERT OR REPLACE INTO files (
      id, document_id, storage_key, original_name, mime_type, size, page_count, created_at
    ) VALUES (
      @id, @document_id, @storage_key, @original_name, @mime_type, @size, @page_count, @created_at
    )
  `);
  const insertPage = target.prepare(`
    INSERT OR REPLACE INTO pages (
      id, document_id, position, kind, source_file_id, source_page_index, template, width, height,
      annotations_json, base_text, annotation_text, annotation_revision, created_at, updated_at
    ) VALUES (
      @id, @document_id, @position, @kind, @source_file_id, @source_page_index, @template, @width, @height,
      @annotations_json, @base_text, @annotation_text, @annotation_revision, @created_at, @updated_at
    )
  `);
  const clearSearch = target.prepare('DELETE FROM page_search_fts');
  const insertSearch = target.prepare('INSERT INTO page_search_fts (page_id, document_id, content) VALUES (?, ?, ?)');

  folders.forEach((row) => insertFolder.run(row));
  documents.forEach((row) => insertDocument.run(row));
  files.forEach((row) => insertFile.run(row));
  pages.forEach((row) =>
    insertPage.run({
      ...row,
      annotation_revision: row.annotations_json && row.annotations_json !== '[]' ? 1 : 0
    })
  );

  clearSearch.run();
  pages.forEach((row) => {
    const content = `${row.base_text}\n${row.annotation_text}`.replace(/\s+/g, ' ').trim();
    insertSearch.run(row.id, row.document_id, content);
  });
});

importRows();

for (const file of files) {
  await copyFile(path.join(sourceUploadsDir, file.storage_key), path.join(targetUploadsDir, file.storage_key));
}

source.close();
target.close();

console.log(`Imported ${documents.length} documents and ${pages.length} pages into ${targetDataDir}`);
