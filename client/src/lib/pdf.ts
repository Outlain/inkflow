import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { FileRecord, PageRecord } from '@shared/contracts';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const documentTasks = new Map<string, Promise<PDFDocumentProxy>>();
const canvasTasks = new WeakMap<HTMLCanvasElement, RenderTask>();
const renderSurfaceCache = new Map<string, { surface: HTMLCanvasElement; pixels: number }>();

const DESKTOP_RENDER_CACHE_PIXEL_BUDGET = 36_000_000;
const TOUCH_RENDER_CACHE_PIXEL_BUDGET = 18_000_000;
const PDF_RANGE_CHUNK_SIZE_BYTES = 1024 * 1024;

export type PdfRenderSegment = 'full' | 'top' | 'bottom';

function documentKey(file: FileRecord): string {
  return `${file.id}:${file.url}`;
}

export function clearPdfCaches(): void {
  documentTasks.clear();
  renderSurfaceCache.clear();
}

export function getPdfDocument(file: FileRecord): Promise<PDFDocumentProxy> {
  const key = documentKey(file);
  const existing = documentTasks.get(key);
  if (existing) {
    return existing;
  }

  const task = getDocument({
    url: file.url,
    disableAutoFetch: true,
    disableStream: false,
    rangeChunkSize: PDF_RANGE_CHUNK_SIZE_BYTES,
    stopAtErrors: false
  }).promise;

  documentTasks.set(key, task);
  return task;
}

export function cancelCanvasRender(canvas: HTMLCanvasElement): void {
  canvasTasks.get(canvas)?.cancel();
  canvasTasks.delete(canvas);
}

export function resolvePdfDeviceScale(options: {
  devicePixelRatio: number;
  pageScale: number;
  coarsePointer: boolean;
  viewportWidth: number;
}): number {
  const { devicePixelRatio, pageScale, coarsePointer, viewportWidth } = options;
  const safeRatio = Math.max(devicePixelRatio || 1, 1);

  if (!coarsePointer && viewportWidth > 1080) {
    return Math.min(safeRatio, 2);
  }

  const compactCap = pageScale >= 1.15 ? 1.5 : 1.35;
  return Math.min(safeRatio, compactCap);
}

function currentEnvironment(): { devicePixelRatio: number; coarsePointer: boolean; viewportWidth: number } {
  if (typeof window === 'undefined') {
    return {
      devicePixelRatio: 1,
      coarsePointer: false,
      viewportWidth: 1440
    };
  }

  return {
    devicePixelRatio: window.devicePixelRatio || 1,
    coarsePointer: window.matchMedia?.('(pointer: coarse)')?.matches ?? false,
    viewportWidth: window.innerWidth || 1440
  };
}

function renderSurfaceKey(file: FileRecord, page: PageRecord, targetWidth: number, targetHeight: number): string {
  return `${file.id}:${page.id}:${targetWidth}x${targetHeight}`;
}

function renderSegmentKey(
  file: FileRecord,
  page: PageRecord,
  targetWidth: number,
  targetHeight: number,
  segment: PdfRenderSegment,
  segmentTop: number,
  segmentHeight: number
): string {
  return `${renderSurfaceKey(file, page, targetWidth, targetHeight)}:${segment}:${segmentTop}:${segmentHeight}`;
}

function touchCacheEntry(cacheKey: string): HTMLCanvasElement | null {
  const cached = renderSurfaceCache.get(cacheKey);
  if (!cached) {
    return null;
  }

  renderSurfaceCache.delete(cacheKey);
  renderSurfaceCache.set(cacheKey, cached);
  return cached.surface;
}

function cachePixelBudget(coarsePointer: boolean): number {
  return coarsePointer ? TOUCH_RENDER_CACHE_PIXEL_BUDGET : DESKTOP_RENDER_CACHE_PIXEL_BUDGET;
}

function storeRenderSurface(cacheKey: string, surface: HTMLCanvasElement, coarsePointer: boolean): void {
  const pixels = surface.width * surface.height;
  renderSurfaceCache.delete(cacheKey);
  renderSurfaceCache.set(cacheKey, { surface, pixels });

  let totalPixels = 0;
  for (const entry of renderSurfaceCache.values()) {
    totalPixels += entry.pixels;
  }

  const budget = cachePixelBudget(coarsePointer);
  while (totalPixels > budget && renderSurfaceCache.size > 1) {
    const oldestKey = renderSurfaceCache.keys().next().value;
    if (!oldestKey) {
      break;
    }

    const removed = renderSurfaceCache.get(oldestKey);
    renderSurfaceCache.delete(oldestKey);
    totalPixels -= removed?.pixels ?? 0;
  }
}

function copySurfaceToCanvas(params: {
  canvas: HTMLCanvasElement;
  surface: HTMLCanvasElement;
  cssWidth: number;
  cssHeight: number;
}): void {
  const { canvas, surface, cssWidth, cssHeight } = params;
  canvas.width = surface.width;
  canvas.height = surface.height;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) {
    return;
  }
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(surface, 0, 0);
}

function ensureCanvasSize(params: {
  canvas: HTMLCanvasElement;
  targetWidth: number;
  targetHeight: number;
  cssWidth: number;
  cssHeight: number;
}): CanvasRenderingContext2D | null {
  const { canvas, targetWidth, targetHeight, cssWidth, cssHeight } = params;
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }

  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  return canvas.getContext('2d', { alpha: false });
}

function segmentBounds(targetHeight: number, segment: PdfRenderSegment): { top: number; height: number } {
  if (segment === 'full') {
    return {
      top: 0,
      height: targetHeight
    };
  }

  const split = Math.max(1, Math.floor(targetHeight / 2));
  if (segment === 'top') {
    return {
      top: 0,
      height: split
    };
  }

  return {
    top: split,
    height: Math.max(1, targetHeight - split)
  };
}

export async function renderPdfPage(params: {
  canvas: HTMLCanvasElement;
  page: PageRecord;
  file: FileRecord;
  scale: number;
  segment?: PdfRenderSegment;
}): Promise<void> {
  const { canvas, page, file, scale, segment = 'full' } = params;
  const { coarsePointer, devicePixelRatio, viewportWidth } = currentEnvironment();
  const deviceScale = resolvePdfDeviceScale({
    devicePixelRatio,
    pageScale: scale,
    coarsePointer,
    viewportWidth
  });
  const cssWidth = Math.max(1, Math.floor(page.width * scale));
  const cssHeight = Math.max(1, Math.floor(page.height * scale));
  const targetWidth = Math.max(1, Math.floor(page.width * scale * deviceScale));
  const targetHeight = Math.max(1, Math.floor(page.height * scale * deviceScale));
  const { height: segmentHeight, top: segmentTop } = segmentBounds(targetHeight, segment);
  const cacheKey = renderSegmentKey(file, page, targetWidth, targetHeight, segment, segmentTop, segmentHeight);
  const cachedSurface = touchCacheEntry(cacheKey);
  if (cachedSurface) {
    cancelCanvasRender(canvas);
    const context = ensureCanvasSize({
      canvas,
      targetWidth,
      targetHeight,
      cssWidth,
      cssHeight
    });
    if (!context) {
      return;
    }
    context.drawImage(cachedSurface, 0, segmentTop);
    return;
  }

  const pdf = await getPdfDocument(file);
  const pdfPage = await pdf.getPage((page.sourcePageIndex ?? 0) + 1);
  const viewport = pdfPage.getViewport({ scale: scale * deviceScale });
  const surface = document.createElement('canvas');
  surface.width = targetWidth;
  surface.height = segmentHeight;
  const context = surface.getContext('2d', { alpha: false });
  if (!context) {
    return;
  }

  cancelCanvasRender(canvas);
  const targetContext = ensureCanvasSize({
    canvas,
    targetWidth,
    targetHeight,
    cssWidth,
    cssHeight
  });
  if (!targetContext) {
    return;
  }

  const task = pdfPage.render({
    canvasContext: context,
    viewport,
    transform: segment === 'full' ? undefined : [1, 0, 0, 1, 0, -segmentTop]
  });

  canvasTasks.set(canvas, task);

  try {
    await task.promise;
    storeRenderSurface(cacheKey, surface, coarsePointer);
    targetContext.drawImage(surface, 0, segmentTop);
  } finally {
    if (canvasTasks.get(canvas) === task) {
      canvasTasks.delete(canvas);
    }
    pdfPage.cleanup();
  }
}
