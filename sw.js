importScripts('./bangs.js');

const CACHE_NAME = 'bang-cache-v2';
const ASSETS = ['./', './index.html', './bangs.js', './manifest.json'];

self.addEventListener('install', (e) => {
	e.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
	self.skipWaiting();
});

self.addEventListener('activate', (e) => {
	e.waitUntil((async () => {
		// Drop old cache versions (v1 also grew by one entry per unique ?q=
		// search; the ignoreSearch matching below prevents that now).
		for (const name of await caches.keys()) {
			if (name !== CACHE_NAME) await caches.delete(name);
		}
		await self.clients.claim();
	})());
});

self.addEventListener('fetch', (e) => {
	if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
	// Piggyback on page navigations to refresh a stale bang list: the worker
	// outlives the page, so the download survives the search redirect.
	if (e.request.mode === 'navigate') {
		e.waitUntil(refreshBangsIfStale().catch((err) => console.error('Bang refresh failed', err)));
	}
	e.respondWith(serveFromCache(e));
});

// Cache-first with background revalidation. ignoreSearch lets every /?q=...
// navigation hit the single cached copy of the page instantly.
async function serveFromCache(e) {
	const cached = await caches.match(e.request, { ignoreSearch: true });
	const update = fetch(e.request).then(async (res) => {
		if (res.ok) {
			// Cache under the query-less URL so entries never pile up.
			const key = new URL(e.request.url);
			key.search = '';
			const cache = await caches.open(CACHE_NAME);
			await cache.put(key, res.clone());
		}
		return res;
	});
	if (cached) {
		e.waitUntil(update.catch(() => { }));
		return cached;
	}
	return update;
}
