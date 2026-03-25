/**
 * Pen/pencil/highlighter/eraser preset widths, size bounds, and stabilization
 * settings. Persisted to localStorage so user customizations survive reloads.
 */

export type AdjustableStrokeTool = 'pen' | 'pencil' | 'highlighter' | 'eraser';
export type EraserStrokeMode = 'whole' | 'partial';

export type StrokePresetValues = [number, number, number];

export interface StrokePresetSettings {
  pen: StrokePresetValues;
  pencil: StrokePresetValues;
  highlighter: StrokePresetValues;
  eraser: StrokePresetValues;
}

export interface StrokeBounds {
  min: number;
  max: number;
  step: number;
}

const STORAGE_KEY = 'inkflowStrokePresetSettings.v1';
const ERASER_MODE_STORAGE_KEY = 'inkflowEraserStrokeMode.v1';
const STROKE_STABILIZATION_STORAGE_KEY = 'inkflowStrokeStabilization.v1';
const DEFAULT_STROKE_STABILIZATION = 30;

export const DEFAULT_STROKE_PRESET_SETTINGS: StrokePresetSettings = {
  pen: [2, 4, 7],
  pencil: [1.4, 2.4, 4.2],
  highlighter: [10, 18, 26],
  eraser: [10, 18, 28]
};

export const STROKE_BOUNDS: Record<AdjustableStrokeTool, StrokeBounds> = {
  pen: { min: 1, max: 12, step: 0.1 },
  pencil: { min: 0.8, max: 8, step: 0.1 },
  highlighter: { min: 6, max: 32, step: 0.5 },
  eraser: { min: 6, max: 42, step: 1 }
};

export function cloneStrokePresetSettings(source = DEFAULT_STROKE_PRESET_SETTINGS): StrokePresetSettings {
  return {
    pen: [...source.pen] as StrokePresetValues,
    pencil: [...source.pencil] as StrokePresetValues,
    highlighter: [...source.highlighter] as StrokePresetValues,
    eraser: [...source.eraser] as StrokePresetValues
  };
}

export function resolvePresetValue(values: readonly number[], sizePreset: number): number {
  const index = Math.max(0, Math.min(values.length - 1, sizePreset - 1));
  return values[index];
}

export function toolStrokeWidthFromSettings(
  settings: StrokePresetSettings,
  tool: AdjustableStrokeTool,
  sizePreset: number
): number {
  return resolvePresetValue(settings[tool], sizePreset);
}

export function loadStrokePresetSettings(): StrokePresetSettings {
  if (typeof window === 'undefined') {
    return cloneStrokePresetSettings();
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return cloneStrokePresetSettings();
    }

    const parsed = JSON.parse(raw) as Partial<Record<AdjustableStrokeTool, unknown>>;
    return {
      pen: normalizeToolValues('pen', parsed.pen),
      pencil: normalizeToolValues('pencil', parsed.pencil),
      highlighter: normalizeToolValues('highlighter', parsed.highlighter),
      eraser: normalizeToolValues('eraser', parsed.eraser)
    };
  } catch {
    return cloneStrokePresetSettings();
  }
}

export function saveStrokePresetSettings(settings: StrokePresetSettings): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage failures so drawing never depends on persistence.
  }
}

export function loadEraserStrokeMode(): EraserStrokeMode {
  if (typeof window === 'undefined') {
    return 'whole';
  }

  try {
    const raw = window.localStorage.getItem(ERASER_MODE_STORAGE_KEY);
    return raw === 'partial' ? 'partial' : 'whole';
  } catch {
    return 'whole';
  }
}

export function saveEraserStrokeMode(mode: EraserStrokeMode): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(ERASER_MODE_STORAGE_KEY, mode);
  } catch {
    // Ignore storage failures so interaction never depends on persistence.
  }
}

export function defaultStrokeStabilization(): number {
  return DEFAULT_STROKE_STABILIZATION;
}

export function clampStrokeStabilization(value: number): number {
  const next = Number.isFinite(value) ? value : DEFAULT_STROKE_STABILIZATION;
  return Math.max(0, Math.min(100, Math.round(next)));
}

export function loadStrokeStabilization(): number {
  if (typeof window === 'undefined') {
    return DEFAULT_STROKE_STABILIZATION;
  }

  try {
    const raw = window.localStorage.getItem(STROKE_STABILIZATION_STORAGE_KEY);
    if (raw === null) {
      return DEFAULT_STROKE_STABILIZATION;
    }

    return clampStrokeStabilization(Number.parseFloat(raw));
  } catch {
    return DEFAULT_STROKE_STABILIZATION;
  }
}

export function saveStrokeStabilization(value: number): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(STROKE_STABILIZATION_STORAGE_KEY, String(clampStrokeStabilization(value)));
  } catch {
    // Ignore storage failures so interaction never depends on persistence.
  }
}

export function updateStrokePresetWidth(
  settings: StrokePresetSettings,
  tool: AdjustableStrokeTool,
  sizePreset: number,
  value: number
): StrokePresetSettings {
  const next = cloneStrokePresetSettings(settings);
  const index = Math.max(0, Math.min(2, sizePreset - 1));
  next[tool][index] = clampStrokeWidth(tool, value);
  return next;
}

export function resetStrokePresetWidth(
  settings: StrokePresetSettings,
  tool: AdjustableStrokeTool,
  sizePreset: number
): StrokePresetSettings {
  const next = cloneStrokePresetSettings(settings);
  const index = Math.max(0, Math.min(2, sizePreset - 1));
  next[tool][index] = DEFAULT_STROKE_PRESET_SETTINGS[tool][index];
  return next;
}

export function strokePresetIndicatorSize(
  settings: StrokePresetSettings,
  tool: AdjustableStrokeTool | null,
  sizePreset: number
): number {
  if (!tool) {
    return [8, 12, 16][Math.max(0, Math.min(2, sizePreset - 1))];
  }

  const bounds = STROKE_BOUNDS[tool];
  const value = toolStrokeWidthFromSettings(settings, tool, sizePreset);
  const span = Math.max(0.001, bounds.max - bounds.min);
  const ratio = (value - bounds.min) / span;
  return Math.round(8 + Math.min(1, Math.max(0, ratio)) * 10);
}

export function formatStrokeWidth(value: number): string {
  if (value >= 10) {
    return `${value.toFixed(0)} pt`;
  }

  return `${value.toFixed(1)} pt`;
}

function normalizeToolValues(tool: AdjustableStrokeTool, candidate: unknown): StrokePresetValues {
  const defaults = DEFAULT_STROKE_PRESET_SETTINGS[tool];
  if (!Array.isArray(candidate) || candidate.length !== 3) {
    return [...defaults] as StrokePresetValues;
  }

  return candidate.map((value, index) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return defaults[index];
    }

    return clampStrokeWidth(tool, value);
  }) as StrokePresetValues;
}

function clampStrokeWidth(tool: AdjustableStrokeTool, value: number): number {
  const bounds = STROKE_BOUNDS[tool];
  const next = Math.min(bounds.max, Math.max(bounds.min, value));
  const precision = bounds.step < 1 ? 10 : 2;
  return Math.round(next * precision) / precision;
}
