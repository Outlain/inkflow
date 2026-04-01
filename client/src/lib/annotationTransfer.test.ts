import { describe, expect, it } from 'vitest';
import type { PageAnnotation, PageRecord } from '@shared/contracts';
import { placeAnnotationsAcrossPages } from './annotationTransfer';
import type { PageShellLayout } from './reader/layout';

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

function pageLayout(id: string, params: { top: number; left: number; width: number; height: number; scale: number }): PageShellLayout {
  return {
    page: page(id, 600, 800),
    pageIndex: id === 'page-1' ? 0 : 1,
    top: params.top,
    left: params.left,
    width: params.width,
    height: params.height,
    scale: params.scale
  };
}

describe('placeAnnotationsAcrossPages', () => {
  it('moves an annotation onto the next page when its center crosses below the source page', () => {
    const sourceLayout = pageLayout('page-1', { top: 0, left: 0, width: 600, height: 800, scale: 1 });
    const targetLayout = pageLayout('page-2', { top: 810, left: 0, width: 600, height: 800, scale: 1 });
    const annotation: PageAnnotation = {
      id: 'text-1',
      type: 'text',
      text: 'hello',
      color: '#111',
      x: 100,
      y: 860,
      width: 120,
      height: 40,
      fontSize: 24
    };

    const [placement] = placeAnnotationsAcrossPages({
      annotations: [annotation],
      sourceLayout,
      pageLayouts: [sourceLayout, targetLayout]
    });

    expect(placement?.pageId).toBe('page-2');
    expect(placement?.annotation.type).toBe('text');
    if (placement?.annotation.type === 'text') {
      expect(placement.annotation.x).toBe(100);
      expect(placement.annotation.y).toBe(50);
    }
  });

  it('preserves screen position when the destination page uses a different scale', () => {
    const sourceLayout = pageLayout('page-1', { top: 0, left: 0, width: 600, height: 800, scale: 1 });
    const targetLayout = pageLayout('page-2', { top: 810, left: 40, width: 520, height: 1040, scale: 2 });
    const annotation: PageAnnotation = {
      id: 'text-2',
      type: 'text',
      text: 'scaled',
      color: '#111',
      x: 200,
      y: 900,
      width: 120,
      height: 40,
      fontSize: 24
    };

    const [placement] = placeAnnotationsAcrossPages({
      annotations: [annotation],
      sourceLayout,
      pageLayouts: [sourceLayout, targetLayout]
    });

    expect(placement?.pageId).toBe('page-2');
    if (placement?.annotation.type === 'text') {
      expect(placement.annotation.x).toBe(80);
      expect(placement.annotation.y).toBe(45);
    }
  });

  it('uses the drop point page instead of the selection center for large moved selections', () => {
    const sourceLayout = pageLayout('page-1', { top: 0, left: 0, width: 600, height: 800, scale: 1 });
    const targetLayout = pageLayout('page-2', { top: 810, left: 0, width: 600, height: 800, scale: 1 });
    const annotation: PageAnnotation = {
      id: 'text-3',
      type: 'text',
      text: 'large',
      color: '#111',
      x: 120,
      y: 620,
      width: 180,
      height: 220,
      fontSize: 24
    };

    const [placement] = placeAnnotationsAcrossPages({
      annotations: [annotation],
      sourceLayout,
      pageLayouts: [sourceLayout, targetLayout],
      targetPoint: { x: 220, y: 840, pressure: 0, time: 0 }
    });

    expect(placement?.pageId).toBe('page-2');
    if (placement?.annotation.type === 'text') {
      expect(placement.annotation.y).toBe(0);
    }
  });

  it('switches to the next page as soon as the drop point crosses below the source page', () => {
    const sourceLayout = pageLayout('page-1', { top: 0, left: 0, width: 600, height: 800, scale: 1 });
    const targetLayout = pageLayout('page-2', { top: 810, left: 0, width: 600, height: 800, scale: 1 });
    const annotation: PageAnnotation = {
      id: 'text-4',
      type: 'text',
      text: 'gap',
      color: '#111',
      x: 100,
      y: 760,
      width: 120,
      height: 40,
      fontSize: 24
    };

    const [placement] = placeAnnotationsAcrossPages({
      annotations: [annotation],
      sourceLayout,
      pageLayouts: [sourceLayout, targetLayout],
      targetPoint: { x: 140, y: 805, pressure: 0, time: 0 }
    });

    expect(placement?.pageId).toBe('page-2');
    if (placement?.annotation.type === 'text') {
      expect(placement.annotation.y).toBe(0);
    }
  });
});
