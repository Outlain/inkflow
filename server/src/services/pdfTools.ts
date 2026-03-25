/**
 * PDF processing tools — wraps qpdf and Poppler CLI binaries (pdfinfo, pdftotext, pdftoppm).
 * Handles metadata extraction, text extraction, PDF linearization, preview image generation,
 * per-page PDF extraction, and outline (table of contents) extraction via mutool.
 */

import { execFile } from 'node:child_process';
import { access, copyFile, mkdir, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { nanoid } from 'nanoid';
import { config } from '../config.js';
import { getPreviewDirectory, getPreviewPath, getPagePdfPath } from '../lib/fs.js';

const execFileAsync = promisify(execFile);

/** In-flight preview generation tasks, keyed by output path to deduplicate concurrent requests. */
const previewTasks = new Map<string, Promise<string>>();

/** Width buckets for preview images — requested widths snap to the nearest bucket. */
const previewWidthBuckets = [120, 180, 240, 320, 480, 720, 960, 1280];

/** Widths pre-generated on import so common preview sizes are ready immediately. */
const PREVIEW_PREGENERATE_WIDTHS = [240, 480, 960];
const PREVIEW_CONCURRENCY = 3;

// ── Metadata extraction (Poppler pdfinfo) ──

export interface PdfPageMetadata {
  index: number;
  width: number;
  height: number;
}

export interface PdfMetadata {
  pageCount: number;
  pages: PdfPageMetadata[];
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readPdfInfo(filePath: string, firstPage: number, lastPage: number): Promise<string> {
  const { stdout } = await execFileAsync('pdfinfo', ['-f', String(firstPage), '-l', String(lastPage), filePath], {
    maxBuffer: 16 * 1024 * 1024
  });
  return stdout;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Extracts page count and per-page dimensions from a PDF using Poppler's pdfinfo. */
export async function extractPdfMetadata(filePath: string): Promise<PdfMetadata> {
  // First pass: get page count from a lightweight single-page query
  const summary = await readPdfInfo(filePath, 1, 1);
  const pageCountMatch = summary.match(/^Pages:\s+(\d+)/m);
  const firstSizeMatch = summary.match(/^Page\s+1\s+size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/m);

  if (!pageCountMatch) {
    throw new Error('Could not determine PDF page count.');
  }

  const pageCount = Number(pageCountMatch[1]);
  if (!Number.isFinite(pageCount) || pageCount < 1) {
    throw new Error('PDF page count is invalid.');
  }

  // Second pass: get per-page dimensions for all pages
  const details = await readPdfInfo(filePath, 1, pageCount);
  const pageMatches = [...details.matchAll(/^Page\s+(\d+)\s+size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/mg)];
  const pages = pageMatches.map((match) => ({
    index: Number(match[1]) - 1,
    width: Number(match[2]),
    height: Number(match[3])
  }));

  if (pages.length === pageCount) {
    return { pageCount, pages };
  }

  // Some PDFs don't report per-page sizes; fall back to page 1 dimensions or US Letter
  const fallbackWidth = Number(firstSizeMatch?.[1] ?? 612);
  const fallbackHeight = Number(firstSizeMatch?.[2] ?? 792);
  return {
    pageCount,
    pages: Array.from({ length: pageCount }, (_value, index) => ({
      index,
      width: fallbackWidth,
      height: fallbackHeight
    }))
  };
}

// ── Text extraction (Poppler pdftotext) ──

/** Extracts text content from each page using Poppler's pdftotext. Pages split on form-feed. */
export async function extractPdfTextPages(filePath: string): Promise<string[]> {
  const tempOutput = path.join(config.dataDir, 'temp', `${nanoid()}.txt`);

  try {
    await execFileAsync('pdftotext', ['-enc', 'UTF-8', filePath, tempOutput], {
      timeout: 10 * 60 * 1000,
      maxBuffer: 1024 * 1024
    });

    const raw = await readFile(tempOutput, 'utf8');
    const pages = raw
      .split('\f')
      .map((page) => normalizeText(page))
      .filter((page, index, all) => index < all.length - 1 || page.length > 0);

    return pages;
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code) : '';
    if (code === 'ENOENT') {
      return [];
    }
    throw error;
  } finally {
    await unlink(tempOutput).catch(() => undefined);
  }
}

// ── PDF finalization (qpdf linearization) ──

/**
 * Moves a temp upload to permanent storage, optionally linearizing large PDFs
 * with qpdf for better streaming performance. Falls back to plain copy if qpdf
 * is unavailable or linearization fails.
 */
export async function finalizeUploadedPdf(tempPath: string, outputPath: string, fileSize: number): Promise<void> {
  // Small files don't benefit from linearization; just rename
  if (fileSize < config.pdfLinearizeThresholdBytes) {
    await rename(tempPath, outputPath);
    return;
  }

  const tempLinearizedPath = path.join(
    path.dirname(outputPath),
    `${path.basename(outputPath, path.extname(outputPath))}.linearized${path.extname(outputPath)}`
  );

  try {
    await execFileAsync('qpdf', ['--linearize', tempPath, tempLinearizedPath], {
      timeout: 10 * 60 * 1000,
      maxBuffer: 1024 * 1024
    });
    await rename(tempLinearizedPath, outputPath);
    await unlink(tempPath).catch(() => undefined);
  } catch (error) {
    await unlink(tempLinearizedPath).catch(() => undefined);
    const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code) : '';

    if (code === 'ENOENT') {
      await rename(tempPath, outputPath);
      return;
    }

    await copyFile(tempPath, outputPath);
    await unlink(tempPath).catch(() => undefined);
  }
}

// ── Preview image generation (Poppler pdftoppm) ──

/** Snaps a requested width to the nearest preview width bucket. */
export function resolvePreviewWidth(requestedWidth: number): number {
  const safeWidth = Math.max(120, Math.min(1280, Math.round(requestedWidth)));
  const bucket = previewWidthBuckets.find((value) => value >= safeWidth);
  return bucket ?? previewWidthBuckets[previewWidthBuckets.length - 1];
}

/** Generates a JPEG preview image for a PDF page, caching the result on disk. Deduplicates concurrent requests. */
export async function ensurePdfPreviewImage(storageKey: string, sourcePath: string, pageNumber: number, width: number): Promise<string> {
  const resolvedWidth = resolvePreviewWidth(width);
  const outputPath = getPreviewPath(config.dataDir, storageKey, pageNumber, resolvedWidth);
  if (await fileExists(outputPath)) {
    return outputPath;
  }

  const existingTask = previewTasks.get(outputPath);
  if (existingTask) {
    return existingTask;
  }

  const outputDir = getPreviewDirectory(config.dataDir, storageKey);
  await mkdir(outputDir, { recursive: true });

  const tempPrefix = path.join(outputDir, `tmp-${process.pid}-${Date.now()}-${pageNumber}-${resolvedWidth}`);
  const tempOutputPath = `${tempPrefix}.jpg`;

  const task = (async () => {
    try {
      await execFileAsync(
        'pdftoppm',
        [
          '-jpeg',
          '-singlefile',
          '-f',
          String(pageNumber),
          '-l',
          String(pageNumber),
          '-scale-to',
          String(resolvedWidth),
          sourcePath,
          tempPrefix
        ],
        {
          timeout: 10 * 60 * 1000,
          maxBuffer: 1024 * 1024
        }
      );

      await rename(tempOutputPath, outputPath);
      return outputPath;
    } catch (error) {
      const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code) : '';
      if (code === 'ENOENT') {
        throw new Error('Preview generation requires pdftoppm to be installed.');
      }
      throw error;
    } finally {
      previewTasks.delete(outputPath);
      await unlink(tempOutputPath).catch(() => undefined);
    }
  })();

  previewTasks.set(outputPath, task);
  return task;
}

// ── Per-page PDF extraction (qpdf) ──

/** In-flight per-page PDF extraction tasks, keyed by output path to deduplicate. */
const pagePdfTasks = new Map<string, Promise<string>>();

/**
 * Extracts a single page from a source PDF using qpdf and caches it on disk.
 * Each extracted page is self-contained (~100-500KB) with its own fonts/images.
 * Used by slow/medium connections instead of range requests into the full file.
 */
export async function ensurePagePdf(storageKey: string, sourcePath: string, pageNumber: number): Promise<string> {
  const outputPath = getPagePdfPath(config.dataDir, storageKey, pageNumber);
  if (await fileExists(outputPath)) {
    return outputPath;
  }

  const existingTask = pagePdfTasks.get(outputPath);
  if (existingTask) {
    return existingTask;
  }

  const outputDir = getPreviewDirectory(config.dataDir, storageKey);
  await mkdir(outputDir, { recursive: true });

  const tempOutputPath = path.join(outputDir, `page-${String(pageNumber).padStart(5, '0')}.pdf.tmp.${nanoid(6)}`);

  const task = (async () => {
    try {
      await execFileAsync('qpdf', [
        sourcePath,
        '--pages', sourcePath, `${pageNumber}`, '--',
        tempOutputPath
      ], {
        timeout: 60_000,
        maxBuffer: 1024 * 1024
      });
      await rename(tempOutputPath, outputPath);
      return outputPath;
    } catch (error) {
      const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code) : '';
      if (code === 'ENOENT') {
        throw new Error('qpdf is not installed — cannot extract per-page PDF');
      }
      throw error;
    } finally {
      pagePdfTasks.delete(outputPath);
      await unlink(tempOutputPath).catch(() => undefined);
    }
  })();

  pagePdfTasks.set(outputPath, task);
  return task;
}

// ── Batch preview generation ──

/** Pre-generates previews at common widths for all pages, running PREVIEW_CONCURRENCY workers. */
export async function preGenerateAllPreviews(
  storageKey: string,
  sourcePath: string,
  pageCount: number
): Promise<void> {
  const tasks: Array<() => Promise<void>> = [];

  for (let page = 1; page <= pageCount; page++) {
    for (const width of PREVIEW_PREGENERATE_WIDTHS) {
      tasks.push(async () => {
        try {
          await ensurePdfPreviewImage(storageKey, sourcePath, page, width);
        } catch {
          // Best-effort — individual page failures don't stop the queue
        }
      });
    }
  }

  // Run PREVIEW_CONCURRENCY tasks at a time
  let index = 0;
  async function worker(): Promise<void> {
    while (index < tasks.length) {
      const task = tasks[index++];
      if (task) await task();
    }
  }

  const workers = Array.from({ length: PREVIEW_CONCURRENCY }, () => worker());
  await Promise.all(workers);
}

/** Checks if previews exist for a PDF (by sampling page 1) and regenerates all if missing. */
export async function ensureAllPreviewsExist(
  storageKey: string,
  sourcePath: string,
  pageCount: number
): Promise<void> {
  // Check if any preview is missing, only then run full pre-generation
  const sampleWidth = 240;
  const samplePath = getPreviewPath(config.dataDir, storageKey, 1, resolvePreviewWidth(sampleWidth));
  const hasSample = await fileExists(samplePath);
  if (!hasSample) {
    await preGenerateAllPreviews(storageKey, sourcePath, pageCount);
  }
}

// ── Outline extraction (mutool) ──

export interface PdfOutlineEntry {
  title: string;
  pageIndex: number;
}

/** Extracts the PDF outline (table of contents) using mutool. Returns empty on failure. */
export async function extractPdfOutline(filePath: string): Promise<PdfOutlineEntry[]> {
  try {
    // Try using dumppdf / mutool for outline extraction
    const { stdout } = await execFileAsync('mutool', ['show', filePath, 'outline'], {
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024
    });

    const entries: PdfOutlineEntry[] = [];
    // mutool outline format: indentation + title + page number
    // e.g. "	Chapter 1 Introduction	1"
    for (const line of stdout.split('\n')) {
      const match = line.match(/^[\t\s]*(.+?)\s+#(\d+)/);
      if (match) {
        entries.push({
          title: match[1].trim(),
          pageIndex: parseInt(match[2], 10) - 1
        });
      }
    }
    return entries;
  } catch {
    // mutool not available or no outline — return empty
    return [];
  }
}
