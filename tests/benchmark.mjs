import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { browser, navigate, server, waitFor } from './browser.mjs';

const dataset = process.env.BANGS_FIXTURE
	? JSON.parse(await readFile(process.env.BANGS_FIXTURE, 'utf8')) : undefined;
const site = await server(resolve(process.argv[2] || '.'), dataset);
let chrome = await browser();
const results = {};
try {
	// Model an uncached script request over a 100 ms network round trip.
	site.options.scriptDelay = 100;
	await chrome.command('Page.addScriptToEvaluateOnNewDocument', {
		source: 'delete Navigator.prototype.serviceWorker;',
	});
	for (const [name, query] of [['default', 'hello world'], ['custom', '!yt hello'], ['external cold', '!gh hello']]) {
		const before = site.requests.length;
		const result = await navigate(chrome, `${site.origin}/app/?q=${encodeURIComponent(query)}`, true);
		results[name] = { milliseconds: +result.milliseconds.toFixed(2), requests: site.requests.slice(before) };
		await waitFor(chrome, 'location.pathname === "/destination" && document.readyState === "complete"');
	}
	site.options.scriptDelay = 0;
	const times = [];
	for (let index = 0; index < 20; index++) {
		const result = await navigate(chrome, `${site.origin}/app/?q=!gh+warm${index}`, true);
		times.push(result.milliseconds);
		await waitFor(chrome, 'location.pathname === "/destination" && document.readyState === "complete"');
	}
	times.sort((a, b) => a - b);
	results['external warm (no worker)'] = { medianMs: +times[10].toFixed(2), p95Ms: +times[18].toFixed(2) };
	await chrome.close();
	chrome = await browser();
	await navigate(chrome, `${site.origin}/app/`);
	await waitFor(chrome, 'navigator.serviceWorker.controller');
	await navigate(chrome, `${site.origin}/app/?q=!gh+cold`, true);
	await waitFor(chrome, 'location.pathname === "/destination" && document.readyState === "complete"');
	const warmTimes = [];
	const before = site.requests.length;
	for (let index = 0; index < 20; index++) {
		const result = await navigate(chrome, `${site.origin}/app/?q=!gh+warm${index}`, true);
		warmTimes.push(result.milliseconds);
		await waitFor(chrome, 'location.pathname === "/destination" && document.readyState === "complete"');
	}
	warmTimes.sort((a, b) => a - b);
	results['external warm (worker)'] = {
		medianMs: +warmTimes[10].toFixed(2), p95Ms: +warmTimes[18].toFixed(2),
		assetRequests: site.requests.slice(before).filter(path => path.startsWith('/app/')).length,
	};
	console.log(JSON.stringify(results, null, 2));
} finally { await chrome.close(); await site.close(); }
