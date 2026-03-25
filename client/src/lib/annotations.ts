/**
 * Annotation helpers — stroke creation, SVG path generation, stabilization,
 * and eraser hit-testing (whole-stroke and partial/split erasure).
 */

import type { PageAnnotation, PagePoint, StrokeAnnotation, TextAnnotation, StickyNoteAnnotation, ShapeAnnotation } from '@shared/contracts';
import { DEFAULT_STROKE_PRESET_SETTINGS, resolvePresetValue, type EraserStrokeMode } from './strokeSettings';

export interface EraseAnnotationsOptions {
  strokeMode?: EraserStrokeMode;
}

/** Extract plain text content from text and sticky note annotations. */
export function annotationTextFromAnnotations(annotations: PageAnnotation[]): string {
  return annotations
    .filter((annotation): annotation is TextAnnotation | StickyNoteAnnotation => annotation.type === 'text' || annotation.type === 'sticky')
    .map((annotation) => annotation.text.trim())
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------
// SVG path generation
// ---------------------------------------------------------------------------

export function strokePath(points: PagePoint[], scale: number): string {
  if (points.length === 0) {
    return '';
  }

  const [first, ...rest] = points;
  return [`M ${first.x * scale} ${first.y * scale}`, ...rest.map((point) => `L ${point.x * scale} ${point.y * scale}`)].join(' ');
}

/** Build an SVG path string for triangle or diamond shape annotations. */
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

// ---------------------------------------------------------------------------
// Erasure — hit testing and stroke splitting
// ---------------------------------------------------------------------------

export function eraseAnnotations(
  annotations: PageAnnotation[],
  eraserPoints: PagePoint[],
  radius: number,
  options: EraseAnnotationsOptions = {}
): PageAnnotation[] {
  if (eraserPoints.length === 0) {
    return annotations;
  }

  const strokeMode = options.strokeMode ?? 'whole';
  const radiusSquared = radius * radius;

  return annotations.flatMap((annotation): PageAnnotation[] => {
    if (annotation.type === 'stroke') {
      if (strokeMode === 'partial') {
        return eraseStrokeAnnotation(annotation, eraserPoints, radiusSquared);
      }

      return strokePointHit(annotation, eraserPoints, radiusSquared) ? [] : [annotation];
    }

    if (annotation.type === 'text' || annotation.type === 'sticky') {
      return textHit(annotation, eraserPoints) ? [] : [annotation];
    }

    return shapeHit(annotation, eraserPoints, radius) ? [] : [annotation];
  });
}

/**
 * Partial erasure: remove hit points from a stroke and split the remaining
 * points into contiguous runs, each becoming a new stroke fragment.
 */
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

function textHit(annotation: TextAnnotation | StickyNoteAnnotation, eraserPoints: PagePoint[]): boolean {
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

/** Check if any eraser path segment comes within radius of a stroke segment. */
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

// ---------------------------------------------------------------------------
// Computational geometry — segment-segment and point-segment distance
// ---------------------------------------------------------------------------

/** Minimum squared distance between two line segments AB and CD. */
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

/** Test whether segments AB and CD intersect using cross-product orientation. */
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

/** Orientation of the triplet (a, b, c): 0 = collinear, 1 = clockwise, -1 = counter-clockwise. */
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

/** Squared distance from a point to the nearest point on segment start--end. */
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

// ---------------------------------------------------------------------------
// Stroke creation and stabilization
// ---------------------------------------------------------------------------

export function toolStrokeWidth(sizePreset: number, highlighter = false): number {
  return resolvePresetValue(highlighter ? DEFAULT_STROKE_PRESET_SETTINGS.highlighter : DEFAULT_STROKE_PRESET_SETTINGS.pen, sizePreset);
}

/**
 * Smooth a pen/highlighter stroke using weighted-average passes.
 * Higher stabilization values increase the smoothing radius, blend factor,
 * number of passes, and tail trimming aggressiveness.
 */
export function stabilizeStrokePoints(points: PagePoint[], stabilization: number): PagePoint[] {
  const amount = Math.max(0, Math.min(100, stabilization));
  if (amount <= 0 || points.length < 3) {
    return points.map((point) => ({ ...point }));
  }

  const radius = amount < 20 ? 1 : amount < 45 ? 2 : amount < 70 ? 3 : 4;
  const blend = Math.min(0.92, amount / 100);
  let smoothed = points.map((point) => ({ ...point }));

  const passes = amount < 35 ? 1 : amount < 70 ? 2 : 3;
  for (let pass = 0; pass < passes; pass += 1) {
    smoothed = smoothStrokePass(smoothed, radius, blend);
  }

  return trimStrokeTails(smoothed, amount);
}

/** Lighter stabilization variant for pencil strokes — preserves more texture. */
export function stabilizePencilStrokePoints(points: PagePoint[], stabilization: number): PagePoint[] {
  const amount = Math.max(0, Math.min(100, stabilization));
  if (amount <= 0 || points.length < 3) {
    return points.map((point) => ({ ...point }));
  }

  const radius = amount < 35 ? 1 : amount < 70 ? 2 : 3;
  const blend = Math.min(0.5, 0.14 + amount / 320);
  let smoothed = points.map((point) => ({ ...point }));
  const passes = amount < 55 ? 1 : 2;

  for (let pass = 0; pass < passes; pass += 1) {
    smoothed = smoothStrokePass(smoothed, radius, blend * (pass === 0 ? 1 : 0.82));
  }

  return trimStrokeTails(smoothed, Math.max(0, amount - 12));
}

export function createStroke(params: {
  id: string;
  tool: 'pen' | 'pencil' | 'highlighter';
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

/** Single weighted-average smoothing pass over interior points (endpoints preserved). */
function smoothStrokePass(points: PagePoint[], radius: number, blend: number): PagePoint[] {
  const lastIndex = points.length - 1;
  const next = points.map((point) => ({ ...point }));

  for (let index = 1; index < lastIndex; index += 1) {
    const start = Math.max(0, index - radius);
    const end = Math.min(lastIndex, index + radius);
    let totalWeight = 0;
    let weightedX = 0;
    let weightedY = 0;
    let weightedPressure = 0;

    for (let neighbor = start; neighbor <= end; neighbor += 1) {
      const distance = Math.abs(neighbor - index);
      const weight = radius - distance + 1;
      totalWeight += weight;
      weightedX += points[neighbor].x * weight;
      weightedY += points[neighbor].y * weight;
      weightedPressure += points[neighbor].pressure * weight;
    }

    const averageX = weightedX / totalWeight;
    const averageY = weightedY / totalWeight;
    const averagePressure = weightedPressure / totalWeight;
    const edgeBlend = index === 1 || index === lastIndex - 1 ? blend * 0.55 : blend;
    next[index] = {
      ...points[index],
      x: points[index].x + (averageX - points[index].x) * edgeBlend,
      y: points[index].y + (averageY - points[index].y) * edgeBlend,
      pressure: points[index].pressure + (averagePressure - points[index].pressure) * edgeBlend
    };
  }

  return next;
}

/**
 * Remove sharp "hook" artifacts at stroke endpoints caused by pen lift-off.
 * Detects when the final segment reverses direction sharply and is short
 * relative to the preceding segment, then drops that point.
 */
function trimStrokeTails(points: PagePoint[], stabilization: number): PagePoint[] {
  if (points.length < 4 || stabilization < 25) {
    return points;
  }

  let next = points.map((point) => ({ ...point }));
  next = trimSingleTail(next, 'end', stabilization);
  next = trimSingleTail(next, 'start', stabilization);
  return next;
}

function trimSingleTail(points: PagePoint[], edge: 'start' | 'end', stabilization: number): PagePoint[] {
  if (points.length < 4) {
    return points;
  }

  const ordered = edge === 'end' ? points : [...points].reverse();
  const first = ordered[0];
  const second = ordered[1];
  const third = ordered[2];

  const firstLength = Math.hypot(first.x - second.x, first.y - second.y);
  const secondLength = Math.hypot(second.x - third.x, second.y - third.y);
  if (firstLength === 0 || secondLength === 0) {
    return points;
  }

  const dot = (second.x - third.x) * (first.x - second.x) + (second.y - third.y) * (first.y - second.y);
  const cosine = dot / (firstLength * secondLength);
  const sharpReverse = cosine < -0.2;
  const smallTail = firstLength <= Math.max(1.2, secondLength * (0.55 - Math.min(0.2, stabilization / 500)));

  if (!sharpReverse || !smallTail) {
    return points;
  }

  if (edge === 'end') {
    return points.slice(0, -1);
  }

  return points.slice(1);
}
