// Shared bang-cache layer, loaded by both the page (index.html) and the
// service worker (importScripts in sw.js). Must stay worker-safe: no DOM,
// no localStorage.

// Fetch from Kagi instead of DDG: More comprehensive list of bangs
const BANGS_URL = "https://raw.githubusercontent.com/kagisearch/bangs/refs/heads/main/data/bangs.json";
const DB_NAME = 'quickbangs';
const STORE_NAME = 'bangs';
const CACHE_TTL = 2592000000; // 30 Days
// Reserved key holding the last-refresh time. The NUL byte keeps it from
// colliding with a real trigger. It is written in the same transaction as
// the bang data, so its presence guarantees the store is populated.
const TS_KEY = '\0ts';

// Open (or create) the IndexedDB store, memoized so we open at most once.
let dbPromise;
function openDB() {
	dbPromise ||= new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, 1);
		req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
	return dbPromise;
}

// Single keyed lookup — no full-list parse.
async function idbGet(key) {
	const db = await openDB();
	return new Promise((resolve, reject) => {
		const req = db.transaction(STORE_NAME).objectStore(STORE_NAME).get(key);
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

// Download the bang list and atomically replace the store contents.
// Concurrent calls share one in-flight refresh.
let refreshPromise;
function refreshBangs() {
	refreshPromise ||= (async () => {
		const res = await fetch(BANGS_URL);
		if (!res.ok) throw new Error(`Bang list fetch failed: HTTP ${res.status}`);
		const bangs = await res.json();
		const db = await openDB();
		await new Promise((resolve, reject) => {
			const tx = db.transaction(STORE_NAME, 'readwrite');
			const store = tx.objectStore(STORE_NAME);
			store.clear();
			// Key every trigger/alias to its url. First entry wins, so keys
			// already seen are skipped. Triggers are stored lowercase; lookups
			// lowercase too, making bangs case-insensitive.
			const seen = new Set();
			for (const b of bangs) {
				for (const key of [b.t, ...(b.ts || [])]) {
					const k = key && key.toLowerCase();
					if (k && !seen.has(k)) {
						seen.add(k);
						store.put(b.u, k);
					}
				}
			}
			store.put(Date.now(), TS_KEY);
			tx.oncomplete = resolve;
			tx.onerror = () => reject(tx.error);
		});
	})().finally(() => { refreshPromise = undefined; });
	return refreshPromise;
}

// Refresh only when the cache is missing or older than the timeout.
async function refreshBangsIfStale() {
	const ts = await idbGet(TS_KEY);
	if (ts === undefined || Date.now() - ts > CACHE_TTL) await refreshBangs();
}
