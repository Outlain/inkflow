import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';

async function createPdf(filePath: string, pageCount: number): Promise<void> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);

  for (let index = 0; index < pageCount; index += 1) {
    const page = document.addPage([612, 792]);
    page.drawText(`Calculus test page ${index + 1}`, {
      x: 72,
      y: 720,
      size: 24,
      font
    });
  }

  await writeFile(filePath, await document.save());
}

describe('pdf import, insert flow, and bookmark reopen', () => {
  let dataDir = '';
  let tempPdfPath = '';

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'inkflow-pdf-test-'));
    tempPdfPath = path.join(dataDir, 'sample.pdf');
    process.env.DATA_DIR = dataDir;
    vi.resetModules();
    await createPdf(tempPdfPath, 3);
  });

  afterEach(async () => {
    const database = await import('../db/database.js');
    database.resetDb();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('imports a PDF into a document bundle', async () => {
    const importer = await import('./pdfImportService.js');
    const stats = await stat(tempPdfPath);
    const result = await importer.importPdfFromTemp({
      tempPath: tempPdfPath,
      originalName: 'sample.pdf',
      mimeType: 'application/pdf',
      size: stats.size,
      folderId: null
    });

    expect(result.document.pageCount).toBe(3);
    expect(result.files).toHaveLength(1);
    expect(result.pages[0].kind).toBe('pdf');
    expect(result.pages[0].sourcePageIndex).toBe(0);
  });

  it('inserts selected PDF pages into an existing notebook and preserves bookmark reopen', async () => {
    const importer = await import('./pdfImportService.js');
    const library = await import('./libraryService.js');
    const stats = await stat(tempPdfPath);
    const notebook = library.createNotebook({
      title: 'Notebook',
      template: 'ruled',
      pageCount: 2,
      folderId: null,
      coverColor: '#315f85'
    });

    const prepared = await importer.preparePdfInsertionFromTemp({
      tempPath: tempPdfPath,
      originalName: 'sample.pdf',
      mimeType: 'application/pdf',
      size: stats.size,
      pageRange: '1-2'
    });

    const inserted = library.insertPdfPages(notebook.document.id, notebook.pages[0].id, 'after', prepared);
    expect(inserted.document.pageCount).toBe(4);
    expect(inserted.pages[1].kind).toBe('pdf');
    expect(inserted.pages[1].sourcePageIndex).toBe(0);
    expect(inserted.pages[2].sourcePageIndex).toBe(1);

    const bookmarked = library.setDocumentBookmark(notebook.document.id, { pageId: inserted.pages[2].id });
    expect(bookmarked.document.bookmarkPageId).toBe(inserted.pages[2].id);

    const reopened = library.getDocumentBundle(notebook.document.id);
    expect(reopened.document.bookmarkPageId).toBe(inserted.pages[2].id);
  });
});
