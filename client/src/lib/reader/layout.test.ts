import { describe, expect, it } from 'vitest';
import type { PageRecord } from '@shared/contracts';
import { ReaderLayoutEngine } from './layout';

function page(id: string, width: number, height: number): PageRecord {
  return {
    id,
    documentId: 'doc-1',
    position: 0,
    kind: 'pdf',
    sourceFileId: 'file-1',
    sourcePageIndex: 0,
    template: null,
    width,
    height,
    annotationRevision: 0,
    updatedAt: new Date().toISOString(),
    annotationText: ''
  };
}

describe('ReaderLayoutEngine', () => {
  it('produces stable shell sizes from page metadata for repeated builds', () => {
    const engine = new ReaderLayoutEngine();
    const pages = [page('one', 612, 792), page('two', 600, 800), page('three', 500, 700)];

    const first = engine.build(pages, 900, 1);
    const second = engine.build(pages, 900, 1);

    expect(second.pages.map((entry) => [entry.top, entry.width, entry.height])).toEqual(
      first.pages.map((entry) => [entry.top, entry.width, entry.height])
    );
  });

  it('limits visible work to the viewport window plus overscan', () => {
    const engine = new ReaderLayoutEngine();
    const pages = Array.from({ length: 10 }, (_, index) => page(String(index), 612, 792));
    const layout = engine.build(pages, 900, 1);

    const visible = engine.getVisibleWindow(layout, 0, 1200, 1);
    expect(visible.start).toBe(0);
    expect(visible.end).toBeLessThan(5);
  });

  it('resolves the active page from the visible window instead of scanning the whole document', () => {
    const engine = new ReaderLayoutEngine();
    const pages = Array.from({ length: 1400 }, (_, index) => page(String(index), 612, 792));
    const layout = engine.build(pages, 900, 1);
    const targetPage = layout.pages[863];
    const scrollTop = targetPage.top - 120;

    expect(engine.getActivePage(layout, scrollTop, 1200)).toBe(863);
  });
});
