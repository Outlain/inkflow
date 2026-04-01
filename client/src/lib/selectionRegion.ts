import type { PageAnnotation, PagePoint, TapeAnnotation } from '@shared/contracts';

export type SelectionRegion =
  | { mode: 'rectangle'; left: number; top: number; right: number; bottom: number }
  | { mode: 'freehand'; polygon: PagePoint[] };

function closePolygon(points: PagePoint[]): PagePoint[] {
  if (points.length < 2) {
    return points;
  }

  const first = points[0];
  const last = points[points.length - 1];
  if (first.x === last.x && first.y === last.y) {
    return points;
  }

  return [...points, { ...first }];
}

export function selectionRegionFromLassoPoints(
  points: PagePoint[],
  mode: 'rectangle' | 'freehand'
): SelectionRegion | null {
  if (points.length === 0) {
    return null;
  }

  if (mode === 'freehand' && points.length > 2) {
    return {
      mode: 'freehand',
      polygon: closePolygon(points)
    };
  }

  const first = points[0];
  const last = points[points.length - 1];
  return {
    mode: 'rectangle',
    left: Math.min(first.x, last.x),
    top: Math.min(first.y, last.y),
    right: Math.max(first.x, last.x),
    bottom: Math.max(first.y, last.y)
  };
}

export function translateSelectionRegion(region: SelectionRegion, dx: number, dy: number): SelectionRegion {
  if (region.mode === 'rectangle') {
    return {
      mode: 'rectangle',
      left: region.left + dx,
      top: region.top + dy,
      right: region.right + dx,
      bottom: region.bottom + dy
    };
  }

  return {
    mode: 'freehand',
    polygon: region.polygon.map((point) => ({
      ...point,
      x: point.x + dx,
      y: point.y + dy
    }))
  };
}

function tapeCorners(tape: TapeAnnotation): PagePoint[] {
  const dx = tape.x2 - tape.x1;
  const dy = tape.y2 - tape.y1;
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length < 0.001) {
    return [];
  }

  const nx = (-dy / length) * (tape.tapeWidth / 2);
  const ny = (dx / length) * (tape.tapeWidth / 2);
  return [
    { x: tape.x1 + nx, y: tape.y1 + ny, pressure: 0, time: 0 },
    { x: tape.x2 + nx, y: tape.y2 + ny, pressure: 0, time: 0 },
    { x: tape.x2 - nx, y: tape.y2 - ny, pressure: 0, time: 0 },
    { x: tape.x1 - nx, y: tape.y1 - ny, pressure: 0, time: 0 }
  ];
}

function annotationBounds(annotation: PageAnnotation): { left: number; top: number; right: number; bottom: number } {
  if (annotation.type === 'stroke') {
    const xs = annotation.points.map((point) => point.x);
    const ys = annotation.points.map((point) => point.y);
    const padding = Math.max(6, annotation.width);
    return {
      left: Math.min(...xs) - padding,
      top: Math.min(...ys) - padding,
      right: Math.max(...xs) + padding,
      bottom: Math.max(...ys) + padding
    };
  }

  if (annotation.type === 'tape') {
    const corners = tapeCorners(annotation);
    if (corners.length === 0) {
      return { left: annotation.x1, top: annotation.y1, right: annotation.x1, bottom: annotation.y1 };
    }
    const xs = corners.map((corner) => corner.x);
    const ys = corners.map((corner) => corner.y);
    return {
      left: Math.min(...xs),
      top: Math.min(...ys),
      right: Math.max(...xs),
      bottom: Math.max(...ys)
    };
  }

  return {
    left: annotation.x,
    top: annotation.y,
    right: annotation.x + annotation.width,
    bottom: annotation.y + annotation.height
  };
}

export function selectionBoundsRegionFromAnnotations(annotations: PageAnnotation[]): SelectionRegion | null {
  if (annotations.length === 0) {
    return null;
  }

  const bounds = annotations.reduce(
    (region, annotation) => {
      const nextBounds = annotationBounds(annotation);
      return {
        left: Math.min(region.left, nextBounds.left),
        top: Math.min(region.top, nextBounds.top),
        right: Math.max(region.right, nextBounds.right),
        bottom: Math.max(region.bottom, nextBounds.bottom)
      };
    },
    {
      left: Number.POSITIVE_INFINITY,
      top: Number.POSITIVE_INFINITY,
      right: Number.NEGATIVE_INFINITY,
      bottom: Number.NEGATIVE_INFINITY
    }
  );

  return {
    mode: 'rectangle',
    left: bounds.left,
    top: bounds.top,
    right: bounds.right,
    bottom: bounds.bottom
  };
}
