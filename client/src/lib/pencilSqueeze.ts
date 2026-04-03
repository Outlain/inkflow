export type PencilSqueezeMenuSide = 'left' | 'right';

export interface PencilSqueezeMenuPlacement {
  left: number;
  top: number;
  side: PencilSqueezeMenuSide;
}

export interface PencilSqueezeArcToolLayout {
  left: number;
  top: number;
  size: number;
}

export interface ResolvePencilSqueezeMenuPlacementOptions {
  anchorX: number;
  anchorY: number;
  rootWidth: number;
  rootHeight: number;
  menuWidth: number;
  menuHeight: number;
  margin?: number;
  radialOffset?: number;
}

export interface ResolvePencilSqueezeArcToolLayoutOptions {
  index: number;
  total: number;
  side: PencilSqueezeMenuSide;
  shellWidth: number;
  buttonSize?: number;
}

export interface ResolvePencilSqueezeArcContentHeightOptions {
  total: number;
  buttonSize?: number;
  padding?: number;
}

/* Polar-arc geometry for the GoodNotes-style curved tool band. */
const ARC_RADIUS = 135;
const ARC_CX = 162;
const ARC_CY = 170;
const ARC_START_DEG = 248;
const ARC_END_DEG = 88;

export function resolvePencilSqueezeMenuPlacement(
  options: ResolvePencilSqueezeMenuPlacementOptions
): PencilSqueezeMenuPlacement {
  const margin = options.margin ?? 16;
  const radialOffset = options.radialOffset ?? -80;
  const canFitLeft = options.anchorX - options.menuWidth - radialOffset >= margin;
  const side: PencilSqueezeMenuSide = canFitLeft ? 'left' : 'right';
  const unclampedLeft =
    side === 'left' ? options.anchorX - options.menuWidth - radialOffset : options.anchorX + radialOffset;
  const unclampedTop = options.anchorY - options.menuHeight * 0.30;

  return {
    left: clamp(unclampedLeft, margin, Math.max(margin, options.rootWidth - options.menuWidth - margin)),
    top: clamp(unclampedTop, margin, Math.max(margin, options.rootHeight - options.menuHeight - margin)),
    side
  };
}

export function resolvePencilSqueezeArcToolLayout(
  options: ResolvePencilSqueezeArcToolLayoutOptions
): PencilSqueezeArcToolLayout {
  const buttonSize = options.buttonSize ?? 48;
  const total = Math.max(1, options.total);
  const progress = total === 1 ? 0.5 : options.index / (total - 1);

  const angleDeg = ARC_END_DEG + progress * (ARC_START_DEG - ARC_END_DEG);
  const angleRad = (angleDeg * Math.PI) / 180;

  const centerX = ARC_CX + ARC_RADIUS * Math.cos(angleRad);
  const centerY = ARC_CY - ARC_RADIUS * Math.sin(angleRad);

  const rawLeft =
    options.side === 'left'
      ? centerX - buttonSize / 2
      : options.shellWidth - centerX - buttonSize / 2;
  const rawTop = centerY - buttonSize / 2;

  return {
    left: clamp(rawLeft, 0, Math.max(0, options.shellWidth - buttonSize)),
    top: Math.max(0, rawTop),
    size: buttonSize
  };
}

export function resolvePencilSqueezeArcContentHeight(
  options: ResolvePencilSqueezeArcContentHeightOptions
): number {
  const buttonSize = options.buttonSize ?? 48;
  const padding = options.padding ?? 8;

  const startRad = (ARC_START_DEG * Math.PI) / 180;
  const endRad = (ARC_END_DEG * Math.PI) / 180;

  const y0 = ARC_CY - ARC_RADIUS * Math.sin(startRad);
  const y1 = ARC_CY - ARC_RADIUS * Math.sin(endRad);

  return Math.ceil(Math.max(y0, y1) + buttonSize / 2 + padding);
}

export function resolvePencilSqueezeArcDividers(total: number): string[] {
  const halfBand = 29;
  const innerR = ARC_RADIUS - halfBand;
  const outerR = ARC_RADIUS + halfBand;
  const lines: string[] = [];

  for (let i = 0; i < total - 1; i++) {
    const progress = (i + 0.5) / (total - 1);
    const angleDeg = ARC_END_DEG + progress * (ARC_START_DEG - ARC_END_DEG);
    const rad = (angleDeg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);

    const x1 = ARC_CX + innerR * cos;
    const y1 = ARC_CY - innerR * sin;
    const x2 = ARC_CX + outerR * cos;
    const y2 = ARC_CY - outerR * sin;

    lines.push(`M ${x1.toFixed(1)} ${y1.toFixed(1)} L ${x2.toFixed(1)} ${y2.toFixed(1)}`);
  }

  return lines;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
