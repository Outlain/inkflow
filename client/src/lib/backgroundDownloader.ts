/**
 * Background pre-downloader for per-page PDFs.
 * On slow/medium connections, fetches per-page PDF URLs in priority order
 * (outward from the active page) so the service worker caches them.
 * Later renders hit the cache instead of the network.
 *
 * Uses `priority: 'low'` on all fetch calls so the browser naturally
 * serves the active page's PDF.js render and preview image first.
 */

import { getConnectionQuality } from './networkMonitor';

type DownloadState = 'pending' | 'downloading' | 'cached' | 'failed';

interface DownloadEntry {
  pageId: string;
  pageIndex: number;
  state: DownloadState;
  abortController: AbortController | null;
  priority: number;
}

const SW_CACHE_NAME = 'inkflow-pdf-v2';

let queue = new Map<string, DownloadEntry>();
let activeIndex = 0;
let activeDownloads = 0;
let running = false;
let ready = false;
let drainScheduled = false;
let session = 0;

function maxConcurrent(): number {
  const q = getConnectionQuality();
  if (q === 'slow') return 1;
  if (q === 'medium') return 2;
  return 3;
}

function recalcPriorities(): void {
  for (const entry of queue.values()) {
    entry.priority = Math.abs(entry.pageIndex - activeIndex);
  }
}

function pickNextPending(): DownloadEntry | null {
  let best: DownloadEntry | null = null;
  for (const entry of queue.values()) {
    if (entry.state !== 'pending') continue;
    if (!best || entry.priority < best.priority) {
      best = entry;
    }
  }
  return best;
}

async function downloadPage(entry: DownloadEntry, mySession: number): Promise<void> {
  const controller = new AbortController();
  entry.abortController = controller;
  entry.state = 'downloading';
  activeDownloads++;

  try {
    const response = await fetch(`/api/pages/${entry.pageId}/pdf`, {
      signal: controller.signal,
      // Low priority so the browser serves the active page's PDF.js render
      // and preview image first. Chrome uses this to order HTTP/2 streams
      // and connection slot allocation.
      priority: 'low'
    } as RequestInit);
    if (response.ok) {
      await response.arrayBuffer();
      entry.state = 'cached';
    } else {
      entry.state = 'failed';
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      entry.state = 'pending';
    } else {
      entry.state = 'failed';
    }
  } finally {
    entry.abortController = null;
    if (mySession === session) {
      activeDownloads = Math.max(0, activeDownloads - 1);
      scheduleDrain();
    }
  }
}

function scheduleDrain(): void {
  if (drainScheduled) return;
  drainScheduled = true;
  setTimeout(drainQueue, 0);
}

function drainQueue(): void {
  drainScheduled = false;
  if (!running || !ready) return;

  const maxSlots = maxConcurrent();

  while (activeDownloads < maxSlots) {
    const next = pickNextPending();
    if (!next) break;
    void downloadPage(next, session);
  }
}

async function markCachedPages(): Promise<void> {
  try {
    const cache = await caches.open(SW_CACHE_NAME);
    const promises: Promise<void>[] = [];
    for (const entry of queue.values()) {
      promises.push(
        cache.match(`/api/pages/${entry.pageId}/pdf`).then((match) => {
          if (match) entry.state = 'cached';
        })
      );
    }
    await Promise.all(promises);
  } catch {
    // Cache API unavailable
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function startBackgroundDownload(
  pages: Array<{ id: string; kind: string }>,
  currentActiveIndex: number
): Promise<void> {
  stopBackgroundDownload();

  session++;
  activeIndex = currentActiveIndex;
  running = true;
  ready = false;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    if (page.kind !== 'pdf') continue;
    queue.set(page.id, {
      pageId: page.id,
      pageIndex: i,
      state: 'pending',
      abortController: null,
      priority: Math.abs(i - activeIndex)
    });
  }

  await markCachedPages();
  if (!running) return;

  ready = true;
  scheduleDrain();
}

/**
 * Update the active page index. Recalculates priorities and aborts
 * ALL in-flight background downloads to immediately free connection
 * slots for the active page's high-priority PDF and preview loads.
 * New background downloads restart automatically from the aborted
 * downloads' finally blocks with `priority: 'low'`, so the browser
 * naturally serves the active page's requests first.
 */
export function updateActiveIndex(newIndex: number): void {
  if (!running) return;
  activeIndex = newIndex;
  recalcPriorities();

  for (const entry of queue.values()) {
    if (entry.state === 'downloading') {
      entry.abortController?.abort();
    }
  }
}

export function stopBackgroundDownload(): void {
  running = false;
  ready = false;
  drainScheduled = false;

  for (const entry of queue.values()) {
    if (entry.state === 'downloading') {
      entry.abortController?.abort();
    }
  }

  queue.clear();
  activeDownloads = 0;
}

export function isBackgroundDownloadActive(): boolean {
  return running;
}
