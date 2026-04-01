import { describe, expect, it } from 'vitest';

import {
  selectionBoundsRegionFromAnnotations,
  selectionRegionFromLassoPoints,
  translateSelectionRegion,
  type SelectionRegion
} from './selectionRegion';

describe('selectionRegion', () => {
  it('builds a rectangle region from lasso endpoints', () => {
    expect(
      selectionRegionFromLassoPoints(
        [
          { x: 14, y: 18, pressure: 0.5, time: 1 },
          { x: 40, y: 52, pressure: 0.5, time: 2 }
        ],
        'rectangle'
      )
    ).toEqual({
      mode: 'rectangle',
      left: 14,
      top: 18,
      right: 40,
      bottom: 52
    });
  });

  it('closes freehand regions and translates them without changing shape', () => {
    const region = selectionRegionFromLassoPoints(
      [
        { x: 10, y: 12, pressure: 0.5, time: 1 },
        { x: 36, y: 18, pressure: 0.5, time: 2 },
        { x: 22, y: 48, pressure: 0.5, time: 3 }
      ],
      'freehand'
    ) as SelectionRegion;

    expect(region.mode).toBe('freehand');
    if (region.mode !== 'freehand') {
      return;
    }

    expect(region.polygon[0]).toEqual(region.polygon[region.polygon.length - 1]);

    expect(translateSelectionRegion(region, 5, -3)).toEqual({
      mode: 'freehand',
      polygon: [
        { x: 15, y: 9, pressure: 0.5, time: 1 },
        { x: 41, y: 15, pressure: 0.5, time: 2 },
        { x: 27, y: 45, pressure: 0.5, time: 3 },
        { x: 15, y: 9, pressure: 0.5, time: 1 }
      ]
    });
  });

  it('builds a stable bounds region from selected annotations', () => {
    expect(
      selectionBoundsRegionFromAnnotations([
        {
          id: 'stroke-1',
          type: 'stroke',
          tool: 'pen',
          color: '#000',
          width: 4,
          points: [
            { x: 10, y: 20, pressure: 0.5, time: 1 },
            { x: 24, y: 36, pressure: 0.5, time: 2 }
          ]
        },
        {
          id: 'text-1',
          type: 'text',
          text: 'hello',
          color: '#000',
          x: 40,
          y: 18,
          width: 50,
          height: 22,
          fontSize: 18
        }
      ])
    ).toEqual({
      mode: 'rectangle',
      left: 4,
      top: 14,
      right: 90,
      bottom: 42
    });
  });
});
