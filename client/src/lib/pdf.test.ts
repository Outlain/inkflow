import { afterEach, describe, expect, it } from 'vitest';
import { getPdfSegmentCssBounds, resolvePdfDeviceScale } from './pdf';
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
    const top = getPdfSegmentCssBounds({
      pageHeight: 917,
      pageScale: 1,
      devicePixelRatio: 2,
      coarsePointer: true,
      viewportWidth: 820,
      segment: 'top'
    });
    const middle = getPdfSegmentCssBounds({
      pageHeight: 917,
      pageScale: 1,
      devicePixelRatio: 2,
      coarsePointer: true,
      viewportWidth: 820,
      segment: 'middle'
    });
    const bottom = getPdfSegmentCssBounds({
      pageHeight: 917,
      pageScale: 1,
      devicePixelRatio: 2,
      coarsePointer: true,
      viewportWidth: 820,
      segment: 'bottom'
    });

    expect(top.top).toBe(0);
    expect(middle.top).toBe(top.top + top.height);
    expect(bottom.top).toBe(middle.top + middle.height);
    expect(bottom.top + bottom.height).toBe(917);
  });
});
