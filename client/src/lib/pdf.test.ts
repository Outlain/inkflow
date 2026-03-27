import { afterEach, describe, expect, it } from 'vitest';
import { resolvePdfDeviceScale } from './pdf';
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
});
