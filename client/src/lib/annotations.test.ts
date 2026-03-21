import { describe, expect, it } from 'vitest';
import { eraseAnnotations, stabilizeStrokePoints } from './annotations';
import type { Annotation, PagePoint } from '@shared/contracts';

function point(x: number, y: number): PagePoint {
  return { x, y, pressure: 0.5, time: 0 };
}

function stroke(id: string, points: PagePoint[]): Annotation {
  return {
    id,
    type: 'stroke',
    tool: 'pen',
    color: '#111111',
    width: 2,
    points
  };
}

describe('eraseAnnotations', () => {
  it('keeps current whole-stroke behavior based on touched sample points', () => {
    const annotations = [stroke('stroke-1', [point(0, 0), point(10, 0), point(20, 0)])];

    const result = eraseAnnotations(annotations, [point(12, 0)], 1);

    expect(result).toEqual(annotations);

    const erased = eraseAnnotations(annotations, [point(10, 0)], 1);
    expect(erased).toEqual([]);
  });

  it('splits a stroke into surviving runs in partial mode', () => {
    const annotations = [stroke('stroke-1', [point(0, 0), point(10, 0), point(20, 0), point(30, 0)])];

    const result = eraseAnnotations(annotations, [point(15, 0)], 1, { strokeMode: 'partial' });

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      type: 'stroke',
      points: [point(0, 0), point(10, 0)]
    });
    expect(result[1]).toMatchObject({
      type: 'stroke',
      points: [point(20, 0), point(30, 0)]
    });
  });

  it('keeps whole-object erasing for text and shapes', () => {
    const annotations: Annotation[] = [
      {
        id: 'text-1',
        type: 'text',
        text: 'hello',
        color: '#111111',
        x: 10,
        y: 10,
        width: 40,
        height: 20,
        fontSize: 16
      },
      {
        id: 'shape-1',
        type: 'shape',
        shape: 'rectangle',
        color: '#111111',
        x: 60,
        y: 10,
        width: 30,
        height: 20,
        strokeWidth: 2,
        fill: false,
        lineStyle: 'solid'
      }
    ];

    const result = eraseAnnotations(annotations, [point(20, 20), point(65, 15)], 1, { strokeMode: 'partial' });

    expect(result).toEqual([]);
  });
});

describe('stabilizeStrokePoints', () => {
  it('returns original points when stabilization is zero', () => {
    const points = [point(0, 0), point(5, 5), point(10, 0)];

    expect(stabilizeStrokePoints(points, 0)).toEqual(points);
  });

  it('smooths interior points without dropping endpoints', () => {
    const points = [point(0, 0), point(5, 8), point(10, -6), point(15, 0)];

    const result = stabilizeStrokePoints(points, 80);

    expect(result[0]).toEqual(points[0]);
    expect(result[result.length - 1]).toEqual(points[points.length - 1]);
    expect(result[1].y).not.toEqual(points[1].y);
    expect(result[2].y).not.toEqual(points[2].y);
  });
});
