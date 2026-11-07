importScripts('./bangs.js');

const CACHE_PREFIX = `quick-bangs:${self.registration.scope}:`;
const CACHE_NAME = `${CACHE_PREFIX}v3`;
const ASSET_TTL = 3600000; // Revalidate at most hourly, or on a visit without a query.
const PAGE_URL = new URL('./index.html', self.registration.scope).href;
const SCRIPT_URL = new URL('./bangs.js', self.registration.scope).href;
const ROOT_URL = self.registration.scope;
const updates = new Map();
let cachePromise;
let pagePromise;
let optionsPromise;
let optionsPage;
const openCache = () => cachePromise ||= caches.open(CACHE_NAME);

function updateAsset(url) {
	if (!updates.has(url)) {
		updates.set(url, (async () => {
			const response = await fetch(url, { cache: 'no-cache' });
			if (!response.ok) throw new Error(`Asset fetch failed: HTTP ${response.status}`);
			const headers = new Headers(response.headers);
			headers.delete('content-encoding');
			headers.delete('content-length');
			headers.set('x-quick-bangs-cached-at', Date.now());
			const cached = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
			await (await openCache()).put(url, cached.clone());
			if (url === PAGE_URL) {
				pagePromise = Promise.resolve(cached.clone());
				optionsPromise = undefined;
			}
			return cached;
		})().finally(() => updates.delete(url)));
	}
	return updates.get(url);
}

self.addEventListener('install', event => {
	event.waitUntil(Promise.all([updateAsset(PAGE_URL), updateAsset(SCRIPT_URL)]).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
	event.waitUntil((async () => {
		const names = await caches.keys();
		await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map(name => caches.delete(name)));
		await self.clients.claim();
	})());
});

function readOptions(page) {
	if (optionsPage !== page) { optionsPage = page; optionsPromise = undefined; }
	optionsPromise ||= page.clone().text().then(html => {
		const config = html.match(/<script type="application\/json" id="config">([\s\S]*?)<\/script>/);
		return JSON.parse(config[1]);
	}).catch(error => { optionsPromise = undefined; throw error; });
	return optionsPromise;
}

self.addEventListener('fetch', event => {
	if (event.request.method !== 'GET') return;
	const url = new URL(event.request.url);
	const bare = url.origin + url.pathname;
	const key = bare === ROOT_URL || bare === PAGE_URL ? PAGE_URL : bare === SCRIPT_URL ? SCRIPT_URL : null;
	if (!key) return;
	event.respondWith((async () => {
		const readAsset = async () => await (await openCache()).match(key) || updateAsset(key);
		const cached = await (key === PAGE_URL ? pagePromise ||= readAsset() : readAsset());
		const age = Date.now() - Number(cached.headers.get('x-quick-bangs-cached-at'));
		if (age > ASSET_TTL || (event.request.mode === 'navigate' && !url.searchParams.get('q')) || event.request.cache === 'reload') {
			event.waitUntil(updateAsset(key).catch(error => console.warn('Asset refresh failed', error)));
		}
		const query = url.searchParams.get('q');
		if (key === PAGE_URL && event.request.mode === 'navigate' && query) {
			try {
				const options = await readOptions(cached);
				const target = await resolveQuery(query, url.searchParams.get('default'), options, promise => event.waitUntil(promise));
				return Response.redirect(target, 302);
			} catch (error) { console.warn('Worker redirect failed', error); }
		}
		return cached.clone();
	})().catch(error => {
		pagePromise = undefined;
		console.warn('Offline cache unavailable', error);
		return fetch(event.request);
	}));
});
