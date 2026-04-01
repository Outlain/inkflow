import { describe, expect, it } from 'vitest';

import { resolvePencilSqueezeMenuPlacement } from './pencilSqueeze';

describe('resolvePencilSqueezeMenuPlacement', () => {
  it('places the menu to the left when the anchor is near the right side', () => {
    expect(
      resolvePencilSqueezeMenuPlacement({
        anchorX: 920,
        anchorY: 400,
        rootWidth: 1024,
        rootHeight: 768,
        menuWidth: 180,
        menuHeight: 300
      })
    ).toEqual({
      left: 722,
      top: 250,
      side: 'left'
    });
  });

  it('clamps the menu inside the reader bounds', () => {
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
      left: 58,
      top: 16,
      side: 'right'
    });
  });
});
