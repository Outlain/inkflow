/**
 * PDF import pipeline — moves uploaded files into permanent storage,
 * extracts metadata/text via Poppler, creates DB records, and kicks off
 * background preview generation and outline-to-chapter extraction.
 */

import path from 'node:path';
import { nanoid } from 'nanoid';
import { config } from '../config.js';
import { ensureDataLayout } from '../lib/fs.js';
import { createImportedDocument, getDocumentBundle, type InsertPdfSourceInput } from './libraryService.js';
import { createChapter } from './activityService.js';
import { extractPdfMetadata, extractPdfOutline, extractPdfTextPages, finalizeUploadedPdf, preGenerateAllPreviews } from './pdfTools.js';

/** Strips the .pdf extension from the filename to derive a document title. */
function normalizePdfTitle(originalName: string): string {
  return originalName.replace(/\.pdf$/i, '').trim() || 'Imported PDF';
}

function buildStorageTarget(): { storageKey: string; uploadPath: string } {
  const dataPaths = ensureDataLayout(config.dataDir);
  const storageKey = `${nanoid()}.pdf`;
  return {
    storageKey,
    uploadPath: path.join(dataPaths.uploads, storageKey)
  };
}

/**
 * Parses a human-readable page range string (e.g. "1-3, 5, 8-10") into
 * sorted 0-based page indexes. Returns all pages if the input is empty.
 */
export function parsePageRange(pageRange: string, totalPages: number): number[] {
  const normalized = pageRange.trim();
  if (!normalized) {
    return Array.from({ length: totalPages }, (_value, index) => index);
  }

  const pages = new Set<number>();
  const segments = normalized.split(',').map((segment) => segment.trim()).filter(Boolean);

  for (const segment of segments) {
    const rangeMatch = segment.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < 1 || start > totalPages || end > totalPages) {
        throw new Error('Page range is out of bounds.');
      }

      const lower = Math.min(start, end);
      const upper = Math.max(start, end);
      for (let page = lower; page <= upper; page += 1) {
        pages.add(page - 1);
      }
      continue;
    }

    const pageNumber = Number(segment);
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > totalPages) {
      throw new Error('Page range is invalid.');
    }
    pages.add(pageNumber - 1);
  }

  return [...pages].sort((left, right) => left - right);
}

/** Full PDF import: finalize file, extract metadata/text, create document + pages in DB. */
export async function importPdfFromTemp(params: {
  tempPath: string;
  originalName: string;
  mimeType: string;
  size: number;
  folderId: string | null;
}) {
  const { storageKey, uploadPath } = buildStorageTarget();
  await finalizeUploadedPdf(params.tempPath, uploadPath, params.size);

  const [metadata, textPages] = await Promise.all([extractPdfMetadata(uploadPath), extractPdfTextPages(uploadPath)]);
  const title = normalizePdfTitle(params.originalName);

  const created = createImportedDocument({
    title,
    folderId: params.folderId,
    coverColor: '#a85e44',
    originalName: params.originalName,
    mimeType: params.mimeType,
    size: params.size,
    storageKey,
    pageCount: metadata.pageCount,
    pages: metadata.pages.map((page) => ({
      kind: 'pdf' as const,
      sourcePageIndex: page.index,
      width: page.width,
      height: page.height,
      baseText: textPages[page.index] ?? ''
    }))
  });

  // Fire-and-forget background preview generation
  void preGenerateAllPreviews(storageKey, uploadPath, metadata.pageCount).catch(() => undefined);

  // Auto-extract PDF outline (table of contents) as chapters.
  // Each outline entry becomes a chapter spanning from its page to the next entry's page.
  void extractPdfOutline(uploadPath).then((outline) => {
    if (outline.length < 2) return;
    for (let i = 0; i < outline.length; i++) {
      const entry = outline[i];
      const nextEntry = outline[i + 1];
      const endPageIndex = nextEntry ? nextEntry.pageIndex - 1 : metadata.pageCount - 1;
      if (endPageIndex >= entry.pageIndex) {
        createChapter(created.document.id, {
          title: entry.title,
          startPageIndex: entry.pageIndex,
          endPageIndex
        });
      }
    }
  }).catch(() => undefined);

  return getDocumentBundle(created.document.id);
}

/** Prepares PDF data for page insertion (used when adding PDF pages into an existing document). */
export async function preparePdfInsertionFromTemp(params: {
  tempPath: string;
  originalName: string;
  mimeType: string;
  size: number;
  pageRange: string;
}): Promise<InsertPdfSourceInput> {
  const { storageKey, uploadPath } = buildStorageTarget();
  await finalizeUploadedPdf(params.tempPath, uploadPath, params.size);

  const [metadata, textPages] = await Promise.all([extractPdfMetadata(uploadPath), extractPdfTextPages(uploadPath)]);
  const pageIndexes = parsePageRange(params.pageRange, metadata.pageCount);

  // Fire-and-forget background preview generation
  void preGenerateAllPreviews(storageKey, uploadPath, metadata.pageCount).catch(() => undefined);

  return {
    originalName: params.originalName,
    mimeType: params.mimeType,
    size: params.size,
    storageKey,
    pageCount: metadata.pageCount,
    pages: pageIndexes.map((index) => ({
      sourcePageIndex: index,
      width: metadata.pages[index]?.width ?? metadata.pages[0]?.width ?? 612,
      height: metadata.pages[index]?.height ?? metadata.pages[0]?.height ?? 792,
      baseText: textPages[index] ?? ''
    }))
  };
}
