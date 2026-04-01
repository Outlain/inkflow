import type { PageAnnotation, PagePoint, TapeAnnotation } from '@shared/contracts';
import type { PageShellLayout } from './reader/layout';

export interface AnnotationPagePlacement {
  annotation: PageAnnotation;
  pageId: string;
}

function moveAnnotation(annotation: PageAnnotation, dx: number, dy: number): PageAnnotation {
  if (annotation.type === 'stroke') {
    return {
      ...annotation,
      points: annotation.points.map((point) => ({
        ...point,
        x: point.x + dx,
        y: point.y + dy
      }))
    };
  }

  if (annotation.type === 'tape') {
    return {
      ...annotation,
      x1: annotation.x1 + dx,
      y1: annotation.y1 + dy,
      x2: annotation.x2 + dx,
      y2: annotation.y2 + dy
    };
  }

  return {
    ...annotation,
    x: annotation.x + dx,
    y: annotation.y + dy
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

function localPointToDocument(point: PagePoint, layout: PageShellLayout): PagePoint {
  return {
    x: layout.left + point.x * layout.scale,
    y: layout.top + point.y * layout.scale,
    pressure: point.pressure,
    time: point.time
  };
}

function documentPointToLocal(point: PagePoint, layout: PageShellLayout): PagePoint {
  return {
    x: (point.x - layout.left) / layout.scale,
    y: (point.y - layout.top) / layout.scale,
    pressure: point.pressure,
    time: point.time
  };
}

function translateAnnotationBetweenPageLayouts(
  annotation: PageAnnotation,
  sourceLayout: PageShellLayout,
  targetLayout: PageShellLayout
): PageAnnotation {
  if (sourceLayout.page.id === targetLayout.page.id) {
    return annotation;
  }

  if (annotation.type === 'stroke') {
    return {
      ...annotation,
      points: annotation.points.map((point) => documentPointToLocal(localPointToDocument(point, sourceLayout), targetLayout))
    };
  }

  if (annotation.type === 'tape') {
    const start = documentPointToLocal(localPointToDocument({ x: annotation.x1, y: annotation.y1, pressure: 0, time: 0 }, sourceLayout), targetLayout);
    const end = documentPointToLocal(localPointToDocument({ x: annotation.x2, y: annotation.y2, pressure: 0, time: 0 }, sourceLayout), targetLayout);
    return {
      ...annotation,
      x1: start.x,
      y1: start.y,
      x2: end.x,
      y2: end.y
    };
  }

  const topLeft = documentPointToLocal(localPointToDocument({ x: annotation.x, y: annotation.y, pressure: 0, time: 0 }, sourceLayout), targetLayout);
  return {
    ...annotation,
    x: topLeft.x,
    y: topLeft.y
  };
}

function annotationDocumentCenter(annotation: PageAnnotation, sourceLayout: PageShellLayout): PagePoint {
  const bounds = annotationBounds(annotation);
  return localPointToDocument(
    {
      x: (bounds.left + bounds.right) / 2,
      y: (bounds.top + bounds.bottom) / 2,
      pressure: 0,
      time: 0
    },
    sourceLayout
  );
}

function distanceSquaredToPage(point: PagePoint, layout: PageShellLayout): number {
  const dx =
    point.x < layout.left
      ? layout.left - point.x
      : point.x > layout.left + layout.width
        ? point.x - (layout.left + layout.width)
        : 0;
  const dy =
    point.y < layout.top
      ? layout.top - point.y
      : point.y > layout.top + layout.height
        ? point.y - (layout.top + layout.height)
        : 0;
  return dx * dx + dy * dy;
}

function closestPageLayout(point: PagePoint, pageLayouts: PageShellLayout[]): PageShellLayout | null {
  if (pageLayouts.length === 0) {
    return null;
  }

  let best = pageLayouts[0];
  let bestDistance = distanceSquaredToPage(point, best);
  for (let index = 1; index < pageLayouts.length; index += 1) {
    const candidate = pageLayouts[index];
    const distance = distanceSquaredToPage(point, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return best;
}

function sourceLayoutIndex(sourceLayout: PageShellLayout, pageLayouts: PageShellLayout[]): number {
  const byId = pageLayouts.findIndex((layout) => layout.page.id === sourceLayout.page.id);
  if (byId >= 0) {
    return byId;
  }

  return Math.max(0, Math.min(pageLayouts.length - 1, sourceLayout.pageIndex));
}

function resolveDropTargetLayout(targetPoint: PagePoint, sourceLayout: PageShellLayout, pageLayouts: PageShellLayout[]): PageShellLayout | null {
  if (pageLayouts.length === 0) {
    return null;
  }

  let current = pageLayouts[sourceLayoutIndex(sourceLayout, pageLayouts)] ?? sourceLayout;
  while (targetPoint.y < current.top && current.pageIndex > 0) {
    current = pageLayouts[current.pageIndex - 1] ?? current;
  }

  while (targetPoint.y > current.top + current.height && current.pageIndex < pageLayouts.length - 1) {
    current = pageLayouts[current.pageIndex + 1] ?? current;
  }

  return current;
}

function clampAnnotationsToPage(annotations: PageAnnotation[], layout: PageShellLayout): PageAnnotation[] {
  if (annotations.length === 0) {
    return annotations;
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

  let dx = 0;
  let dy = 0;
  if (bounds.right - bounds.left <= layout.page.width) {
    if (bounds.left < 0) {
      dx = -bounds.left;
    } else if (bounds.right > layout.page.width) {
      dx = layout.page.width - bounds.right;
    }
  }

  if (bounds.bottom - bounds.top <= layout.page.height) {
    if (bounds.top < 0) {
      dy = -bounds.top;
    } else if (bounds.bottom > layout.page.height) {
      dy = layout.page.height - bounds.bottom;
    }
  }

  if (dx === 0 && dy === 0) {
    return annotations;
  }

  return annotations.map((annotation) => moveAnnotation(annotation, dx, dy));
}

export function placeAnnotationsAcrossPages(params: {
  annotations: PageAnnotation[];
  sourceLayout: PageShellLayout;
  pageLayouts: PageShellLayout[];
  targetPoint?: PagePoint;
}): AnnotationPagePlacement[] {
  const { annotations, sourceLayout, pageLayouts, targetPoint } = params;

  if (targetPoint) {
    const targetLayout = resolveDropTargetLayout(targetPoint, sourceLayout, pageLayouts) ?? sourceLayout;
    const translated = annotations.map((annotation) => translateAnnotationBetweenPageLayouts(annotation, sourceLayout, targetLayout));
    const clamped = clampAnnotationsToPage(translated, targetLayout);
    return clamped.map((annotation) => ({
      pageId: targetLayout.page.id,
      annotation
    }));
  }

  return annotations.map((annotation) => {
    const targetLayout = closestPageLayout(annotationDocumentCenter(annotation, sourceLayout), pageLayouts) ?? sourceLayout;
    return {
      pageId: targetLayout.page.id,
      annotation: translateAnnotationBetweenPageLayouts(annotation, sourceLayout, targetLayout)
    };
  });
}
