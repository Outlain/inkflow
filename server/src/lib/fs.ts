/**
 * Filesystem layout helpers — resolves and ensures the data directory structure
 * under the single persistent mount at /app/data (or DATA_DIR override).
 */

import fs from 'node:fs';
import path from 'node:path';

/** All resolved paths within the data directory. */
export interface DataPaths {
  root: string;
  database: string;
  uploads: string;
  temp: string;
  previews: string;
  exports: string;
  logs: string;
}

export function resolveDataPaths(root: string): DataPaths {
  return {
    root,
    database: path.join(root, 'inkflow.db'),
    uploads: path.join(root, 'uploads'),
    temp: path.join(root, 'temp'),
    previews: path.join(root, 'previews'),
    exports: path.join(root, 'exports'),
    logs: path.join(root, 'logs')
  };
}

/** Creates all data subdirectories if they don't exist. */
export function ensureDataLayout(root: string): DataPaths {
  const paths = resolveDataPaths(root);
  fs.mkdirSync(paths.root, { recursive: true });
  fs.mkdirSync(paths.uploads, { recursive: true });
  fs.mkdirSync(paths.temp, { recursive: true });
  fs.mkdirSync(paths.previews, { recursive: true });
  fs.mkdirSync(paths.exports, { recursive: true });
  fs.mkdirSync(paths.logs, { recursive: true });
  return paths;
}

export function getUploadPath(root: string, storageKey: string): string {
  return path.join(resolveDataPaths(root).uploads, storageKey);
}

/** Directory for a specific PDF's preview images and per-page extracts. */
export function getPreviewDirectory(root: string, storageKey: string): string {
  return path.join(resolveDataPaths(root).previews, storageKey.replace(/\.pdf$/i, ''));
}

export function getPreviewPath(root: string, storageKey: string, pageNumber: number, width: number): string {
  return path.join(getPreviewDirectory(root, storageKey), `page-${String(pageNumber).padStart(5, '0')}-w${width}.jpg`);
}

export function getPagePdfPath(root: string, storageKey: string, pageNumber: number): string {
  return path.join(getPreviewDirectory(root, storageKey), `page-${String(pageNumber).padStart(5, '0')}.pdf`);
}
