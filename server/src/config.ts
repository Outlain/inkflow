import path from 'node:path';

function integerFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  host: process.env.HOST ?? '127.0.0.1',
  port: integerFromEnv(process.env.PORT, 3000),
  dataDir: process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data'),
  maxUploadBytes: integerFromEnv(process.env.MAX_UPLOAD_BYTES, 1024 * 1024 * 1024),
  pdfLinearizeThresholdBytes: integerFromEnv(process.env.PDF_LINEARIZE_THRESHOLD_BYTES, 24 * 1024 * 1024)
};

export const isProduction = config.nodeEnv === 'production';
