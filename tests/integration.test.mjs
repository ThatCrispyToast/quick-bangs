import assert from 'node:assert/strict';
import test from 'node:test';
import { browser, navigate, server, waitFor } from './browser.mjs';

function database(body) {
	return `(async () => {
		const db = await new Promise((resolve, reject) => {
			const request = indexedDB.open('quickbangs', 1);
			request.onupgradeneeded = () => request.result.createObjectStore('bangs');
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		try { ${body} } finally { db.close(); }
	})()`;
}

test('real browser: worker routing, cache lifetime, defaults, offline use, and refreshes', { timeout: 60000 }, async t => {
	const site = await server();
	const chrome = await browser();
	t.after(async () => { await chrome.close(); await site.close(); });
	const errors = [];
	chrome.on(event => { if (event.method === 'Runtime.exceptionThrown') errors.push(event.params.exceptionDetails); });
	const home = async () => {
		await navigate(chrome, `${site.origin}/app/`);
		await waitFor(chrome, 'navigator.serviceWorker.controller?.scriptURL.endsWith("?v=3")');
	};
	const search = async (query, engine) => {
		const params = new URLSearchParams({ q: query });
		if (engine) params.set('default', engine);
		const result = await navigate(chrome, `${site.origin}/app/?${params}`, true);
		await waitFor(chrome, 'location.pathname === "/destination" && document.readyState === "complete"');
		return { ...result, target: new URL(result.url).searchParams.get('url') };
	};
	await home();
	await t.test('installation does not download the dataset for default/custom searches', async () => {
		assert.equal(site.requests.filter(path => path === '/bangs.json').length, 0);
		assert.equal((await search('!g hello')).target, 'https://www.google.com/search?q=hello');
		assert.equal((await search('hello')).target, 'https://google.com/search?q=hello');
		assert.equal(site.requests.filter(path => path === '/bangs.json').length, 0);
	});
	await t.test('cold lookup downloads once and resolves aliases', async () => {
		await home();
		const before = site.requests.length;
		assert.equal((await search('!gh hello')).target, 'https://github.com/search?q=hello');
		assert.equal((await search('!github hello')).target, 'https://github.com/search?q=hello');
		assert.equal(site.requests.slice(before).filter(path => path === '/bangs.json').length, 1);
	});
	await t.test('warm queries use no page/script network requests or extra dataset fetches', async () => {
		const before = site.requests.length;
		assert.equal((await search('!github hello')).target, 'https://github.com/search?q=hello');
		assert.equal((await search('hello', 'ddg')).target, 'https://duckduckgo.com/?q=hello');
		assert.equal((await search('!g hello', 'ddg')).target, 'https://www.google.com/search?q=hello');
		assert.equal((await search('!missing hello', 'ddg')).target, 'https://duckduckgo.com/?q=!missing hello');
		const requests = site.requests.slice(before).filter(path => path.startsWith('/app/') || path === '/bangs.json');
		assert.deepEqual(requests, []);
	});
	await t.test('controlled searches redirect before a page document is loaded', async () => {
		let redirected = false;
		const stop = chrome.on(({ method, params }) => {
			if (method === 'Network.requestWillBeSent' && params.redirectResponse?.fromServiceWorker) redirected = true;
		});
		await search('!gh direct');
		stop();
		assert.equal(redirected, true);
	});
	await t.test('only owned assets are cached and query strings cannot grow the cache', async () => {
		await home();
		const entries = await chrome.evaluate(`(async () => {
			const name = (await caches.keys()).find(name => name.startsWith('quick-bangs:'));
			return (await (await caches.open(name)).keys()).map(request => new URL(request.url).pathname);
		})()`);
		assert.deepEqual(entries.sort(), ['/app/bangs.js', '/app/index.html']);
	});
	await t.test('offline queries resolve from the installed worker and database', async () => {
		await chrome.command('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
		const result = await navigate(chrome, `${site.origin}/app/?q=!gh+offline`, true);
		assert.equal(new URL(result.url).searchParams.get('url'), 'https://github.com/search?q=offline');
		await chrome.command('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
	});
	await t.test('a stale URL redirects immediately and refresh survives navigation', async () => {
		await home();
		await chrome.evaluate(database(`await new Promise((resolve, reject) => {
			const tx = db.transaction('bangs', 'readwrite');
			tx.objectStore('bangs').put(0, '\\0ts');
			tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
		});`));
		site.options.dataDelay = 1000;
		site.options.dataset[1].u = 'https://github.com/new?q={{{s}}}';
		const before = site.requests.length;
		const result = await search('!gh stale');
		assert.equal(result.target, 'https://github.com/search?q=stale');
		assert.ok(result.milliseconds < 800, `stale lookup blocked for ${result.milliseconds} ms`);
		await home();
		await waitFor(chrome, database(`return await new Promise(resolve => {
			const request = db.transaction('bangs').objectStore('bangs').get('gh');
			request.onsuccess = () => resolve(request.result.includes('%2Fnew'));
		});`));
		assert.equal(site.requests.slice(before).filter(path => path === '/bangs.json').length, 1);
		site.options.dataDelay = 0;
		assert.equal((await search('!gh fresh')).target, 'https://github.com/new?q=fresh');
	});
	await t.test('a failed refresh preserves the last usable list', async () => {
		await home();
		await chrome.evaluate(database(`await new Promise(resolve => {
			const tx = db.transaction('bangs', 'readwrite');
			tx.objectStore('bangs').put(0, '\\0ts'); tx.oncomplete = resolve;
		});`));
		site.options.dataStatus = 503;
		assert.equal((await search('!gh still-cached')).target, 'https://github.com/new?q=still-cached');
		site.options.dataStatus = 200;
	});
	await t.test('configuration changes become active after a background page update', async () => {
		site.options.transform = (file, content) => file === 'index.html'
			? content.replace('https://google.com/search?q=', 'https://example.org/search?q=') : content;
		await home();
		await waitFor(chrome, `(async () => {
			const name = (await caches.keys()).find(name => name.startsWith('quick-bangs:'));
			const page = await (await caches.open(name)).match('${site.origin}/app/index.html');
			return (await page.text()).includes('example.org');
		})()`);
		assert.equal((await search('new default')).target, 'https://example.org/search?q=new default');
	});
	await t.test('activation removes only old caches belonging to this installation', async () => {
		await home();
		const changeConfig = site.options.transform;
		site.options.transform = (file, content) => file === 'sw.js'
			? content + '\n// Test the next worker activation.\n' : changeConfig(file, content);
		await chrome.evaluate(`(async () => {
			await caches.open('unrelated-application');
			await caches.open('quick-bangs:${site.origin}/other/:v2');
			await caches.open('quick-bangs:${site.origin}/app/:v2');
			await (await navigator.serviceWorker.getRegistration()).update();
		})()`);
		await waitFor(chrome, `(async () => !(await caches.keys()).includes('quick-bangs:${site.origin}/app/:v2'))()`);
		const names = await chrome.evaluate('caches.keys()');
		assert.ok(names.includes('unrelated-application'));
		assert.ok(names.includes(`quick-bangs:${site.origin}/other/:v2`));
	});
	assert.deepEqual(errors, []);
});

test('real browser: storage denied still resolves downloaded bangs without a worker', { timeout: 30000 }, async t => {
	const site = await server();
	const chrome = await browser();
	t.after(async () => { await chrome.close(); await site.close(); });
	await chrome.command('Page.addScriptToEvaluateOnNewDocument', { source: `
		delete Navigator.prototype.serviceWorker;
		Object.defineProperty(window, 'indexedDB', { get() { throw new DOMException('Denied', 'SecurityError'); } });
		Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Denied', 'SecurityError'); } });
	` });
	const result = await navigate(chrome, `${site.origin}/app/?q=!ddg+private`, true);
	assert.equal(new URL(result.url).searchParams.get('url'), 'https://duckduckgo.com/?q=private');
});

test('real browser: cache validation, atomic writes, and concurrent downloads', { timeout: 30000 }, async t => {
	const site = await server();
	const chrome = await browser();
	t.after(async () => { await chrome.close(); await site.close(); });
	await chrome.command('Page.addScriptToEvaluateOnNewDocument', { source: 'delete Navigator.prototype.serviceWorker;' });
	await navigate(chrome, `${site.origin}/app/`);
	await chrome.evaluate(`new Promise(resolve => {
		const script = document.createElement('script'); script.src = './bangs.js';
		script.onload = resolve; document.head.append(script);
	})`);
	const before = site.requests.length;
	site.options.dataset.push({ t: 'GH', ts: ['git', 'github'], u: 'https://example.org/second?q={{{s}}}' });
	await chrome.evaluate('Promise.all([refreshBangs(), refreshBangs(), refreshBangs()]).then(() => true)');
	assert.equal(site.requests.slice(before).filter(path => path === '/bangs.json').length, 1);
	assert.match(await chrome.evaluate('resolveBang("gh")'), /github/);
	assert.match(await chrome.evaluate('resolveBang("git")'), /second/);
	const old = await chrome.evaluate('readBang("gh")');
	assert.equal(await chrome.evaluate('idbGet("gh")'), old.url);
	assert.equal(await chrome.evaluate('idbGet(TS_KEY)'), old.timestamp);
	await chrome.evaluate('refreshBangsIfStale()');
	for (const invalid of [[], {}, [{ t: 'broken' }]]) {
		site.options.dataset = invalid;
		assert.equal(await chrome.evaluate('refreshBangs().then(() => false, () => true)'), true);
		assert.deepEqual(await chrome.evaluate('readBang("gh")'), old);
	}
	await chrome.evaluate(`(async () => {
		const original = IDBObjectStore.prototype.put;
		IDBObjectStore.prototype.put = function() { throw new DOMException('Full', 'QuotaExceededError'); };
		try { await saveBangs(new Map([['gh', 'https://invalid.test/']])); } catch {}
		finally { IDBObjectStore.prototype.put = original; }
	})()`);
	assert.deepEqual(await chrome.evaluate('readBang("gh")'), old, 'failed writes must roll back the clear as well');
});
