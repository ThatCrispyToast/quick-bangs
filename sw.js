const CACHE_NAME = 'bang-cache-v1';
const ASSETS = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', (e) => {
    e.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener('fetch', (e) => {
    // Only intercept the HTML page request, ignore external bang fetches
    const url = new URL(e.request.url);
    if (url.origin === location.origin) {
        e.respondWith(
            caches.match(e.request).then((cachedResponse) => {
                const networkFetch = fetch(e.request).then((response) => {
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(e.request, response.clone());
                    });
                    return response;
                });
                // Return cached version immediately if available, else fetch
                return cachedResponse || networkFetch;
            })
        );
    }
});
