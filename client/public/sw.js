const CACHE_NAME = 'inkflow-pdf-v2';
const PDF_URL_PATTERN = /\/api\/files\/[^/]+\/content/;
const PAGE_PDF_PATTERN = /\/api\/pages\/[^/]+\/pdf/;

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = event.request.url;
  const isFullPdf = PDF_URL_PATTERN.test(url);
  const isPagePdf = PAGE_PDF_PATTERN.test(url);

  if (!isFullPdf && !isPagePdf) {
    return;
  }

  // Per-page PDFs: simple cache-first strategy (small files, immutable)
  if (isPagePdf) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(url);
        if (cached) return cached;
        const response = await fetch(event.request);
        if (response.ok && response.status === 200) {
          cache.put(url, response.clone());
        }
        return response;
      })
    );
    return;
  }

  // Full PDF: handle range requests and streaming
  const hasRangeHeader = event.request.headers.has('range');

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(url);

      if (cached) {
        if (hasRangeHeader && cached.status === 200) {
          return serveRangeFromCache(cached, event.request.headers.get('range'));
        }
        return cached;
      }

      if (hasRangeHeader) {
        return fetch(event.request);
      }

      const response = await fetch(event.request);
      if (response.ok && response.status === 200) {
        cache.put(url, response.clone());
      }
      return response;
    })
  );
});

/**
 * Serve a byte range from a cached full response.
 * This lets range-mode PDF.js benefit from a previously-cached full download.
 */
async function serveRangeFromCache(cached, rangeHeader) {
  try {
    const match = rangeHeader?.match(/^bytes=(\d*)-(\d*)$/);
    if (!match) {
      return cached;
    }

    const body = await cached.arrayBuffer();
    const total = body.byteLength;
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;

    if (start >= total || end < start) {
      return new Response('', {
        status: 416,
        headers: { 'content-range': `bytes */${total}` }
      });
    }

    const slice = body.slice(start, end + 1);
    return new Response(slice, {
      status: 206,
      headers: {
        'content-type': cached.headers.get('content-type') || 'application/pdf',
        'content-range': `bytes ${start}-${end}/${total}`,
        'content-length': String(slice.byteLength),
        'accept-ranges': 'bytes'
      }
    });
  } catch {
    // If anything goes wrong, fall back to network
    return fetch(new Request(cached.url));
  }
}
