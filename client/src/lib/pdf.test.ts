import { afterEach, describe, expect, it } from 'vitest';
import {
  buildPdfRenderStateKey,
  getPdfRenderStrategy,
  getPdfSegmentCssBounds,
  getPdfSegmentCssLayout,
  getVisiblePdfSegments,
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

  it('keeps segment CSS bounds contiguous on compact readers', () => {
    const layout = getPdfSegmentCssLayout({
      pageHeight: 917,
      pageScale: 1,
      devicePixelRatio: 2,
      coarsePointer: true,
      viewportWidth: 820
    });

    expect(layout.top.top).toBe(0);
    expect(layout.top.bottom).toBe(layout.middle.top);
    expect(layout.middle.bottom).toBe(layout.bottom.top);
    expect(layout.bottom.bottom).toBe(917);
  });

  it('keeps fractional-scale segment CSS bounds contiguous and shell-covering', () => {
    const pageHeight = 917;
    const pageScale = 0.9975;
    const layout = getPdfSegmentCssLayout({
      pageHeight,
      pageScale,
      devicePixelRatio: 2,
      coarsePointer: true,
      viewportWidth: 820
    });

    expect(layout.top.top).toBe(0);
    expect(layout.top.bottom).toBe(layout.middle.top);
    expect(layout.middle.bottom).toBe(layout.bottom.top);
    expect(layout.bottom.bottom).toBeCloseTo(pageHeight * pageScale, 5);
  });

  it('returns single-segment bounds from the shared segment layout', () => {
    const layout = getPdfSegmentCssLayout({
      pageHeight: 917,
      pageScale: 1,
      devicePixelRatio: 2,
      coarsePointer: true,
      viewportWidth: 820
    });
    const middle = getPdfSegmentCssBounds({
      pageHeight: 917,
      pageScale: 1,
      devicePixelRatio: 2,
      coarsePointer: true,
      viewportWidth: 820,
      segment: 'middle'
    });

    expect(middle.top).toBe(layout.middle.top);
    expect(middle.height).toBe(layout.middle.height);
  });

  it('uses the shared segment layout to choose visible render segments', () => {
    const pageTop = 100;
    const pageHeight = 917;
    const pageScale = 0.9975;
    const layout = getPdfSegmentCssLayout({
      pageHeight,
      pageScale,
      devicePixelRatio: 2,
      coarsePointer: true,
      viewportWidth: 820
    });

    expect(
      getVisiblePdfSegments({
        pageTop,
        pageHeight,
        pageScale,
        viewportTop: pageTop + layout.top.bottom - 5,
        viewportHeight: 10,
        devicePixelRatio: 2,
        coarsePointer: true,
        viewportWidth: 820
      })
    ).toEqual(['top', 'middle']);

    expect(
      getVisiblePdfSegments({
        pageTop,
        pageHeight,
        pageScale,
        viewportTop: pageTop + layout.middle.top + 1,
        viewportHeight: Math.max(2, layout.middle.height - 2),
        devicePixelRatio: 2,
        coarsePointer: true,
        viewportWidth: 820
      })
    ).toEqual(['middle']);
  });

  it('renders the most-overlapped visible segment first', () => {
    const pageTop = 100;
    const pageHeight = 917;
    const pageScale = 0.9975;
    const layout = getPdfSegmentCssLayout({
      pageHeight,
      pageScale,
      devicePixelRatio: 2,
      coarsePointer: true,
      viewportWidth: 820
    });

    expect(
      getVisiblePdfSegments({
        pageTop,
        pageHeight,
        pageScale,
        viewportTop: pageTop + layout.middle.bottom - 40,
        viewportHeight: 120,
        devicePixelRatio: 2,
        coarsePointer: true,
        viewportWidth: 820
      })
    ).toEqual(['bottom', 'middle']);

    expect(
      getVisiblePdfSegments({
        pageTop,
        pageHeight,
        pageScale,
        viewportTop: pageTop + layout.top.bottom - 40,
        viewportHeight: 120,
        devicePixelRatio: 2,
        coarsePointer: true,
        viewportWidth: 820
      })
    ).toEqual(['middle', 'top']);
  });

  it('falls back to top segment when the viewport is outside the page shell', () => {
    expect(
      getVisiblePdfSegments({
        pageTop: 500,
        pageHeight: 917,
        pageScale: 1,
        viewportTop: 0,
        viewportHeight: 100,
        devicePixelRatio: 2,
        coarsePointer: true,
        viewportWidth: 820
      })
    ).toEqual(['top']);
  });

  it('changes render strategy and render-state identity when low-data mode switches to full-page rendering', () => {
    expect(getPdfRenderStrategy('fast')).toBe('segmented');
    expect(getPdfRenderStrategy('medium')).toBe('segmented');
    expect(getPdfRenderStrategy('slow')).toBe('full');

    const segmentedKey = buildPdfRenderStateKey({
      pageScale: 1,
      pageWidth: 780,
      pageHeight: 960,
      connectionQuality: 'medium'
    });
    const fullKey = buildPdfRenderStateKey({
      pageScale: 1,
      pageWidth: 780,
      pageHeight: 960,
      connectionQuality: 'slow'
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
      connectionQuality: 'fast'
    });
    const resizedKey = buildPdfRenderStateKey({
      pageScale: 1.125,
      pageWidth: 877.5,
      pageHeight: 1080,
      connectionQuality: 'fast'
    });

    expect(initialKey).not.toBe(resizedKey);
  });
});
