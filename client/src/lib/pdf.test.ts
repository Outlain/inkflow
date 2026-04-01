import { afterEach, describe, expect, it } from 'vitest';
import {
  buildPdfRenderStateKey,
  getOrderedPdfRenderSlices,
  getPdfRenderSlices,
  getPdfRenderStrategy,
  getVisiblePdfRenderSlices,
  resolvePdfDeviceScale
} from './pdf';
import { setLowDataMode } from './networkMonitor';

describe('resolvePdfDeviceScale', () => {
  afterEach(() => {
    setLowDataMode(null);
  });

  it('caps compact-reader rendering at 2x device scale', () => {
    expect(
      resolvePdfDeviceScale({
        devicePixelRatio: 2,
        pageScale: 1,
        coarsePointer: true,
        viewportWidth: 1024
      })
    ).toBe(2);

    expect(
      resolvePdfDeviceScale({
        devicePixelRatio: 3,
        pageScale: 1.2,
        coarsePointer: true,
        viewportWidth: 1024
      })
    ).toBe(2);
  });

  it('keeps desktop rendering at native DPR on wide readers', () => {
    expect(
      resolvePdfDeviceScale({
        devicePixelRatio: 2.5,
        pageScale: 1,
        coarsePointer: false,
        viewportWidth: 1366
      })
    ).toBe(2.5);
  });

  it('does not force low data mode down to 1x DPR', () => {
    setLowDataMode('slow');

    expect(
      resolvePdfDeviceScale({
        devicePixelRatio: 2,
        pageScale: 1,
        coarsePointer: false,
        viewportWidth: 1366
      })
    ).toBe(2);

    expect(
      resolvePdfDeviceScale({
        devicePixelRatio: 2,
        pageScale: 1,
        coarsePointer: true,
        viewportWidth: 1024
      })
    ).toBe(2);
  });

  it('keeps slice CSS bounds contiguous on compact readers', () => {
    const slices = getPdfRenderSlices({
      pageHeight: 917,
      pageScale: 1,
      devicePixelRatio: 2,
      coarsePointer: true,
      viewportWidth: 820
    });

    expect(slices.length).toBeGreaterThan(3);
    expect(slices[0]?.top).toBe(0);
    for (let index = 1; index < slices.length; index += 1) {
      expect(slices[index - 1]?.bottom).toBe(slices[index]?.top);
    }
    expect(slices.at(-1)?.bottom).toBe(917);
  });

  it('keeps fractional-scale slice CSS bounds contiguous and shell-covering', () => {
    const pageHeight = 917;
    const pageScale = 0.9975;
    const slices = getPdfRenderSlices({
      pageHeight,
      pageScale,
      devicePixelRatio: 2,
      coarsePointer: true,
      viewportWidth: 820
    });

    expect(slices[0]?.top).toBe(0);
    for (let index = 1; index < slices.length; index += 1) {
      expect(slices[index - 1]?.bottom).toBe(slices[index]?.top);
    }
    expect(slices.at(-1)?.bottom).toBeCloseTo(pageHeight * pageScale, 5);
  });

  it('uses the shared slice layout to choose visible render slices', () => {
    const pageTop = 100;
    const pageHeight = 917;
    const pageScale = 0.9975;
    const slices = getPdfRenderSlices({
      pageHeight,
      pageScale,
      devicePixelRatio: 2,
      coarsePointer: true,
      viewportWidth: 820
    });

    const nearBoundarySlices = getVisiblePdfRenderSlices({
      pageTop,
      pageHeight,
      pageScale,
      viewportTop: pageTop + slices[0]!.bottom - 5,
      viewportHeight: 10,
      devicePixelRatio: 2,
      coarsePointer: true,
      viewportWidth: 820
    });
    expect(nearBoundarySlices.map((slice) => slice.id)).toEqual([slices[0]!.id, slices[1]!.id]);

    const interiorSlices = getVisiblePdfRenderSlices({
      pageTop,
      pageHeight,
      pageScale,
      viewportTop: pageTop + slices[1]!.top + 1,
      viewportHeight: Math.max(2, slices[1]!.height - 2),
      devicePixelRatio: 2,
      coarsePointer: true,
      viewportWidth: 820
    });
    expect(interiorSlices.map((slice) => slice.id)).toEqual([slices[1]!.id]);
  });

  it('renders the most-overlapped visible slice first', () => {
    const pageTop = 100;
    const pageHeight = 917;
    const pageScale = 0.9975;
    const slices = getPdfRenderSlices({
      pageHeight,
      pageScale,
      devicePixelRatio: 2,
      coarsePointer: true,
      viewportWidth: 820
    });

    const orderedVisibleSlices = getVisiblePdfRenderSlices({
      pageTop,
      pageHeight,
      pageScale,
      viewportTop: pageTop + slices[1]!.bottom - 40,
      viewportHeight: 120,
      devicePixelRatio: 2,
      coarsePointer: true,
      viewportWidth: 820
    });

    expect(orderedVisibleSlices.map((slice) => slice.id)).toEqual([slices[2]!.id, slices[1]!.id]);
  });

  it('prefers lower visible slices first when resuming after upward scroll', () => {
    const pageTop = 100;
    const pageHeight = 917;
    const pageScale = 0.9975;
    const slices = getPdfRenderSlices({
      pageHeight,
      pageScale,
      devicePixelRatio: 2,
      coarsePointer: true,
      viewportWidth: 820
    });

    const upwardVisibleSlices = getVisiblePdfRenderSlices({
      pageTop,
      pageHeight,
      pageScale,
      viewportTop: pageTop + slices[1]!.bottom - 40,
      viewportHeight: 120,
      scrollDirection: 'up',
      devicePixelRatio: 2,
      coarsePointer: true,
      viewportWidth: 820
    });

    expect(upwardVisibleSlices.map((slice) => slice.id)).toEqual([slices[2]!.id, slices[1]!.id]);
  });

  it('prefers upper visible slices first when resuming after downward scroll', () => {
    const pageTop = 100;
    const pageHeight = 917;
    const pageScale = 0.9975;
    const slices = getPdfRenderSlices({
      pageHeight,
      pageScale,
      devicePixelRatio: 2,
      coarsePointer: true,
      viewportWidth: 820
    });

    const downwardVisibleSlices = getVisiblePdfRenderSlices({
      pageTop,
      pageHeight,
      pageScale,
      viewportTop: pageTop + slices[1]!.bottom - 40,
      viewportHeight: 120,
      scrollDirection: 'down',
      devicePixelRatio: 2,
      coarsePointer: true,
      viewportWidth: 820
    });

    expect(downwardVisibleSlices.map((slice) => slice.id)).toEqual([slices[1]!.id, slices[2]!.id]);
  });

  it('orders off-screen slices by viewport proximity after visible ones', () => {
    const pageTop = 100;
    const pageHeight = 917;
    const pageScale = 1;
    const slices = getPdfRenderSlices({
      pageHeight,
      pageScale,
      devicePixelRatio: 2,
      coarsePointer: true,
      viewportWidth: 820
    });

    const orderedSlices = getOrderedPdfRenderSlices({
      pageTop,
      pageHeight,
      pageScale,
      viewportTop: pageTop + slices.at(-1)!.top + 10,
      viewportHeight: Math.max(40, slices.at(-1)!.height - 20),
      devicePixelRatio: 2,
      coarsePointer: true,
      viewportWidth: 820
    });

    expect(orderedSlices.map((slice) => slice.id)).toEqual(
      [...slices].reverse().map((slice) => slice.id)
    );
  });

  it('falls back to the first slice when the viewport is outside the page shell', () => {
    expect(
      getVisiblePdfRenderSlices({
        pageTop: 500,
        pageHeight: 917,
        pageScale: 1,
        viewportTop: 0,
        viewportHeight: 100,
        devicePixelRatio: 2,
        coarsePointer: true,
        viewportWidth: 820
      }).map((slice) => slice.id)
    ).toEqual(['slice:0']);
  });

  it('changes render strategy and render-state identity when low-data mode switches to full-page rendering', () => {
    expect(getPdfRenderStrategy('fast')).toBe('segmented');
    expect(getPdfRenderStrategy('medium')).toBe('segmented');
    expect(getPdfRenderStrategy('slow')).toBe('full');

    const segmentedKey = buildPdfRenderStateKey({
      pageScale: 1,
      pageWidth: 780,
      pageHeight: 960,
      connectionQuality: 'medium',
      devicePixelRatio: 2,
      coarsePointer: true,
      viewportWidth: 820
    });
    const fullKey = buildPdfRenderStateKey({
      pageScale: 1,
      pageWidth: 780,
      pageHeight: 960,
      connectionQuality: 'slow',
      devicePixelRatio: 2,
      coarsePointer: true,
      viewportWidth: 820
    });

    expect(segmentedKey).not.toBe(fullKey);
    expect(segmentedKey).toContain(':medium:segmented');
    expect(fullKey).toContain(':slow:full');
  });

  it('changes render-state identity when shell geometry changes', () => {
    const initialKey = buildPdfRenderStateKey({
      pageScale: 1,
      pageWidth: 780,
      pageHeight: 960,
      connectionQuality: 'fast',
      devicePixelRatio: 2,
      coarsePointer: false,
      viewportWidth: 1366
    });
    const resizedKey = buildPdfRenderStateKey({
      pageScale: 1.125,
      pageWidth: 877.5,
      pageHeight: 1080,
      connectionQuality: 'fast',
      devicePixelRatio: 2,
      coarsePointer: false,
      viewportWidth: 1366
    });

    expect(initialKey).not.toBe(resizedKey);
  });

  it('changes render-state identity when device scale changes', () => {
    const laptopKey = buildPdfRenderStateKey({
      pageScale: 1,
      pageWidth: 780,
      pageHeight: 960,
      connectionQuality: 'fast',
      devicePixelRatio: 1,
      coarsePointer: false,
      viewportWidth: 1366
    });
    const retinaKey = buildPdfRenderStateKey({
      pageScale: 1,
      pageWidth: 780,
      pageHeight: 960,
      connectionQuality: 'fast',
      devicePixelRatio: 2,
      coarsePointer: false,
      viewportWidth: 1366
    });

    expect(laptopKey).not.toBe(retinaKey);
  });
});
