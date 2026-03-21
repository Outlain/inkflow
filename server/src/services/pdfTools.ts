import { execFile } from 'node:child_process';
import { access, copyFile, mkdir, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { nanoid } from 'nanoid';
import { config } from '../config.js';
import { getPreviewDirectory, getPreviewPath } from '../lib/fs.js';

const execFileAsync = promisify(execFile);
const previewTasks = new Map<string, Promise<string>>();
const previewWidthBuckets = [120, 180, 240, 320, 480, 720, 960, 1280];

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

export async function extractPdfMetadata(filePath: string): Promise<PdfMetadata> {
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

export async function finalizeUploadedPdf(tempPath: string, outputPath: string, fileSize: number): Promise<void> {
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

export function resolvePreviewWidth(requestedWidth: number): number {
  const safeWidth = Math.max(120, Math.min(1280, Math.round(requestedWidth)));
  const bucket = previewWidthBuckets.find((value) => value >= safeWidth);
  return bucket ?? previewWidthBuckets[previewWidthBuckets.length - 1];
}

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
