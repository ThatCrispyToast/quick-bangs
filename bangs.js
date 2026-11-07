// Shared by the page and service worker. Keep this file DOM-free.
const BANGS_URL = "https://raw.githubusercontent.com/kagisearch/bangs/refs/heads/main/data/bangs.json";
const DB_NAME = 'quickbangs';
const STORE_NAME = 'bangs';
const CACHE_TTL = 2592000000; // 30 days
const TS_KEY = '\0ts';

let dbPromise;
function openDB() {
	dbPromise ||= new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, 1);
		let blocked = false;
		request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
		request.onblocked = () => {
			blocked = true;
			reject(new Error('Bang database is blocked'));
		};
		request.onsuccess = () => {
			const db = request.result;
			if (blocked) { db.close(); return; }
			db.onversionchange = () => { db.close(); dbPromise = undefined; };
			db.onclose = () => { dbPromise = undefined; };
			resolve(db);
		};
		request.onerror = () => reject(request.error);
	}).catch(error => { dbPromise = undefined; throw error; });
	return dbPromise;
}

// Read the URL and freshness marker together, in one transaction.
async function readBang(trigger) {
	const db = await openDB();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE_NAME);
		const store = tx.objectStore(STORE_NAME);
		const url = store.get(trigger);
		const timestamp = store.get(TS_KEY);
		tx.oncomplete = () => resolve({ url: url.result, timestamp: timestamp.result });
		tx.onabort = tx.onerror = () => reject(tx.error || new Error('Bang read aborted'));
	});
}

async function saveBangs(bangs) {
	const db = await openDB();
	await new Promise((resolve, reject) => {
		const tx = db.transaction(STORE_NAME, 'readwrite');
		tx.oncomplete = resolve;
		tx.onabort = tx.onerror = () => reject(tx.error || new Error('Bang update aborted'));
		const store = tx.objectStore(STORE_NAME);
		try {
			store.clear();
			for (const [trigger, url] of bangs) store.put(url, trigger);
			store.put(Date.now(), TS_KEY);
		} catch (error) { tx.abort(); reject(error); }
	});
}

// Share downloads within this context; the worker also shares them across tabs.
let refreshPromise;
function refreshBangs() {
	refreshPromise ||= (async () => {
		const response = await fetch(BANGS_URL, { signal: AbortSignal.timeout(8000) });
		if (!response.ok) throw new Error(`Bang list fetch failed: HTTP ${response.status}`);
		const entries = await response.json();
		if (!Array.isArray(entries) || !entries.length) throw new Error('Invalid bang list');
		const bangs = new Map();
		for (const entry of entries) {
			if (!entry || typeof entry.t !== 'string' || typeof entry.u !== 'string' || !entry.u) continue;
			for (const key of [entry.t, ...(Array.isArray(entry.ts) ? entry.ts : [])]) {
				if (typeof key !== 'string' || !key || key.includes('\0')) continue;
				const trigger = key.toLowerCase();
				if (!bangs.has(trigger)) bangs.set(trigger, entry.u);
			}
		}
		if (!bangs.size) throw new Error('Empty bang list');
		// Storage failure must not discard a successfully downloaded result.
		await saveBangs(bangs).catch(error => console.warn('Bang cache unavailable', error));
		return bangs;
	})().finally(() => { refreshPromise = undefined; });
	return refreshPromise;
}

async function resolveBang(trigger, keepAlive = () => {}) {
	try {
		let cached;
		try { cached = await readBang(trigger); }
		catch (error) { console.warn('Bang cache unavailable', error); }
		if (cached?.timestamp !== undefined) {
			if (Date.now() - cached.timestamp > CACHE_TTL) {
				keepAlive(refreshBangs().catch(error => console.warn('Bang refresh failed', error)));
			}
			return typeof cached.url === 'string' ? cached.url : undefined;
		}
		return (await refreshBangs()).get(trigger);
	} catch (error) {
		console.error('Bang lookup failed', error);
		return undefined;
	}
}

// Keep pages and workers already cached by v2 working during an update.
async function idbGet(key) {
	return (await readBang(key)).url;
}

async function refreshBangsIfStale() {
	const timestamp = await idbGet(TS_KEY);
	if (timestamp === undefined || Date.now() - timestamp > CACHE_TTL) await refreshBangs();
}

// Worker navigation and the initial page use the same bang precedence.
async function resolveQuery(query, defaultTrigger, options, keepAlive) {
	const lookup = trigger => Object.hasOwn(options.quickerBangs, trigger)
		? options.quickerBangs[trigger] : resolveBang(trigger, keepAlive);
	const bang = /(?:^|\s)!([^\s]+)/.exec(query);
	if (bang) {
		const url = await lookup(bang[1].toLowerCase());
		if (url) {
			const term = (query.slice(0, bang.index) + ' ' + query.slice(bang.index + bang[0].length)).trim().replace(/\s+/g, ' ');
			return url.replaceAll('{{{s}}}', encodeURIComponent(term));
		}
	}
	const trigger = defaultTrigger?.replace(/^!/, '').toLowerCase();
	const url = trigger && await lookup(trigger);
	return (url || options.defaultUrl).replaceAll('{{{s}}}', encodeURIComponent(query));
}
