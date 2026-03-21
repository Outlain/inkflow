import { describe, expect, it } from 'vitest';
import { resolvePdfDeviceScale } from './pdf';

describe('resolvePdfDeviceScale', () => {
  it('caps coarse-pointer rendering to a lower device scale on compact readers', () => {
    expect(
      resolvePdfDeviceScale({
        devicePixelRatio: 2,
        pageScale: 1,
        coarsePointer: true,
        viewportWidth: 1024
      })
    ).toBeCloseTo(1.35);

    expect(
      resolvePdfDeviceScale({
        devicePixelRatio: 2,
        pageScale: 1.2,
        coarsePointer: true,
        viewportWidth: 1024
      })
    ).toBeCloseTo(1.5);
  });

  it('keeps desktop rendering crisp up to 2x device scale', () => {
    expect(
      resolvePdfDeviceScale({
        devicePixelRatio: 2.5,
        pageScale: 1,
        coarsePointer: false,
        viewportWidth: 1366
      })
    ).toBe(2);
  });
});
