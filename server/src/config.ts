/** Server configuration from environment variables with sensible defaults. */

import path from 'node:path';

function integerFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function radiusFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function previewRadiusFromEnv(value: string | undefined, fallback: number | 'all'): number | 'all' {
  if (value === 'all') {
    return 'all';
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  host: process.env.HOST ?? '0.0.0.0',
  port: integerFromEnv(process.env.PORT, 3000),
  dataDir: process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data'),
  maxUploadBytes: integerFromEnv(process.env.MAX_UPLOAD_BYTES, 1024 * 1024 * 1024),
  pdfLinearizeThresholdBytes: integerFromEnv(process.env.PDF_LINEARIZE_THRESHOLD_BYTES, 24 * 1024 * 1024),
  defaultUser: process.env.INKFLOW_DEFAULT_USER ?? null,
  publicClientConfig: {
    renderCacheDesktopPixels: integerFromEnv(process.env.INKFLOW_RENDER_CACHE_DESKTOP_PIXELS, 100_000_000),
    renderCacheTouchPixels: integerFromEnv(process.env.INKFLOW_RENDER_CACHE_TOUCH_PIXELS, 50_000_000),
    prefetchRadiusFast: radiusFromEnv(process.env.INKFLOW_PREFETCH_RADIUS_FAST, 4),
    prefetchRadiusMedium: radiusFromEnv(process.env.INKFLOW_PREFETCH_RADIUS_MEDIUM, 1),
    prefetchRadiusSlow: radiusFromEnv(process.env.INKFLOW_PREFETCH_RADIUS_SLOW, 0),
    previewRadiusFast: previewRadiusFromEnv(process.env.INKFLOW_PREVIEW_RADIUS_FAST, 'all'),
    previewRadiusMedium: previewRadiusFromEnv(process.env.INKFLOW_PREVIEW_RADIUS_MEDIUM, 2),
    previewRadiusSlow: previewRadiusFromEnv(process.env.INKFLOW_PREVIEW_RADIUS_SLOW, 1)
  }
};

export const isProduction = config.nodeEnv === 'production';
