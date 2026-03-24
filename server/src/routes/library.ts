import fs from 'node:fs';
import { rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import type { FastifyRequest } from 'fastify';
import type { MultipartFile, MultipartValue } from '@fastify/multipart';
import { lookup as mimeLookup } from 'mime-types';
import { z } from 'zod';
import type {
  BookmarkPayload,
  CreateFolderInput,
  CreateNotebookInput,
  PageAnnotation,
  InsertBlankPageRequest,
  SavePageRequest
} from '../../../shared/src/contracts.js';
import { config } from '../config.js';
import { ensureDataLayout, getPreviewDirectory, getUploadPath } from '../lib/fs.js';
import { documentSyncHub } from '../realtime/hub.js';
import { exportDocumentPdf } from '../services/exportService.js';
import {
  assertFolderExists,
  createFolder,
  createNotebook,
  deleteDocument,
  deleteFolder,
  deletePage,
  getAllPdfFiles,
  getDocumentBundle,
  getFileRecord,
  getFileStorageKey,
  getPageAnnotations,
  getPageDocumentId,
  getPagePdfSource,
  insertBlankPage,
  insertPdfPages,
  listLibrary,
  savePageAnnotations,
  searchDocumentPages,
  setDocumentBookmark
} from '../services/libraryService.js';
import { importPdfFromTemp, preparePdfInsertionFromTemp } from '../services/pdfImportService.js';
import { ensureAllPreviewsExist, ensurePagePdf, ensurePdfPreviewImage } from '../services/pdfTools.js';
import { renderAnnotatedThumbnailSvg } from '../services/thumbnailService.js';

const folderSchema = z.object({
  title: z.string().trim().min(1).max(80),
  color: z.string().trim().min(4).max(32)
});

const notebookSchema = z.object({
  title: z.string().trim().min(1).max(120),
  template: z.enum(['blank', 'ruled', 'grid', 'dot']),
  pageCount: z.number().int().min(1).max(400),
  folderId: z.string().trim().min(1).nullable(),
  coverColor: z.string().trim().min(4).max(32)
});

const bookmarkSchema = z.object({
  pageId: z.string().trim().min(1).nullable()
});

const blankPageSchema = z.object({
  anchorPageId: z.string().trim().min(1),
  placement: z.enum(['before', 'after']),
  template: z.enum(['blank', 'ruled', 'grid', 'dot'])
});

const savePageSchema = z.object({
  mode: z.enum(['append', 'replace']),
  pageId: z.string().trim().min(1).optional(),
  annotations: z.array(z.any()),
  annotationText: z.string(),
  clientId: z.string().trim().min(1),
  clientRevision: z.number().int().min(0),
  baseRevision: z.number().int().min(0)
});

function stringField(field: unknown): string | null {
  const candidate = Array.isArray(field) ? field[0] : field;
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }

  if (!('type' in candidate) || (candidate as { type?: string }).type !== 'field') {
    return null;
  }

  const value = (candidate as { value?: unknown }).value;
  return typeof value === 'string' ? value.trim() : null;
}

function optionalField(field: unknown): string | null {
  const value = stringField(field);
  return value ? value : null;
}

async function collectMultipartUpload(request: FastifyRequest): Promise<{
  file: MultipartFile;
  fields: Record<string, MultipartValue>;
  tempPath: string;
}> {
  let file: MultipartFile | null = null;
  let tempPath = '';
  const fields: Record<string, MultipartValue> = {};

  for await (const part of request.parts()) {
    if (part.type === 'file') {
      if (file) {
        throw new Error('Only one file upload is supported.');
      }
      file = part;
      tempPath = await writeTempUpload(part);
      continue;
    }

    fields[part.fieldname] = part;
  }

  if (!file || !tempPath) {
    throw new Error('PDF file is required.');
  }

  return {
    file,
    fields,
    tempPath
  };
}

async function writeTempUpload(file: MultipartFile): Promise<string> {
  const dataPaths = ensureDataLayout(config.dataDir);
  const safeBaseName = path.basename(file.filename || 'upload.pdf').replace(/[^\w.-]+/g, '-');
  const tempPath = path.join(dataPaths.temp, `${Date.now()}-${safeBaseName}`);
  await pipeline(file.file, fs.createWriteStream(tempPath));
  return tempPath;
}

async function cleanupStorageArtifacts(storageKeys: string[]): Promise<void> {
  await Promise.all(
    [...new Set(storageKeys)].flatMap((storageKey) => [
      unlink(getUploadPath(config.dataDir, storageKey)).catch(() => undefined),
      rm(getPreviewDirectory(config.dataDir, storageKey), { recursive: true, force: true }).catch(() => undefined)
    ])
  );
}

async function sendPdfContent(
  reply: {
    code: (statusCode: number) => typeof reply;
    header: (key: string, value: string | number) => typeof reply;
    type: (value: string) => typeof reply;
    send: (payload: unknown) => unknown;
  },
  requestHeaders: Record<string, string | string[] | undefined>,
  filePath: string,
  contentType: string
) {
  const info = await stat(filePath);
  const rangeHeader = typeof requestHeaders.range === 'string' ? requestHeaders.range : undefined;

  reply.header('accept-ranges', 'bytes').type(contentType);

  if (!rangeHeader) {
    return reply.header('content-length', info.size).send(fs.createReadStream(filePath));
  }

  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) {
    return reply.code(416).header('content-range', `bytes */${info.size}`).send('');
  }

  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : info.size - 1;
  const safeStart = Number.isFinite(start) ? start : 0;
  const safeEnd = Number.isFinite(end) ? Math.min(end, info.size - 1) : info.size - 1;

  if (safeStart < 0 || safeStart >= info.size || safeEnd < safeStart) {
    return reply.code(416).header('content-range', `bytes */${info.size}`).send('');
  }

  return reply
    .code(206)
    .header('content-range', `bytes ${safeStart}-${safeEnd}/${info.size}`)
    .header('content-length', safeEnd - safeStart + 1)
    .send(fs.createReadStream(filePath, { start: safeStart, end: safeEnd }));
}

function sendValidationError(reply: { status: (code: number) => { send: (payload: unknown) => unknown } }, message: string) {
  return reply.status(400).send({ error: message });
}

async function repairMissingPreviews(): Promise<void> {
  const pdfFiles = getAllPdfFiles();
  for (const { storageKey, pageCount } of pdfFiles) {
    const sourcePath = getUploadPath(config.dataDir, storageKey);
    await ensureAllPreviewsExist(storageKey, sourcePath, pageCount).catch(() => undefined);
  }
}

export async function registerLibraryRoutes(app: FastifyInstance): Promise<void> {
  // Run on startup — fire and forget
  void repairMissingPreviews().catch(() => undefined);

  app.post('/admin/repair-previews', async (_request, reply) => {
    void repairMissingPreviews().catch(() => undefined);
    return reply.send({ started: true });
  });

  app.get('/library', async () => listLibrary());

  app.get('/documents/:documentId', async (request, reply) => {
    try {
      const { documentId } = request.params as { documentId: string };
      return reply.send(getDocumentBundle(documentId));
    } catch (error) {
      return reply.status(404).send({ error: error instanceof Error ? error.message : 'Document not found.' });
    }
  });

  app.post('/folders', async (request, reply) => {
    const parsed = folderSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.issues[0]?.message ?? 'Invalid folder.');
    }

    const input = parsed.data satisfies CreateFolderInput;
    return reply.status(201).send(createFolder(input));
  });

  app.delete('/folders/:folderId', async (request, reply) => {
    try {
      const { folderId } = request.params as { folderId: string };
      const storageKeys = deleteFolder(folderId);
      await cleanupStorageArtifacts(storageKeys);
      return reply.send(listLibrary());
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'Could not delete folder.' });
    }
  });

  app.post('/documents/notebook', async (request, reply) => {
    const parsed = notebookSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.issues[0]?.message ?? 'Invalid notebook.');
    }

    const input = parsed.data satisfies CreateNotebookInput;

    try {
      assertFolderExists(input.folderId);
      return reply.status(201).send(createNotebook(input));
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'Could not create notebook.' });
    }
  });

  app.delete('/documents/:documentId', async (request, reply) => {
    try {
      const { documentId } = request.params as { documentId: string };
      const storageKeys = deleteDocument(documentId);
      await cleanupStorageArtifacts(storageKeys);
      return reply.send(listLibrary());
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'Could not delete document.' });
    }
  });

  app.get('/documents/:documentId/export', async (request, reply) => {
    try {
      const { documentId } = request.params as { documentId: string };
      const result = await exportDocumentPdf(documentId);
      return reply
        .type('application/pdf')
        .header('content-disposition', `attachment; filename="${result.filename.replace(/"/g, '')}"`)
        .send(Buffer.from(result.bytes));
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'Could not export document.' });
    }
  });

  app.post('/documents/import-pdf', async (request, reply) => {
    let upload;

    try {
      upload = await collectMultipartUpload(request);
    } catch (error) {
      return sendValidationError(reply, error instanceof Error ? error.message : 'PDF file is required.');
    }

    const { file, fields, tempPath } = upload;
    const folderId = optionalField(fields.folderId);
    const mimeType = file.mimetype || 'application/pdf';

    if (!mimeType.includes('pdf') && !file.filename.toLowerCase().endsWith('.pdf')) {
      return sendValidationError(reply, 'Only PDF uploads are supported.');
    }
    try {
      assertFolderExists(folderId);
      const stats = await stat(tempPath);
      const payload = await importPdfFromTemp({
        tempPath,
        originalName: file.filename,
        mimeType,
        size: stats.size,
        folderId
      });
      return reply.status(201).send(payload);
    } catch (error) {
      request.log.error({ err: error }, 'PDF import failed');
      return reply.status(500).send({ error: error instanceof Error ? error.message : 'Could not import PDF.' });
    } finally {
      await unlink(tempPath).catch(() => undefined);
    }
  });

  app.patch('/documents/:documentId/bookmark', async (request, reply) => {
    const parsed = bookmarkSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.issues[0]?.message ?? 'Invalid bookmark payload.');
    }

    try {
      const { documentId } = request.params as { documentId: string };
      const payload = parsed.data satisfies BookmarkPayload;
      const result = setDocumentBookmark(documentId, payload);
      documentSyncHub.broadcast(documentId, {
        type: 'document.changed',
        documentId,
        senderClientId: 'server'
      });
      return reply.send(result);
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'Could not update bookmark.' });
    }
  });

  app.get('/documents/:documentId/search', async (request, reply) => {
    try {
      const { documentId } = request.params as { documentId: string };
      const { query = '' } = request.query as { query?: string };
      return reply.send(searchDocumentPages(documentId, query));
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'Search failed.' });
    }
  });

  app.post('/documents/:documentId/pages/blank', async (request, reply) => {
    const parsed = blankPageSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.issues[0]?.message ?? 'Invalid page insert payload.');
    }

    try {
      const { documentId } = request.params as { documentId: string };
      const payload = parsed.data satisfies InsertBlankPageRequest;
      const result = insertBlankPage(documentId, payload);
      documentSyncHub.broadcast(documentId, {
        type: 'document.changed',
        documentId,
        senderClientId: 'server'
      });
      return reply.send(result);
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'Could not insert blank page.' });
    }
  });

  app.post('/documents/:documentId/pages/import-pdf', async (request, reply) => {
    const { documentId } = request.params as { documentId: string };
    let upload;

    try {
      upload = await collectMultipartUpload(request);
    } catch (error) {
      return sendValidationError(reply, error instanceof Error ? error.message : 'PDF file is required.');
    }

    const { file, fields, tempPath } = upload;
    const anchorPageId = stringField(fields.anchorPageId);
    const placement = stringField(fields.placement);
    const pageRange = stringField(fields.pageRange) ?? '';
    const mimeType = file.mimetype || 'application/pdf';

    if (!anchorPageId || (placement !== 'before' && placement !== 'after')) {
      return sendValidationError(reply, 'Anchor page and placement are required.');
    }

    if (!mimeType.includes('pdf') && !file.filename.toLowerCase().endsWith('.pdf')) {
      return sendValidationError(reply, 'Only PDF uploads are supported.');
    }
    try {
      const stats = await stat(tempPath);
      const source = await preparePdfInsertionFromTemp({
        tempPath,
        originalName: file.filename,
        mimeType,
        size: stats.size,
        pageRange
      });

      const result = insertPdfPages(documentId, anchorPageId, placement, source);
      documentSyncHub.broadcast(documentId, {
        type: 'document.changed',
        documentId,
        senderClientId: 'server'
      });
      return reply.send(result);
    } catch (error) {
      request.log.error({ err: error }, 'PDF page insertion failed');
      return reply.status(500).send({ error: error instanceof Error ? error.message : 'Could not insert PDF pages.' });
    } finally {
      await unlink(tempPath).catch(() => undefined);
    }
  });

  app.delete('/pages/:pageId', async (request, reply) => {
    try {
      const { pageId } = request.params as { pageId: string };
      const result = deletePage(pageId);
      documentSyncHub.broadcast(result.document.id, {
        type: 'document.changed',
        documentId: result.document.id,
        senderClientId: 'server'
      });
      return reply.send(result);
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'Could not delete page.' });
    }
  });

  app.get('/pages/:pageId/annotations', async (request, reply) => {
    try {
      const { pageId } = request.params as { pageId: string };
      return reply.send(getPageAnnotations(pageId));
    } catch (error) {
      return reply.status(404).send({ error: error instanceof Error ? error.message : 'Page not found.' });
    }
  });

  app.post('/pages/:pageId/annotations', async (request, reply) => {
    const parsed = savePageSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.issues[0]?.message ?? 'Invalid save payload.');
    }

    try {
      const { pageId } = request.params as { pageId: string };
      const payload = parsed.data satisfies Omit<SavePageRequest, 'pageId'> & { pageId?: string };
      const result = savePageAnnotations({
        ...payload,
        pageId
      });
      documentSyncHub.broadcast(getPageDocumentId(pageId), {
        type: 'page.updated',
        documentId: getPageDocumentId(pageId),
        pageId,
        annotationRevision: result.annotationRevision,
        updatedAt: result.updatedAt,
        senderClientId: payload.clientId
      });
      return reply.send(result);
    } catch (error) {
      const statusCode =
        error && typeof error === 'object' && 'statusCode' in error && typeof (error as { statusCode?: unknown }).statusCode === 'number'
          ? ((error as { statusCode: number }).statusCode as number)
          : 400;
      return reply.status(statusCode).send({ error: error instanceof Error ? error.message : 'Could not save annotations.' });
    }
  });

  app.get('/files/:fileId/content', async (request, reply) => {
    try {
      const { fileId } = request.params as { fileId: string };
      const file = getFileRecord(fileId);
      const filePath = getUploadPath(config.dataDir, getFileStorageKey(fileId));
      reply.header('cache-control', 'public, max-age=31536000, immutable');
      reply.header('content-disposition', `inline; filename="${file.originalName.replace(/"/g, '')}"`);
      return sendPdfContent(
        reply,
        request.headers,
        filePath,
        file.mimeType || (mimeLookup(file.originalName) || 'application/pdf').toString()
      );
    } catch (error) {
      return reply.status(404).send({ error: error instanceof Error ? error.message : 'File not found.' });
    }
  });

  app.get('/pages/:pageId/preview', async (request, reply) => {
    try {
      const { pageId } = request.params as { pageId: string };
      const width = Number((request.query as { width?: string }).width ?? 240);
      const source = getPagePdfSource(pageId);
      const filePath = getUploadPath(config.dataDir, source.storageKey);
      const previewPath = await ensurePdfPreviewImage(source.storageKey, filePath, source.sourcePageIndex + 1, width);
      return reply.type('image/jpeg').header('cache-control', 'public, max-age=31536000, immutable').send(fs.createReadStream(previewPath));
    } catch (error) {
      return reply.status(404).send({ error: error instanceof Error ? error.message : 'Preview not available.' });
    }
  });

  // Per-page PDF endpoint — extracts a single page from the source PDF on demand.
  // Used by slow/medium connections so PDF.js can download ~100-500KB per page
  // instead of needing range requests into the full 81MB file.
  app.get('/pages/:pageId/pdf', async (request, reply) => {
    try {
      const { pageId } = request.params as { pageId: string };
      const source = getPagePdfSource(pageId);
      const filePath = getUploadPath(config.dataDir, source.storageKey);
      const pagePdfPath = await ensurePagePdf(source.storageKey, filePath, source.sourcePageIndex + 1);
      return reply
        .type('application/pdf')
        .header('cache-control', 'public, max-age=31536000, immutable')
        .send(fs.createReadStream(pagePdfPath));
    } catch (error) {
      return reply.status(404).send({ error: error instanceof Error ? error.message : 'Page PDF not available.' });
    }
  });

  app.get('/pages/:pageId/thumbnail', async (request, reply) => {
    try {
      const { pageId } = request.params as { pageId: string };
      const width = Number((request.query as { width?: string }).width ?? 240);
      const documentId = getPageDocumentId(pageId);
      const bundle = getDocumentBundle(documentId);
      const page = bundle.pages.find((entry) => entry.id === pageId);

      if (!page) {
        return reply.status(404).send({ error: 'Page not found.' });
      }

      const annotations = getPageAnnotations(pageId).annotations as PageAnnotation[];
      const pdfSource = page.kind === 'pdf' ? getPagePdfSource(pageId) : null;
      const svg = await renderAnnotatedThumbnailSvg({
        page,
        annotations,
        previewWidth: width,
        pdfSource: pdfSource
          ? {
              storageKey: pdfSource.storageKey,
              sourcePageIndex: pdfSource.sourcePageIndex
            }
          : null
      });

      return reply.type('image/svg+xml').header('cache-control', 'no-store').send(svg);
    } catch (error) {
      return reply.status(404).send({ error: error instanceof Error ? error.message : 'Thumbnail not available.' });
    }
  });

  app.get('/pages/:pageId/document', async (request, reply) => {
    try {
      const { pageId } = request.params as { pageId: string };
      return reply.send({ documentId: getPageDocumentId(pageId) });
    } catch (error) {
      return reply.status(404).send({ error: error instanceof Error ? error.message : 'Page not found.' });
    }
  });
}
