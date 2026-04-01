export type PencilSqueezeMenuSide = 'left' | 'right';

export interface PencilSqueezeMenuPlacement {
  left: number;
  top: number;
  side: PencilSqueezeMenuSide;
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

export function resolvePencilSqueezeMenuPlacement(
  options: ResolvePencilSqueezeMenuPlacementOptions
): PencilSqueezeMenuPlacement {
  const margin = options.margin ?? 16;
  const radialOffset = options.radialOffset ?? 18;
  const side: PencilSqueezeMenuSide = options.anchorX > options.rootWidth * 0.58 ? 'left' : 'right';
  const unclampedLeft =
    side === 'left' ? options.anchorX - options.menuWidth - radialOffset : options.anchorX + radialOffset;
  const unclampedTop = options.anchorY - options.menuHeight / 2;

  return {
    left: clamp(unclampedLeft, margin, Math.max(margin, options.rootWidth - options.menuWidth - margin)),
    top: clamp(unclampedTop, margin, Math.max(margin, options.rootHeight - options.menuHeight - margin)),
    side
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
