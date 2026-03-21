import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Annotation } from '../../../shared/src/contracts.js';

describe('libraryService ordering and save behavior', () => {
  let dataDir = '';

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'inkflow-library-test-'));
    process.env.DATA_DIR = dataDir;
    vi.resetModules();
  });

  afterEach(async () => {
    const database = await import('../db/database.js');
    database.resetDb();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('keeps page positions ordered when inserting and deleting pages', async () => {
    const library = await import('./libraryService.js');
    const created = library.createNotebook({
      title: 'Ordering notebook',
      template: 'ruled',
      pageCount: 3,
      folderId: null,
      coverColor: '#315f85'
    });

    const inserted = library.insertBlankPage(created.document.id, {
      anchorPageId: created.pages[1].id,
      placement: 'before',
      template: 'grid'
    });

    const positions = inserted.pages.map((page) => page.position);
    expect(new Set(positions).size).toBe(positions.length);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));

    const deleted = library.deletePage(inserted.pages[2].id);
    const nextPositions = deleted.pages.map((page) => page.position);
    expect(new Set(nextPositions).size).toBe(nextPositions.length);
    expect(nextPositions).toEqual([...nextPositions].sort((left, right) => left - right));
    expect(deleted.document.pageCount).toBe(3);
  });

  it('supports append saves and guarded replace saves', async () => {
    const library = await import('./libraryService.js');
    const created = library.createNotebook({
      title: 'Save notebook',
      template: 'blank',
      pageCount: 1,
      folderId: null,
      coverColor: '#315f85'
    });

    const stroke: Annotation = {
      id: 'stroke-1',
      type: 'stroke',
      tool: 'pen',
      color: '#123f63',
      width: 2,
      points: [
        { x: 12, y: 18, pressure: 0.5, time: 1 },
        { x: 22, y: 30, pressure: 0.6, time: 2 }
      ]
    };

    const appendResult = library.savePageAnnotations({
      mode: 'append',
      pageId: created.pages[0].id,
      annotations: [stroke],
      annotationText: '',
      clientId: 'test-client',
      clientRevision: 1,
      baseRevision: 0
    });

    expect(appendResult.annotationRevision).toBe(1);
    expect(library.getPageAnnotations(created.pages[0].id).annotations).toHaveLength(1);

    const replaceResult = library.savePageAnnotations({
      mode: 'replace',
      pageId: created.pages[0].id,
      annotations: [],
      annotationText: '',
      clientId: 'test-client',
      clientRevision: 2,
      baseRevision: 1
    });

    expect(replaceResult.annotationRevision).toBe(2);
    expect(library.getPageAnnotations(created.pages[0].id).annotations).toHaveLength(0);

    expect(() =>
      library.savePageAnnotations({
        mode: 'replace',
        pageId: created.pages[0].id,
        annotations: [stroke],
        annotationText: '',
        clientId: 'test-client',
        clientRevision: 3,
        baseRevision: 0
      })
    ).toThrow(/conflict/i);
  });
});
