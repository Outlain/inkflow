import type { Annotation, PagePoint, StrokeAnnotation, TextAnnotation, ShapeAnnotation } from '@shared/contracts';
import { DEFAULT_STROKE_PRESET_SETTINGS, resolvePresetValue } from './strokeSettings';

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

export function eraseAnnotations(annotations: Annotation[], eraserPoints: PagePoint[], radius: number): Annotation[] {
  if (eraserPoints.length === 0) {
    return annotations;
  }

  const radiusSquared = radius * radius;

  return annotations.filter((annotation) => {
    if (annotation.type === 'stroke') {
      return !annotation.points.some((point) =>
        eraserPoints.some((eraserPoint) => {
          const dx = point.x - eraserPoint.x;
          const dy = point.y - eraserPoint.y;
          return dx * dx + dy * dy <= radiusSquared;
        })
      );
    }

    if (annotation.type === 'text') {
      return !eraserPoints.some((point) => point.x >= annotation.x && point.x <= annotation.x + annotation.width && point.y >= annotation.y && point.y <= annotation.y + annotation.height);
    }

    return !eraserPoints.some(
      (point) =>
        point.x >= annotation.x - radius &&
        point.x <= annotation.x + annotation.width + radius &&
        point.y >= annotation.y - radius &&
        point.y <= annotation.y + annotation.height + radius
    );
  });
}

export function toolStrokeWidth(sizePreset: number, highlighter = false): number {
  return resolvePresetValue(highlighter ? DEFAULT_STROKE_PRESET_SETTINGS.highlighter : DEFAULT_STROKE_PRESET_SETTINGS.pen, sizePreset);
}

export function eraserWidth(sizePreset: number): number {
  const widths = [10, 18, 28];
  return widths[Math.max(0, Math.min(widths.length - 1, sizePreset - 1))];
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
