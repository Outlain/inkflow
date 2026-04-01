/**
 * PDF.js integration — document loading, segment rendering, and an LRU render
 * surface cache. Adapts fetch strategy based on connection quality: full-file
 * streaming on fast networks, per-page PDF extracts on slow/medium.
 */

import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { FileRecord, PageRecord } from '@shared/contracts';
import { getNetworkConfig, getConnectionQuality, recordThroughput, type ConnectionQuality } from './networkMonitor';
import { getPublicRuntimeConfig } from './runtimeConfig';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

/** Deduplicates concurrent getDocument() calls for the same file/page. */
const documentTasks = new Map<string, Promise<PDFDocumentProxy>>();
/** Tracks the active RenderTask per canvas so it can be cancelled on re-render. */
const canvasTasks = new WeakMap<HTMLCanvasElement, RenderTask>();
/** LRU cache of rendered surfaces keyed by file+page+resolution+segment. */
const renderSurfaceCache = new Map<string, { surface: ImageBitmap | HTMLCanvasElement; pixels: number }>();

// Default cache budgets used when no runtime env override is provided.
// ~100M pixels ≈ 400 MB — keeps ~34 full A4 pages at 2x DPR rendered in cache.
const DEFAULT_DESKTOP_RENDER_CACHE_PIXEL_BUDGET = 100_000_000;
// ~50M pixels ≈ 200 MB — keeps ~17 full A4 pages on tablets/mobile.
const DEFAULT_TOUCH_RENDER_CACHE_PIXEL_BUDGET = 50_000_000;

function integerOrFallback(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export type PdfRenderSlice = {
  kind: 'slice';
  id: string;
  index: number;
  top: number;
  height: number;
  bottom: number;
  deviceTop: number;
  deviceHeight: number;
};
export type PdfFullRenderSegment = {
  kind: 'full';
  id: 'full';
};
export type PdfRenderSegment = PdfFullRenderSegment | PdfRenderSlice;
export type PdfRenderStrategy = 'segmented' | 'full';
export type PdfRenderDirection = 'up' | 'down' | 'idle';
export type PdfRenderEnvironment = {
  devicePixelRatio: number;
  coarsePointer: boolean;
  viewportWidth: number;
};
export const FULL_PAGE_RENDER_SEGMENT: PdfFullRenderSegment = {
  kind: 'full',
  id: 'full'
};

// ---------------------------------------------------------------------------
// Document loading
// ---------------------------------------------------------------------------

function documentKey(file: FileRecord): string {
  return `${file.id}:${file.url}`;
}

export function clearPdfCaches(): void {
  for (const entry of renderSurfaceCache.values()) {
    if (entry.surface instanceof ImageBitmap) {
      entry.surface.close();
    }
  }
  documentTasks.clear();
  renderSurfaceCache.clear();
}

export function getPdfDocument(file: FileRecord): Promise<PDFDocumentProxy> {
  const key = documentKey(file);
  const existing = documentTasks.get(key);
  if (existing) {
    return existing;
  }

  const networkConfig = getNetworkConfig();
  const quality = getConnectionQuality();

  // On fast connections: disableStream=false lets PDF.js stream the full file
  // in one request. The service worker caches the 200 response so subsequent
  // visits are instant. This is ideal when bandwidth is plentiful.
  //
  // On slow/medium connections: disableStream=true forces PDF.js to use range
  // requests from the very first request. Without this, PDF.js makes a non-range
  // initial request, the server returns the entire PDF (200), and the service
  // worker caches all 81MB — defeating all our chunk size optimizations.
  // With range requests, only the data needed for the current page is fetched.
  const useStream = quality === 'fast';

  const task = getDocument({
    url: file.url,
    disableAutoFetch: true,
    disableStream: !useStream,
    rangeChunkSize: networkConfig.rangeChunkSize,
    stopAtErrors: false
  }).promise;

  documentTasks.set(key, task);
  return task;
}

/**
 * Get a PDF document containing just one page, extracted server-side.
 * Used on slow/medium connections so PDF.js only downloads ~100-500KB
 * (self-contained page with embedded fonts) instead of ranging into the
 * full 81MB monolith.
 */
export function getPagePdfDocument(pageId: string): Promise<PDFDocumentProxy> {
  const key = `page:${pageId}`;
  const existing = documentTasks.get(key);
  if (existing) {
    return existing;
  }

  const task = getDocument({
    url: `/api/pages/${pageId}/pdf`,
    disableAutoFetch: false,   // small file — download everything
    disableStream: false,      // stream the full small file
    stopAtErrors: false
  }).promise;

  documentTasks.set(key, task);
  return task;
}

// ---------------------------------------------------------------------------
// Device scale and environment detection
// ---------------------------------------------------------------------------

export function cancelCanvasRender(canvas: HTMLCanvasElement): void {
  canvasTasks.get(canvas)?.cancel();
  canvasTasks.delete(canvas);
}

/** Choose the device pixel scale for PDF rendering based on device type and connection quality. */
export function resolvePdfDeviceScale(options: {
  devicePixelRatio: number;
  pageScale: number;
  coarsePointer: boolean;
  viewportWidth: number;
}): number {
  const { devicePixelRatio, coarsePointer, viewportWidth } = options;
  const safeRatio = Math.max(devicePixelRatio || 1, 1);

  if (!coarsePointer && viewportWidth > 1080) {
    // Allow full native DPR on desktop for crisp rendering
    return safeRatio;
  }

  // Allow up to 2× on touch devices for crisp rendering
  return Math.min(safeRatio, 2);
}

export function getPdfRenderEnvironment(): PdfRenderEnvironment {
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

// ---------------------------------------------------------------------------
// Render surface cache (LRU, pixel-budget eviction)
// ---------------------------------------------------------------------------

function renderSurfaceKey(file: FileRecord, page: PageRecord, targetWidth: number, targetHeight: number): string {
  return `${file.id}:${page.id}:${targetWidth}x${targetHeight}`;
}

function renderSegmentKey(
  file: FileRecord,
  page: PageRecord,
  targetWidth: number,
  targetHeight: number,
  segmentId: string,
  segmentTop: number,
  segmentHeight: number
): string {
  return `${renderSurfaceKey(file, page, targetWidth, targetHeight)}:${segmentId}:${segmentTop}:${segmentHeight}`;
}

/** Move a cache entry to the end (most-recently-used) and return its surface. */
function touchCacheEntry(cacheKey: string): ImageBitmap | HTMLCanvasElement | null {
  const cached = renderSurfaceCache.get(cacheKey);
  if (!cached) {
    return null;
  }

  renderSurfaceCache.delete(cacheKey);
  renderSurfaceCache.set(cacheKey, cached);
  return cached.surface;
}

function cachePixelBudget(coarsePointer: boolean): number {
  const runtime = getPublicRuntimeConfig();
  return coarsePointer
    ? integerOrFallback(runtime.renderCacheTouchPixels, DEFAULT_TOUCH_RENDER_CACHE_PIXEL_BUDGET)
    : integerOrFallback(runtime.renderCacheDesktopPixels, DEFAULT_DESKTOP_RENDER_CACHE_PIXEL_BUDGET);
}

/** Insert a rendered surface into the LRU cache, evicting oldest entries if over budget. */
function storeRenderSurface(cacheKey: string, surface: ImageBitmap | HTMLCanvasElement, coarsePointer: boolean): void {
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
    if (removed?.surface instanceof ImageBitmap) {
      removed.surface.close();
    }
    totalPixels -= removed?.pixels ?? 0;
  }
}

function offscreenCanvasSupported(): boolean {
  return typeof OffscreenCanvas !== 'undefined';
}

function copySurfaceToCanvas(params: {
  canvas: HTMLCanvasElement;
  surface: HTMLCanvasElement;
}): void {
  const { canvas, surface } = params;
  canvas.width = surface.width;
  canvas.height = surface.height;
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
}): CanvasRenderingContext2D | null {
  const { canvas, targetWidth, targetHeight } = params;
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }

  // PageShell owns the CSS slot geometry for both full-page and sliced
  // canvases. Reapplying inline CSS sizes here can leave stale heights in
  // place during the initial relayout window, which visually separates the
  // page slices until a rerender catches up.
  return canvas.getContext('2d', { alpha: false });
}

// ---------------------------------------------------------------------------
// Page rendering
// ---------------------------------------------------------------------------

const PDF_SLICE_TARGET_DEVICE_HEIGHT = 512;

export function getPdfRenderStrategy(connectionQuality: ConnectionQuality): PdfRenderStrategy {
  return connectionQuality === 'slow' ? 'full' : 'segmented';
}

export function buildPdfRenderStateKey(params: {
  pageScale: number;
  pageWidth: number;
  pageHeight: number;
  connectionQuality: ConnectionQuality;
  devicePixelRatio: number;
  coarsePointer: boolean;
  viewportWidth: number;
}): string {
  const { pageScale, pageWidth, pageHeight, connectionQuality, devicePixelRatio, coarsePointer, viewportWidth } = params;
  const deviceScale = resolvePdfDeviceScale({
    devicePixelRatio,
    pageScale,
    coarsePointer,
    viewportWidth
  });
  return `${pageScale.toFixed(4)}:${pageWidth.toFixed(4)}:${pageHeight.toFixed(4)}:${deviceScale.toFixed(4)}:${connectionQuality}:${getPdfRenderStrategy(connectionQuality)}`;
}

export function getPdfRenderSlices(params: {
  pageHeight: number;
  pageScale: number;
  devicePixelRatio: number;
  coarsePointer: boolean;
  viewportWidth: number;
}): PdfRenderSlice[] {
  const { pageHeight, pageScale, devicePixelRatio, coarsePointer, viewportWidth } = params;
  const cssPageHeight = pageHeight * pageScale;
  const deviceScale = resolvePdfDeviceScale({
    devicePixelRatio,
    pageScale,
    coarsePointer,
    viewportWidth
  });
  const targetHeight = Math.max(1, Math.floor(cssPageHeight * deviceScale));
  const boundaries = [0];
  for (let nextBoundary = PDF_SLICE_TARGET_DEVICE_HEIGHT; nextBoundary < targetHeight; nextBoundary += PDF_SLICE_TARGET_DEVICE_HEIGHT) {
    boundaries.push(nextBoundary);
  }
  boundaries.push(targetHeight);

  return boundaries.slice(0, -1).map((deviceTop, index) => {
    const deviceBottom = boundaries[index + 1];
    const top = deviceTop / deviceScale;
    const bottom = index === boundaries.length - 2 ? cssPageHeight : deviceBottom / deviceScale;
    return {
      kind: 'slice' as const,
      id: `slice:${index}`,
      index,
      top,
      height: bottom - top,
      bottom,
      deviceTop,
      deviceHeight: deviceBottom - deviceTop
    };
  });
}

type PdfSliceViewportRanking = {
  slice: PdfRenderSlice;
  overlap: number;
  centerDistance: number;
};

function rankPdfRenderSlicesByViewport(params: {
  pageTop: number;
  pageHeight: number;
  pageScale: number;
  viewportTop: number;
  viewportHeight: number;
  devicePixelRatio: number;
  coarsePointer: boolean;
  viewportWidth: number;
}): PdfSliceViewportRanking[] {
  const { pageTop, pageHeight, pageScale, viewportTop, viewportHeight } = params;
  const slices = getPdfRenderSlices(params);
  const cssPageHeight = pageHeight * pageScale;
  const pageBottom = pageTop + cssPageHeight;
  const visibleTop = Math.max(viewportTop, pageTop) - pageTop;
  const visibleBottom = Math.min(viewportTop + viewportHeight, pageBottom) - pageTop;

  if (visibleBottom <= 0 || visibleTop >= cssPageHeight) {
    return slices.map((slice) => ({
      slice,
      overlap: 0,
      centerDistance: slice.index
    }));
  }

  const viewportCenter = (visibleTop + visibleBottom) / 2;
  return slices
    .map((slice) => {
      const overlap = Math.max(0, Math.min(visibleBottom, slice.bottom) - Math.max(visibleTop, slice.top));
      const center = (slice.top + slice.bottom) / 2;
      return {
        slice,
        overlap,
        centerDistance: Math.abs(center - viewportCenter)
      };
    })
    .sort((left, right) => {
      if (right.overlap !== left.overlap) {
        return right.overlap - left.overlap;
      }

      if (left.centerDistance !== right.centerDistance) {
        return left.centerDistance - right.centerDistance;
      }

      return left.slice.index - right.slice.index;
    });
}

function rankPdfRenderSlicesByDirection(params: {
  slices: PdfRenderSlice[];
  visibleSliceIds: Set<string>;
  scrollDirection: Exclude<PdfRenderDirection, 'idle'>;
}): PdfRenderSlice[] {
  const { slices, visibleSliceIds, scrollDirection } = params;
  const visibleSlices = slices.filter((slice) => visibleSliceIds.has(slice.id));
  if (visibleSlices.length === 0) {
    return slices;
  }

  const sortAscending = (left: PdfRenderSlice, right: PdfRenderSlice) => left.index - right.index;
  const sortDescending = (left: PdfRenderSlice, right: PdfRenderSlice) => right.index - left.index;
  const visibleComparator = scrollDirection === 'up' ? sortDescending : sortAscending;
  const firstVisibleIndex = Math.min(...visibleSlices.map((slice) => slice.index));
  const lastVisibleIndex = Math.max(...visibleSlices.map((slice) => slice.index));
  const beforeVisible = slices.filter((slice) => slice.index < firstVisibleIndex);
  const afterVisible = slices.filter((slice) => slice.index > lastVisibleIndex);

  if (scrollDirection === 'up') {
    return [
      ...visibleSlices.sort(visibleComparator),
      ...beforeVisible.sort(sortDescending),
      ...afterVisible.sort(sortAscending)
    ];
  }

  return [
    ...visibleSlices.sort(visibleComparator),
    ...afterVisible.sort(sortAscending),
    ...beforeVisible.sort(sortDescending)
  ];
}

export function getVisiblePdfRenderSlices(params: {
  pageTop: number;
  pageHeight: number;
  pageScale: number;
  viewportTop: number;
  viewportHeight: number;
  scrollDirection?: PdfRenderDirection;
  devicePixelRatio: number;
  coarsePointer: boolean;
  viewportWidth: number;
}): PdfRenderSlice[] {
  const rankedSlices = rankPdfRenderSlicesByViewport(params);
  const visibleSlices = rankedSlices.filter(({ overlap }) => overlap > 0).map(({ slice }) => slice);
  if (visibleSlices.length === 0) {
    return rankedSlices.slice(0, 1).map(({ slice }) => slice);
  }

  if (params.scrollDirection && params.scrollDirection !== 'idle') {
    return rankPdfRenderSlicesByDirection({
      slices: getPdfRenderSlices(params),
      visibleSliceIds: new Set(visibleSlices.map((slice) => slice.id)),
      scrollDirection: params.scrollDirection
    }).filter((slice) => visibleSlices.some((visibleSlice) => visibleSlice.id === slice.id));
  }

  return visibleSlices;
}

export function getOrderedPdfRenderSlices(params: {
  pageTop: number;
  pageHeight: number;
  pageScale: number;
  viewportTop: number;
  viewportHeight: number;
  scrollDirection?: PdfRenderDirection;
  devicePixelRatio: number;
  coarsePointer: boolean;
  viewportWidth: number;
}): PdfRenderSlice[] {
  const rankedSlices = rankPdfRenderSlicesByViewport(params);
  if (!params.scrollDirection || params.scrollDirection === 'idle') {
    return rankedSlices.map(({ slice }) => slice);
  }

  return rankPdfRenderSlicesByDirection({
    slices: getPdfRenderSlices(params),
    visibleSliceIds: new Set(rankedSlices.filter(({ overlap }) => overlap > 0).map(({ slice }) => slice.id)),
    scrollDirection: params.scrollDirection
  });
}

/**
 * Render a PDF page (or a vertical segment of one) onto the given canvas.
 * Returns a cached surface when available; otherwise renders into an
 * offscreen surface, caches it, then composites onto the visible canvas.
 */
export async function renderPdfPage(params: {
  canvas: HTMLCanvasElement;
  page: PageRecord;
  file: FileRecord;
  scale: number;
  segment?: PdfRenderSegment;
}): Promise<void> {
  const { canvas, page, file, scale, segment = FULL_PAGE_RENDER_SEGMENT } = params;
  const segmentCanvas = segment.kind === 'slice';
  const { coarsePointer, devicePixelRatio, viewportWidth } = getPdfRenderEnvironment();
  const deviceScale = resolvePdfDeviceScale({
    devicePixelRatio,
    pageScale: scale,
    coarsePointer,
    viewportWidth
  });
  const targetWidth = Math.max(1, Math.floor(page.width * scale * deviceScale));
  const targetHeight = Math.max(1, Math.floor(page.height * scale * deviceScale));
  const segmentTop = segmentCanvas ? segment.deviceTop : 0;
  const segmentHeight = segmentCanvas ? segment.deviceHeight : targetHeight;
  const cacheKey = renderSegmentKey(file, page, targetWidth, targetHeight, segment.id, segmentTop, segmentHeight);
  const cachedSurface = touchCacheEntry(cacheKey);
  if (cachedSurface) {
    cancelCanvasRender(canvas);
    const context = ensureCanvasSize({
      canvas,
      targetWidth,
      targetHeight: segmentCanvas ? segmentHeight : targetHeight
    });
    if (!context) {
      return;
    }
    context.drawImage(cachedSurface, 0, segmentCanvas ? 0 : segmentTop);
    return;
  }

  // On slow/medium connections, use the per-page PDF endpoint.
  // Each extracted page is a self-contained ~100-500KB PDF that downloads
  // in one request, vs ranging into the full 81MB file.
  const quality = getConnectionQuality();
  let pdf: PDFDocumentProxy;
  let pdfPage;
  if (quality !== 'fast') {
    pdf = await getPagePdfDocument(page.id);
    pdfPage = await pdf.getPage(1);  // per-page PDF always has just page 1
  } else {
    pdf = await getPdfDocument(file);
    pdfPage = await pdf.getPage((page.sourcePageIndex ?? 0) + 1);
  }
  const viewport = pdfPage.getViewport({ scale: scale * deviceScale });
  const surface: OffscreenCanvas | HTMLCanvasElement = offscreenCanvasSupported()
    ? new OffscreenCanvas(targetWidth, segmentHeight)
    : (() => { const c = document.createElement('canvas'); c.width = targetWidth; c.height = segmentHeight; return c; })();
  const context = surface.getContext('2d', { alpha: false }) as CanvasRenderingContext2D | null;
  if (!context) {
    return;
  }

  cancelCanvasRender(canvas);
  const targetContext = ensureCanvasSize({
    canvas,
    targetWidth,
    targetHeight: segmentCanvas ? segmentHeight : targetHeight
  });
  if (!targetContext) {
    return;
  }

  const task = pdfPage.render({
    canvasContext: context,
    viewport,
    transform: segmentCanvas ? [1, 0, 0, 1, 0, -segmentTop] : undefined
  });

  canvasTasks.set(canvas, task);

  try {
    await task.promise;
    let cached: ImageBitmap | HTMLCanvasElement;
    if (surface instanceof OffscreenCanvas) {
      cached = surface.transferToImageBitmap();
    } else {
      cached = surface;
    }
    storeRenderSurface(cacheKey, cached, coarsePointer);
    targetContext.drawImage(cached, 0, segmentCanvas ? 0 : segmentTop);
  } finally {
    if (canvasTasks.get(canvas) === task) {
      canvasTasks.delete(canvas);
    }
    pdfPage.cleanup();
  }
}

/** Warm the PDF.js document cache for a page without rendering to canvas. */
export async function prefetchPdfPage(file: FileRecord, page: PageRecord): Promise<void> {
  try {
    const quality = getConnectionQuality();
    let pdf: PDFDocumentProxy;
    if (quality !== 'fast') {
      // On slow/medium, prefetch the per-page PDF so it's cached for rendering
      pdf = await getPagePdfDocument(page.id);
    } else {
      pdf = await getPdfDocument(file);
    }
    const pdfPage = await pdf.getPage(quality !== 'fast' ? 1 : (page.sourcePageIndex ?? 0) + 1);
    pdfPage.cleanup();
  } catch {
    // Prefetch is best-effort
  }
}

/**
 * Measure throughput from an image load event.
 * Called from PageShell when a preview image finishes loading.
 */
export function measurePreviewLoad(startTime: number, transferSize: number): void {
  const duration = performance.now() - startTime;
  if (duration > 50 && transferSize > 0) {
    recordThroughput(transferSize, duration);
  }
}
