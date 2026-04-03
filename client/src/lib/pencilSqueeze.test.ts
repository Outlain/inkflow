import { describe, expect, it } from 'vitest';

import {
  resolvePencilSqueezeArcContentHeight,
  resolvePencilSqueezeArcToolLayout,
  resolvePencilSqueezeMenuPlacement
} from './pencilSqueeze';

describe('resolvePencilSqueezeMenuPlacement', () => {
  it('prefers placing the menu to the left whenever there is room', () => {
    expect(
      resolvePencilSqueezeMenuPlacement({
        anchorX: 620,
        anchorY: 400,
        rootWidth: 900,
        rootHeight: 768,
        menuWidth: 180,
        menuHeight: 300
      })
    ).toEqual({
      left: 430,
      top: 295,
      side: 'left'
    });
  });

  it('falls back to the right when there is no room on the left', () => {
    expect(
      resolvePencilSqueezeMenuPlacement({
        anchorX: 40,
        anchorY: 40,
        rootWidth: 900,
        rootHeight: 700,
        menuWidth: 180,
        menuHeight: 320
      })
    ).toEqual({
      left: 50,
      top: 16,
      side: 'right'
    });
  });
});

describe('resolvePencilSqueezeArcToolLayout', () => {
  it('places left-side tools along an inward-facing arc', () => {
    const first = resolvePencilSqueezeArcToolLayout({
      index: 0,
      total: 8,
      side: 'left',
      shellWidth: 195
    });
    const middle = resolvePencilSqueezeArcToolLayout({
      index: 4,
      total: 8,
      side: 'left',
      shellWidth: 195
    });

    expect(first.left).toBeGreaterThan(middle.left);
    expect(first.top).toBeLessThan(middle.top);
    expect(first.left).toBeGreaterThan(110);
  });

  it('mirrors right-side tools inside the shell bounds', () => {
    const leftSide = resolvePencilSqueezeArcToolLayout({
      index: 2,
      total: 8,
      side: 'left',
      shellWidth: 195
    });
    const rightSide = resolvePencilSqueezeArcToolLayout({
      index: 2,
      total: 8,
      side: 'right',
      shellWidth: 195
    });

    expect(leftSide.left + rightSide.left + rightSide.size).toBeCloseTo(195, 5);
    expect(rightSide.left + rightSide.size).toBeLessThanOrEqual(195);
    expect(leftSide.left + leftSide.size).toBeLessThanOrEqual(195);
  });

  it('computes a content height that contains the full arc', () => {
    expect(
      resolvePencilSqueezeArcContentHeight({
        total: 8,
        buttonSize: 48,
        padding: 8
      })
    ).toBe(328);
  });
});
