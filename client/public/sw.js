const CACHE_NAME = 'inkflow-pdf-v1';
const PDF_URL_PATTERN = /\/api\/files\/[^/]+\/content/;

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
  if (!PDF_URL_PATTERN.test(event.request.url)) {
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(event.request.url);
      if (cached) {
        return cached;
      }

      const response = await fetch(event.request);
      if (response.ok) {
        // Only cache full responses (not range requests) to avoid complexity
        if (response.status === 200) {
          cache.put(event.request.url, response.clone());
        }
      }
      return response;
    })
  );
});
