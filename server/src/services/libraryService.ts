/**
 * Core library business logic — CRUD for folders, documents, pages, files,
 * full-text search, annotations, and bookmarks. All operations are synchronous
 * SQLite transactions via better-sqlite3.
 */

import { nanoid } from 'nanoid';
import type Database from 'better-sqlite3';
import type {
  Annotation,
  BookmarkPayload,
  CreateFolderInput,
  CreateNotebookInput,
  DocumentBundle,
  DocumentSummary,
  FileRecord,
  FolderRecord,
  InsertBlankPageRequest,
  LibraryPayload,
  PageAnnotationsPayload,
  PageKind,
  PageRecord,
  SaveMode,
  SavePageRequest,
  SavePageResponse,
  SearchResponse,
  SearchResult
} from '../../../shared/src/contracts.js';
import { getDb } from '../db/database.js';
import { getDefaultUser, repairDocumentChaptersAfterPageDelete } from './activityService.js';

// ── SQLite row interfaces (snake_case DB columns -> camelCase via mappers) ──

interface FolderRow {
  id: string;
  title: string;
  color: string;
  created_at: string;
  updated_at: string;
}

interface DocumentRow {
  id: string;
  folder_id: string | null;
  title: string;
  kind: 'notebook' | 'pdf';
  cover_color: string;
  page_count: number;
  bookmark_page_id: string | null;
  bookmark_updated_at: string | null;
  created_at: string;
  updated_at: string;
}

interface FileRow {
  id: string;
  document_id: string;
  storage_key: string;
  original_name: string;
  mime_type: string;
  size: number;
  page_count: number;
  created_at: string;
}

interface PageRow {
  id: string;
  document_id: string;
  position: number;
  kind: PageKind;
  source_file_id: string | null;
  source_page_index: number | null;
  template: PageKind | null;
  width: number;
  height: number;
  annotations_json: string;
  base_text: string;
  annotation_text: string;
  annotation_revision: number;
  created_at: string;
  updated_at: string;
}

interface SearchRow {
  page_id: string;
  snippet: string;
}

// ── Public input types ──

export interface CreateImportedDocumentInput {
  title: string;
  folderId: string | null;
  coverColor: string;
  originalName: string;
  mimeType: string;
  size: number;
  storageKey: string;
  pageCount: number;
  pages: Array<{
    kind: 'pdf';
    sourcePageIndex: number;
    width: number;
    height: number;
    baseText: string;
  }>;
}

export interface InsertPdfSourceInput {
  originalName: string;
  mimeType: string;
  size: number;
  storageKey: string;
  pageCount: number;
  pages: Array<{
    sourcePageIndex: number;
    width: number;
    height: number;
    baseText: string;
  }>;
}

export interface PagePdfSource {
  documentId: string;
  fileId: string;
  storageKey: string;
  sourcePageIndex: number;
}

// ── Utility helpers ──

function now(): string {
  return new Date().toISOString();
}

/** Gap-based page ordering: pages at 1024, 2048, 3072... allows insert-between without renumbering. */
function pagePosition(index: number): number {
  return (index + 1) * 1024;
}

// ── Row-to-record mappers (snake_case DB rows -> camelCase API records) ──

function mapFolder(row: FolderRow): FolderRecord {
  return {
    id: row.id,
    title: row.title,
    color: row.color,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapDocument(row: DocumentRow): DocumentSummary {
  return {
    id: row.id,
    folderId: row.folder_id,
    title: row.title,
    kind: row.kind,
    coverColor: row.cover_color,
    pageCount: row.page_count,
    bookmarkPageId: row.bookmark_page_id,
    bookmarkUpdatedAt: row.bookmark_updated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapFile(row: FileRow): FileRecord {
  return {
    id: row.id,
    documentId: row.document_id,
    storageKey: row.storage_key,
    originalName: row.original_name,
    mimeType: row.mime_type,
    size: row.size,
    pageCount: row.page_count,
    createdAt: row.created_at,
    url: `/api/files/${row.id}/content`
  };
}

function mapPage(row: PageRow): PageRecord {
  return {
    id: row.id,
    documentId: row.document_id,
    position: row.position,
    kind: row.kind,
    sourceFileId: row.source_file_id,
    sourcePageIndex: row.source_page_index,
    template: (row.template as PageRecord['template']) ?? null,
    width: row.width,
    height: row.height,
    annotationRevision: row.annotation_revision,
    updatedAt: row.updated_at,
    annotationText: row.annotation_text
  };
}

// ── Annotation JSON serialization ──

function parseAnnotations(raw: string): Annotation[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Annotation[]) : [];
  } catch {
    return [];
  }
}

function writeAnnotations(annotations: Annotation[]): string {
  return JSON.stringify(annotations);
}

// ── Internal database helpers ──

function touchFolder(db: Database.Database, folderId: string | null, updatedAt: string): void {
  if (!folderId) {
    return;
  }

  db.prepare('UPDATE folders SET updated_at = ? WHERE id = ?').run(updatedAt, folderId);
}

function pageRowsForDocument(db: Database.Database, documentId: string): PageRow[] {
  return db
    .prepare('SELECT * FROM pages WHERE document_id = ? ORDER BY position ASC')
    .all(documentId) as PageRow[];
}

function getDocumentRow(db: Database.Database, documentId: string): DocumentRow {
  const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(documentId) as DocumentRow | undefined;
  if (!row) {
    throw new Error('Document not found.');
  }
  return row;
}

function getPageRow(db: Database.Database, pageId: string): PageRow {
  const row = db.prepare('SELECT * FROM pages WHERE id = ?').get(pageId) as PageRow | undefined;
  if (!row) {
    throw new Error('Page not found.');
  }
  return row;
}

function getFileRow(db: Database.Database, fileId: string): FileRow {
  const row = db.prepare('SELECT * FROM files WHERE id = ?').get(fileId) as FileRow | undefined;
  if (!row) {
    throw new Error('File not found.');
  }
  return row;
}

// ── Full-text search helpers ──

/** Merges base PDF text with annotation text into a single searchable string. */
function searchContent(baseText: string, annotationText: string): string {
  return `${baseText}\n${annotationText}`.replace(/\s+/g, ' ').trim();
}

/** Updates the FTS5 index for a single page. */
function reindexPageSearch(db: Database.Database, row: Pick<PageRow, 'id' | 'document_id' | 'base_text' | 'annotation_text'>): void {
  db.prepare('DELETE FROM page_search_fts WHERE page_id = ?').run(row.id);
  const content = searchContent(row.base_text, row.annotation_text);
  db.prepare('INSERT INTO page_search_fts (page_id, document_id, content) VALUES (?, ?, ?)').run(row.id, row.document_id, content);
}

function rebuildDocumentSearch(db: Database.Database, documentId: string): void {
  db.prepare('DELETE FROM page_search_fts WHERE document_id = ?').run(documentId);
  const rows = db
    .prepare('SELECT id, document_id, base_text, annotation_text FROM pages WHERE document_id = ? ORDER BY position ASC')
    .all(documentId) as Array<Pick<PageRow, 'id' | 'document_id' | 'base_text' | 'annotation_text'>>;

  const insert = db.prepare('INSERT INTO page_search_fts (page_id, document_id, content) VALUES (?, ?, ?)');
  for (const row of rows) {
    insert.run(row.id, row.document_id, searchContent(row.base_text, row.annotation_text));
  }
}

// ── Page position management ──

/** Syncs the documents.page_count column with the actual number of pages. */
function normalizeCount(db: Database.Database, documentId: string): void {
  const row = db.prepare('SELECT COUNT(*) AS count FROM pages WHERE document_id = ?').get(documentId) as { count: number };
  db.prepare('UPDATE documents SET page_count = ?, updated_at = ? WHERE id = ?').run(row.count, now(), documentId);
}

/** Reassigns all page positions to clean 1024-spaced gaps. Called when gaps get too small. */
function rebalanceDocumentPositions(db: Database.Database, documentId: string): PageRow[] {
  const rows = pageRowsForDocument(db, documentId);
  const statement = db.prepare('UPDATE pages SET position = ? WHERE id = ?');
  rows.forEach((row, index) => {
    statement.run(pagePosition(index), row.id);
  });
  return pageRowsForDocument(db, documentId);
}

/**
 * Computes gap-based positions for inserting `count` pages before/after an anchor page.
 * Automatically rebalances if the gap between neighbors is too small.
 */
function computeInsertPositions(
  db: Database.Database,
  documentId: string,
  anchorPageId: string,
  placement: 'before' | 'after',
  count: number
): number[] {
  let rows = pageRowsForDocument(db, documentId);
  const anchorIndex = rows.findIndex((row) => row.id === anchorPageId);
  if (anchorIndex === -1) {
    throw new Error('Anchor page not found.');
  }

  const leftIndex = placement === 'before' ? anchorIndex - 1 : anchorIndex;
  const rightIndex = placement === 'before' ? anchorIndex : anchorIndex + 1;
  const leftPosition = leftIndex >= 0 ? rows[leftIndex].position : rows[0].position - 1024 * count;
  const rightPosition = rightIndex < rows.length ? rows[rightIndex].position : rows[rows.length - 1].position + 1024 * count;
  let gap = rightPosition - leftPosition;

  if (gap <= count + 1) {
    rows = rebalanceDocumentPositions(db, documentId);
    const nextAnchorIndex = rows.findIndex((row) => row.id === anchorPageId);
    const nextLeftIndex = placement === 'before' ? nextAnchorIndex - 1 : nextAnchorIndex;
    const nextRightIndex = placement === 'before' ? nextAnchorIndex : nextAnchorIndex + 1;
    const nextLeftPosition = nextLeftIndex >= 0 ? rows[nextLeftIndex].position : rows[0].position - 1024 * count;
    const nextRightPosition =
      nextRightIndex < rows.length ? rows[nextRightIndex].position : rows[rows.length - 1].position + 1024 * count;
    gap = nextRightPosition - nextLeftPosition;

    return Array.from({ length: count }, (_value, index) => nextLeftPosition + (gap * (index + 1)) / (count + 1));
  }

  return Array.from({ length: count }, (_value, index) => leftPosition + (gap * (index + 1)) / (count + 1));
}

function deleteSearchRowsForDocument(db: Database.Database, documentId: string): void {
  db.prepare('DELETE FROM page_search_fts WHERE document_id = ?').run(documentId);
}

/** Converts a user search string into an FTS5 MATCH expression (AND of quoted tokens). */
function searchQuery(raw: string): string {
  const tokens = raw
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/"/g, ''))
    .filter(Boolean);
  return tokens.map((token) => `"${token}"`).join(' AND ');
}

// ═══════════════════════════════════════════════════════════════════════
// Public API — these functions are called from route handlers
// ═══════════════════════════════════════════════════════════════════════

export function listLibrary(): LibraryPayload {
  const db = getDb();
  const folders = db.prepare('SELECT * FROM folders ORDER BY updated_at DESC, title COLLATE NOCASE ASC').all() as FolderRow[];
  const documents = db
    .prepare('SELECT * FROM documents ORDER BY updated_at DESC, title COLLATE NOCASE ASC')
    .all() as DocumentRow[];

  const currentUser = getDefaultUser();

  return {
    folders: folders.map(mapFolder),
    documents: documents.map(mapDocument),
    setupRequired: !currentUser,
    currentUser: currentUser ?? undefined
  };
}

export function createFolder(input: CreateFolderInput): LibraryPayload {
  const db = getDb();
  const timestamp = now();

  db.prepare(`
    INSERT INTO folders (id, title, color, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(nanoid(), input.title, input.color, timestamp, timestamp);

  return listLibrary();
}

export function assertFolderExists(folderId: string | null): void {
  if (!folderId) {
    return;
  }

  const db = getDb();
  const row = db.prepare('SELECT id FROM folders WHERE id = ?').get(folderId) as { id: string } | undefined;
  if (!row) {
    throw new Error('Selected folder does not exist.');
  }
}

export function createNotebook(input: CreateNotebookInput): DocumentBundle {
  const db = getDb();
  const timestamp = now();

  const create = db.transaction(() => {
    const documentId = nanoid();

    db.prepare(`
      INSERT INTO documents (
        id, folder_id, title, kind, cover_color, page_count,
        bookmark_page_id, bookmark_updated_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'notebook', ?, ?, NULL, NULL, ?, ?)
    `).run(documentId, input.folderId, input.title, input.coverColor, input.pageCount, timestamp, timestamp);

    const pageStatement = db.prepare(`
      INSERT INTO pages (
        id, document_id, position, kind, source_file_id, source_page_index, template,
        width, height, annotations_json, base_text, annotation_text, annotation_revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, NULL, ?, 612, 792, '[]', '', '', 0, ?, ?)
    `);

    for (let index = 0; index < input.pageCount; index += 1) {
      const pageId = nanoid();
      pageStatement.run(pageId, documentId, pagePosition(index), input.template, input.template, timestamp, timestamp);
      reindexPageSearch(db, {
        id: pageId,
        document_id: documentId,
        base_text: '',
        annotation_text: ''
      });
    }

    touchFolder(db, input.folderId, timestamp);
    return getDocumentBundle(documentId);
  });

  return create();
}

export function createImportedDocument(input: CreateImportedDocumentInput): { document: DocumentSummary; file: FileRecord } {
  const db = getDb();
  const timestamp = now();

  const create = db.transaction(() => {
    const documentId = nanoid();
    const fileId = nanoid();

    db.prepare(`
      INSERT INTO documents (
        id, folder_id, title, kind, cover_color, page_count,
        bookmark_page_id, bookmark_updated_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'pdf', ?, ?, NULL, NULL, ?, ?)
    `).run(documentId, input.folderId, input.title, input.coverColor, input.pageCount, timestamp, timestamp);

    db.prepare(`
      INSERT INTO files (
        id, document_id, storage_key, original_name, mime_type, size, page_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(fileId, documentId, input.storageKey, input.originalName, input.mimeType, input.size, input.pageCount, timestamp);

    const pageStatement = db.prepare(`
      INSERT INTO pages (
        id, document_id, position, kind, source_file_id, source_page_index, template,
        width, height, annotations_json, base_text, annotation_text, annotation_revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, '[]', ?, '', 0, ?, ?)
    `);

    for (let index = 0; index < input.pages.length; index += 1) {
      const page = input.pages[index];
      const pageId = nanoid();
      pageStatement.run(
        pageId,
        documentId,
        pagePosition(index),
        page.kind,
        fileId,
        page.sourcePageIndex,
        page.width,
        page.height,
        page.baseText,
        timestamp,
        timestamp
      );
      reindexPageSearch(db, {
        id: pageId,
        document_id: documentId,
        base_text: page.baseText,
        annotation_text: ''
      });
    }

    touchFolder(db, input.folderId, timestamp);

    const documentRow = getDocumentRow(db, documentId);
    const fileRow = getFileRow(db, fileId);
    return {
      document: mapDocument(documentRow),
      file: mapFile(fileRow)
    };
  });

  return create();
}

export function getDocumentBundle(documentId: string): DocumentBundle {
  const db = getDb();
  const document = mapDocument(getDocumentRow(db, documentId));
  const files = db.prepare('SELECT * FROM files WHERE document_id = ? ORDER BY created_at ASC').all(documentId) as FileRow[];
  const pages = pageRowsForDocument(db, documentId);

  return {
    document,
    files: files.map(mapFile),
    pages: pages.map(mapPage)
  };
}

export function getPageAnnotations(pageId: string): PageAnnotationsPayload {
  const db = getDb();
  const page = getPageRow(db, pageId);

  return {
    pageId: page.id,
    annotations: parseAnnotations(page.annotations_json),
    annotationText: page.annotation_text,
    annotationRevision: page.annotation_revision,
    updatedAt: page.updated_at
  };
}

export function savePageAnnotations(input: SavePageRequest): SavePageResponse {
  const db = getDb();
  const timestamp = now();

  const save = db.transaction(() => {
    const page = getPageRow(db, input.pageId);
    const currentAnnotations = parseAnnotations(page.annotations_json);
    const currentRevision = page.annotation_revision;

    // Optimistic concurrency: reject replace if client is stale
    if (input.mode === 'replace' && input.baseRevision !== currentRevision) {
      const error = new Error('Page revision conflict.');
      (error as Error & { statusCode?: number }).statusCode = 409;
      throw error;
    }

    let nextAnnotations = input.annotations;
    let mode: SaveMode = input.mode;

    if (input.mode === 'append') {
      // Deduplicate: only add annotations the server hasn't seen yet
      const seen = new Set(currentAnnotations.map((annotation) => annotation.id));
      const appendOnly = input.annotations.filter((annotation) => !seen.has(annotation.id));
      nextAnnotations = [...currentAnnotations, ...appendOnly];
      mode = 'append';
    }

    const nextRevision = currentRevision + 1;
    const annotationsJson = writeAnnotations(nextAnnotations);

    db.prepare(`
      UPDATE pages
      SET annotations_json = ?, annotation_text = ?, annotation_revision = ?, updated_at = ?
      WHERE id = ?
    `).run(annotationsJson, input.annotationText, nextRevision, timestamp, input.pageId);

    // Record the update in the audit log for conflict resolution
    db.prepare(`
      INSERT INTO page_updates (
        id, page_id, document_id, mode, client_id, client_revision,
        base_revision, annotation_revision, payload_json, annotation_text, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      nanoid(),
      input.pageId,
      page.document_id,
      mode,
      input.clientId,
      input.clientRevision,
      input.baseRevision,
      nextRevision,
      annotationsJson,
      input.annotationText,
      timestamp
    );

    reindexPageSearch(db, {
      id: page.id,
      document_id: page.document_id,
      base_text: page.base_text,
      annotation_text: input.annotationText
    });

    db.prepare('UPDATE documents SET updated_at = ? WHERE id = ?').run(timestamp, page.document_id);

    return {
      pageId: input.pageId,
      mode,
      annotationRevision: nextRevision,
      updatedAt: timestamp
    };
  });

  return save();
}

export function searchDocumentPages(documentId: string, query: string): SearchResponse {
  const db = getDb();
  const document = getDocumentRow(db, documentId);
  const trimmed = query.trim();
  let indexedCountRow = db.prepare('SELECT COUNT(*) AS count FROM page_search_fts WHERE document_id = ?').get(documentId) as {
    count: number;
  };

  // Auto-rebuild the FTS index if pages are missing (e.g. after import)
  if (document.kind === 'pdf' && indexedCountRow.count < document.page_count) {
    rebuildDocumentSearch(db, documentId);
    indexedCountRow = db.prepare('SELECT COUNT(*) AS count FROM page_search_fts WHERE document_id = ?').get(documentId) as {
      count: number;
    };
  }

  if (!trimmed) {
    return {
      indexing: document.kind === 'pdf' && indexedCountRow.count < document.page_count,
      results: []
    };
  }

  const pages = pageRowsForDocument(db, documentId);
  const pageLookup = new Map<string, { page: PageRow; pageIndex: number }>();
  pages.forEach((page, index) => {
    pageLookup.set(page.id, { page, pageIndex: index });
  });

  try {
    // FTS5 search with snippet extraction (column 2 = content, brackets for highlights)
    const rows = db
      .prepare(`
        SELECT page_id, snippet(page_search_fts, 2, '[', ']', '…', 18) AS snippet
        FROM page_search_fts
        WHERE page_search_fts MATCH ? AND document_id = ?
        LIMIT 40
      `)
      .all(searchQuery(trimmed), documentId) as SearchRow[];

    const results: SearchResult[] = rows
      .map((row) => {
        const hit = pageLookup.get(row.page_id);
        if (!hit) {
          return null;
        }

        return {
          pageId: row.page_id,
          position: hit.page.position,
          pageIndex: hit.pageIndex,
          snippet: row.snippet
        };
      })
      .filter((result): result is SearchResult => Boolean(result));

    return {
      indexing: document.kind === 'pdf' && indexedCountRow.count < document.page_count,
      results
    };
  } catch {
    // FTS5 query syntax error — fall back to case-insensitive substring search
    const lower = trimmed.toLowerCase();
    const results: SearchResult[] = pages
      .map((page, pageIndex) => {
        const content = searchContent(page.base_text, page.annotation_text);
        const matchIndex = content.toLowerCase().indexOf(lower);
        if (matchIndex === -1) {
          return null;
        }

        const start = Math.max(0, matchIndex - 36);
        const end = Math.min(content.length, matchIndex + trimmed.length + 36);
        return {
          pageId: page.id,
          position: page.position,
          pageIndex,
          snippet: content.slice(start, end)
        };
      })
      .filter((result): result is SearchResult => Boolean(result))
      .slice(0, 40);

    return {
      indexing: document.kind === 'pdf' && indexedCountRow.count < document.page_count,
      results
    };
  }
}

export function setDocumentBookmark(documentId: string, payload: BookmarkPayload): DocumentBundle {
  const db = getDb();
  const timestamp = now();

  if (payload.pageId) {
    const page = getPageRow(db, payload.pageId);
    if (page.document_id !== documentId) {
      throw new Error('Bookmark page must belong to the document.');
    }
  }

  db.prepare(`
    UPDATE documents
    SET bookmark_page_id = ?, bookmark_updated_at = ?, updated_at = ?
    WHERE id = ?
  `).run(payload.pageId, payload.pageId ? timestamp : null, timestamp, documentId);

  return getDocumentBundle(documentId);
}

export function insertBlankPage(documentId: string, input: InsertBlankPageRequest): DocumentBundle {
  const db = getDb();
  const timestamp = now();

  const insert = db.transaction(() => {
    getDocumentRow(db, documentId);
    const positions = computeInsertPositions(db, documentId, input.anchorPageId, input.placement, 1);

    const pageId = nanoid();
    db.prepare(`
      INSERT INTO pages (
        id, document_id, position, kind, source_file_id, source_page_index, template,
        width, height, annotations_json, base_text, annotation_text, annotation_revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, NULL, ?, 612, 792, '[]', '', '', 0, ?, ?)
    `).run(pageId, documentId, positions[0], input.template, input.template, timestamp, timestamp);

    reindexPageSearch(db, {
      id: pageId,
      document_id: documentId,
      base_text: '',
      annotation_text: ''
    });

    normalizeCount(db, documentId);
    return getDocumentBundle(documentId);
  });

  return insert();
}

export function insertPdfPages(
  documentId: string,
  anchorPageId: string,
  placement: 'before' | 'after',
  input: InsertPdfSourceInput
): DocumentBundle {
  const db = getDb();
  const timestamp = now();

  const insert = db.transaction(() => {
    getDocumentRow(db, documentId);
    const positions = computeInsertPositions(db, documentId, anchorPageId, placement, input.pages.length);
    const fileId = nanoid();

    db.prepare(`
      INSERT INTO files (
        id, document_id, storage_key, original_name, mime_type, size, page_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(fileId, documentId, input.storageKey, input.originalName, input.mimeType, input.size, input.pageCount, timestamp);

    const insertPage = db.prepare(`
      INSERT INTO pages (
        id, document_id, position, kind, source_file_id, source_page_index, template,
        width, height, annotations_json, base_text, annotation_text, annotation_revision, created_at, updated_at
      ) VALUES (?, ?, ?, 'pdf', ?, ?, NULL, ?, ?, '[]', ?, '', 0, ?, ?)
    `);

    input.pages.forEach((page, index) => {
      const pageId = nanoid();
      insertPage.run(
        pageId,
        documentId,
        positions[index],
        fileId,
        page.sourcePageIndex,
        page.width,
        page.height,
        page.baseText,
        timestamp,
        timestamp
      );

      reindexPageSearch(db, {
        id: pageId,
        document_id: documentId,
        base_text: page.baseText,
        annotation_text: ''
      });
    });

    normalizeCount(db, documentId);
    return getDocumentBundle(documentId);
  });

  return insert();
}

export function deletePage(pageId: string): DocumentBundle {
  const db = getDb();
  const timestamp = now();

  const remove = db.transaction(() => {
    const page = getPageRow(db, pageId);
    const rows = pageRowsForDocument(db, page.document_id);
    if (rows.length <= 1) {
      throw new Error('A document must keep at least one page.');
    }

    repairDocumentChaptersAfterPageDelete(page.document_id, pageId);
    db.prepare('DELETE FROM pages WHERE id = ?').run(pageId);
    db.prepare('DELETE FROM page_search_fts WHERE page_id = ?').run(pageId);

    // If the deleted page was bookmarked, move bookmark to nearest neighbor
    const remaining = pageRowsForDocument(db, page.document_id);
    const document = getDocumentRow(db, page.document_id);
    if (document.bookmark_page_id === pageId) {
      const fallback = remaining.reduce((best, candidate) => {
        if (!best) {
          return candidate;
        }
        return Math.abs(candidate.position - page.position) < Math.abs(best.position - page.position) ? candidate : best;
      }, remaining[0]);

      db.prepare(`
        UPDATE documents
        SET bookmark_page_id = ?, bookmark_updated_at = ?, updated_at = ?
        WHERE id = ?
      `).run(fallback?.id ?? null, fallback ? timestamp : null, timestamp, page.document_id);
    } else {
      db.prepare('UPDATE documents SET updated_at = ? WHERE id = ?').run(timestamp, page.document_id);
    }

    normalizeCount(db, page.document_id);
    return getDocumentBundle(page.document_id);
  });

  return remove();
}

/** Deletes a document and returns its file storage keys for cleanup. */
export function deleteDocument(documentId: string): string[] {
  const db = getDb();
  const storageKeys = (db.prepare('SELECT storage_key FROM files WHERE document_id = ?').all(documentId) as Array<{ storage_key: string }>).map(
    (row) => row.storage_key
  );

  const remove = db.transaction(() => {
    deleteSearchRowsForDocument(db, documentId);
    db.prepare('DELETE FROM documents WHERE id = ?').run(documentId);
  });

  remove();
  return storageKeys;
}

/** Deletes a folder and all its documents, returning storage keys for cleanup. */
export function deleteFolder(folderId: string): string[] {
  const db = getDb();
  const documents = db.prepare('SELECT id FROM documents WHERE folder_id = ?').all(folderId) as Array<{ id: string }>;
  const storageKeys = new Set<string>();

  const remove = db.transaction(() => {
    documents.forEach((document) => {
      deleteDocument(document.id).forEach((key) => storageKeys.add(key));
    });
    db.prepare('DELETE FROM folders WHERE id = ?').run(folderId);
  });

  remove();
  return [...storageKeys];
}

export function getDocumentFileStorageKeys(documentId: string): string[] {
  const db = getDb();
  return (db.prepare('SELECT storage_key FROM files WHERE document_id = ?').all(documentId) as Array<{ storage_key: string }>).map(
    (row) => row.storage_key
  );
}

export function getFileRecord(fileId: string): FileRecord {
  return mapFile(getFileRow(getDb(), fileId));
}

export function getFileStorageKey(fileId: string): string {
  return getFileRow(getDb(), fileId).storage_key;
}

export function getPageDocumentId(pageId: string): string {
  return getPageRow(getDb(), pageId).document_id;
}

/** Resolves a page's backing PDF file and 0-based page index within that file. */
export function getPagePdfSource(pageId: string): PagePdfSource {
  const db = getDb();
  const page = getPageRow(db, pageId);

  if (!page.source_file_id || page.source_page_index === null) {
    throw new Error('Page is not backed by a PDF source.');
  }

  const file = getFileRow(db, page.source_file_id);
  return {
    documentId: page.document_id,
    fileId: file.id,
    storageKey: file.storage_key,
    sourcePageIndex: page.source_page_index
  };
}

/** Returns all PDF file records for preview repair on startup. */
export function getAllPdfFiles(): Array<{ storageKey: string; pageCount: number }> {
  const db = getDb();
  return db.prepare(`
    SELECT DISTINCT f.storage_key, f.page_count
    FROM files f
    WHERE f.mime_type LIKE '%pdf%' OR f.storage_key LIKE '%.pdf'
  `).all() as Array<{ storageKey: string; pageCount: number }>;
}
