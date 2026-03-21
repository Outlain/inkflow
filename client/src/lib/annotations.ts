import type { Annotation, PagePoint, StrokeAnnotation, TextAnnotation, ShapeAnnotation } from '@shared/contracts';
import { DEFAULT_STROKE_PRESET_SETTINGS, resolvePresetValue, type EraserStrokeMode } from './strokeSettings';

export interface EraseAnnotationsOptions {
  strokeMode?: EraserStrokeMode;
}

export function annotationTextFromAnnotations(annotations: Annotation[]): string {
  return annotations
    .filter((annotation): annotation is TextAnnotation => annotation.type === 'text')
    .map((annotation) => annotation.text.trim())
    .filter(Boolean)
    .join('\n');
}

export function strokePath(points: PagePoint[], scale: number): string {
  if (points.length === 0) {
    return '';
  }

  const [first, ...rest] = points;
  return [`M ${first.x * scale} ${first.y * scale}`, ...rest.map((point) => `L ${point.x * scale} ${point.y * scale}`)].join(' ');
}

export function shapePath(annotation: ShapeAnnotation, scale: number): string {
  const x = annotation.x * scale;
  const y = annotation.y * scale;
  const width = annotation.width * scale;
  const height = annotation.height * scale;

  if (annotation.shape === 'triangle') {
    return `M ${x + width / 2} ${y} L ${x + width} ${y + height} L ${x} ${y + height} Z`;
  }

  if (annotation.shape === 'diamond') {
    return `M ${x + width / 2} ${y} L ${x + width} ${y + height / 2} L ${x + width / 2} ${y + height} L ${x} ${y + height / 2} Z`;
  }

  return '';
}

export function eraseAnnotations(
  annotations: Annotation[],
  eraserPoints: PagePoint[],
  radius: number,
  options: EraseAnnotationsOptions = {}
): Annotation[] {
  if (eraserPoints.length === 0) {
    return annotations;
  }

  const strokeMode = options.strokeMode ?? 'whole';
  const radiusSquared = radius * radius;

  return annotations.flatMap((annotation) => {
    if (annotation.type === 'stroke') {
      if (strokeMode === 'partial') {
        return eraseStrokeAnnotation(annotation, eraserPoints, radiusSquared);
      }

      return strokePointHit(annotation, eraserPoints, radiusSquared) ? [] : [annotation];
    }

    if (annotation.type === 'text') {
      return textHit(annotation, eraserPoints) ? [] : [annotation];
    }

    return shapeHit(annotation, eraserPoints, radius) ? [] : [annotation];
  });
}

function eraseStrokeAnnotation(annotation: StrokeAnnotation, eraserPoints: PagePoint[], radiusSquared: number): StrokeAnnotation[] {
  if (annotation.points.length === 0) {
    return [annotation];
  }

  const pointHits = annotation.points.map((point) => pointHit(point, eraserPoints, radiusSquared));
  const segmentHits = annotation.points.slice(0, -1).map((point, index) => segmentHit(point, annotation.points[index + 1], eraserPoints, Math.sqrt(radiusSquared)));

  if (!pointHits.some(Boolean) && !segmentHits.some(Boolean)) {
    return [annotation];
  }

  const survivingRuns: PagePoint[][] = [];
  let currentRun: PagePoint[] = [];

  for (let index = 0; index < annotation.points.length; index += 1) {
    if (pointHits[index]) {
      if (currentRun.length > 0) {
        survivingRuns.push(currentRun);
        currentRun = [];
      }
      continue;
    }

    currentRun.push(annotation.points[index]);

    if (index < segmentHits.length && segmentHits[index]) {
      survivingRuns.push(currentRun);
      currentRun = [];
    }
  }

  if (currentRun.length > 0) {
    survivingRuns.push(currentRun);
  }

  return survivingRuns.map((points, index) => ({
    ...annotation,
    id: survivingRuns.length === 1 ? annotation.id : `${annotation.id}:split:${index + 1}`,
    points: [...points]
  }));
}

function strokePointHit(annotation: StrokeAnnotation, eraserPoints: PagePoint[], radiusSquared: number): boolean {
  return annotation.points.some((point) => pointHit(point, eraserPoints, radiusSquared));
}

function pointHit(point: PagePoint, eraserPoints: PagePoint[], radiusSquared: number): boolean {
  return eraserPoints.some((eraserPoint) => distanceSquared(point, eraserPoint) <= radiusSquared);
}

function textHit(annotation: TextAnnotation, eraserPoints: PagePoint[]): boolean {
  return eraserPoints.some((point) => point.x >= annotation.x && point.x <= annotation.x + annotation.width && point.y >= annotation.y && point.y <= annotation.y + annotation.height);
}

function shapeHit(annotation: ShapeAnnotation, eraserPoints: PagePoint[], radius: number): boolean {
  return eraserPoints.some(
    (point) =>
      point.x >= annotation.x - radius &&
      point.x <= annotation.x + annotation.width + radius &&
      point.y >= annotation.y - radius &&
      point.y <= annotation.y + annotation.height + radius
  );
}

function segmentHit(start: PagePoint, end: PagePoint, eraserPoints: PagePoint[], radius: number): boolean {
  if (eraserPoints.length === 1) {
    return distanceSquaredPointToSegment(eraserPoints[0], start, end) <= radius * radius;
  }

  for (let index = 0; index < eraserPoints.length - 1; index += 1) {
    if (distanceSquaredBetweenSegments(start, end, eraserPoints[index], eraserPoints[index + 1]) <= radius * radius) {
      return true;
    }
  }

  return false;
}

function distanceSquaredBetweenSegments(a: PagePoint, b: PagePoint, c: PagePoint, d: PagePoint): number {
  if (segmentsIntersect(a, b, c, d)) {
    return 0;
  }

  return Math.min(
    distanceSquaredPointToSegment(a, c, d),
    distanceSquaredPointToSegment(b, c, d),
    distanceSquaredPointToSegment(c, a, b),
    distanceSquaredPointToSegment(d, a, b)
  );
}

function segmentsIntersect(a: PagePoint, b: PagePoint, c: PagePoint, d: PagePoint): boolean {
  const ab = orientation(a, b, c);
  const ac = orientation(a, b, d);
  const cd = orientation(c, d, a);
  const ce = orientation(c, d, b);

  if (ab === 0 && onSegment(a, c, b)) return true;
  if (ac === 0 && onSegment(a, d, b)) return true;
  if (cd === 0 && onSegment(c, a, d)) return true;
  if (ce === 0 && onSegment(c, b, d)) return true;

  return (ab > 0) !== (ac > 0) && (cd > 0) !== (ce > 0);
}

function orientation(a: PagePoint, b: PagePoint, c: PagePoint): number {
  const value = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  if (Math.abs(value) < 1e-9) {
    return 0;
  }

  return value > 0 ? 1 : -1;
}

function onSegment(a: PagePoint, b: PagePoint, c: PagePoint): boolean {
  return b.x >= Math.min(a.x, c.x) - 1e-9 && b.x <= Math.max(a.x, c.x) + 1e-9 && b.y >= Math.min(a.y, c.y) - 1e-9 && b.y <= Math.max(a.y, c.y) + 1e-9;
}

function distanceSquaredPointToSegment(point: PagePoint, start: PagePoint, end: PagePoint): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;

  if (dx === 0 && dy === 0) {
    return distanceSquared(point, start);
  }

  const t = ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy);
  const clampedT = Math.max(0, Math.min(1, t));
  const projection = {
    x: start.x + clampedT * dx,
    y: start.y + clampedT * dy,
    pressure: 0,
    time: 0
  };

  return distanceSquared(point, projection);
}

function distanceSquared(a: PagePoint, b: PagePoint): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function toolStrokeWidth(sizePreset: number, highlighter = false): number {
  return resolvePresetValue(highlighter ? DEFAULT_STROKE_PRESET_SETTINGS.highlighter : DEFAULT_STROKE_PRESET_SETTINGS.pen, sizePreset);
}

export function createStroke(params: {
  id: string;
  tool: 'pen' | 'highlighter';
  color: string;
  width: number;
  points: PagePoint[];
}): StrokeAnnotation {
  return {
    id: params.id,
    type: 'stroke',
    tool: params.tool,
    color: params.color,
    width: params.width,
    points: params.points
  };
}
