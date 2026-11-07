import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';

export async function browser() {
	const profile = await mkdtemp(join(tmpdir(), 'quick-bangs-test-'));
	const process = spawn(globalThis.process.env.CHROMIUM || 'chromium', [
		'--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
		'--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
	], { stdio: ['ignore', 'ignore', 'pipe'] });
	const endpoint = await new Promise((resolve, reject) => {
		let output = '';
		const timeout = setTimeout(() => reject(new Error(`Chromium did not start: ${output}`)), 15000);
		process.on('error', reject);
		process.stderr.on('data', chunk => {
			output += chunk;
			const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
			if (match) { clearTimeout(timeout); resolve(match[1]); }
		});
	});
	const socket = new WebSocket(endpoint);
	await once(socket, 'open');
	let sequence = 0;
	const pending = new Map();
	const listeners = new Set();
	socket.addEventListener('message', event => {
		const message = JSON.parse(event.data);
		if (message.id) {
			const request = pending.get(message.id);
			pending.delete(message.id);
			if (message.error) request.reject(new Error(JSON.stringify(message.error)));
			else request.resolve(message.result);
		} else {
			for (const listener of listeners) listener(message);
		}
	});
	function send(method, params = {}, sessionId) {
		return new Promise((resolve, reject) => {
			const id = ++sequence;
			pending.set(id, { resolve, reject });
			socket.send(JSON.stringify({ id, method, params, sessionId }));
		});
	}
	const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
	const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
	const command = (method, params) => send(method, params, sessionId);
	await command('Page.enable');
	await command('Network.enable');
	await command('Runtime.enable');
	return {
		command,
		on(listener) { listeners.add(listener); return () => listeners.delete(listener); },
		async evaluate(expression) {
			const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
			if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
			return result.result.value;
		},
		async close() {
			socket.close();
			process.kill();
			await once(process, 'exit');
			await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		},
	};
}

export async function server(root = resolve('.'), dataset = [
	{ t: 'ddg', ts: ['duckduckgo'], u: 'https://duckduckgo.com/?q={{{s}}}' },
	{ t: 'gh', ts: ['github'], u: 'https://github.com/search?q={{{s}}}' },
	{ t: 'c++', u: 'https://example.com/?q={{{s}}}&again={{{s}}}' },
	{ t: 'a.de', u: 'https://example.org/?q={{{s}}}' },
]) {
	const requests = [];
	const options = { scriptDelay: 0, dataDelay: 0, dataStatus: 200, dataset };
	let origin;
	const server = createServer(async (request, response) => {
		const url = new URL(request.url, origin);
		requests.push(url.pathname + url.search);
		const path = url.pathname;
		if (path === '/destination') {
			response.setHeader('Content-Type', 'text/html');
			response.end('<!doctype html><title>Destination</title>');
			return;
		}
		if (path === '/bangs.json') {
			await new Promise(resolve => setTimeout(resolve, options.dataDelay));
			response.writeHead(options.dataStatus, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify(options.dataset).replaceAll(/https:\/\/[^" ]+/g,
				url => `${origin}/destination?url=${encodeURIComponent(url).replaceAll('%7B%7B%7Bs%7D%7D%7D', '{{{s}}}')}`));
			return;
		}
		const file = path === '/app/' ? 'index.html' : path.slice('/app/'.length);
		if (!path.startsWith('/app/') || !['index.html', 'bangs.js', 'sw.js', 'manifest.json'].includes(file)) {
			response.writeHead(404).end();
			return;
		}
		try {
			let content = await readFile(join(root, file), 'utf8');
			if (options.transform) content = options.transform(file, content);
			if (file === 'index.html') content = content.replaceAll(/https:\/\/[^"\s]+/g,
				url => `${origin}/destination?url=${encodeURIComponent(url).replaceAll('%7B%7B%7Bs%7D%7D%7D', '{{{s}}}')}`);
			if (file === 'bangs.js') {
				content = content.replace(/https:\/\/raw\.githubusercontent\.com\/[^"\s]+/, `${origin}/bangs.json`);
				await new Promise(resolve => setTimeout(resolve, options.scriptDelay));
			}
			response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.json') ? 'application/json' : 'text/html');
			response.setHeader('Cache-Control', 'no-cache');
			response.end(content);
		} catch (error) { response.writeHead(500).end(String(error)); }
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	origin = `http://127.0.0.1:${server.address().port}`;
	return { origin, requests, options, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

export async function navigate(browser, url, destination = false) {
	let start;
	let stop;
	const done = new Promise((resolve, reject) => {
		const timeout = setTimeout(() => { stop(); reject(new Error(`Navigation timed out: ${url}`)); }, 20000);
		stop = browser.on(({ method, params }) => {
			if (method !== 'Network.requestWillBeSent' || params.type !== 'Document') return;
			if (params.request.url === url) start = params.timestamp;
			if (destination && new URL(params.request.url).pathname === '/destination') {
				clearTimeout(timeout); stop();
				resolve({ url: params.request.url, milliseconds: (params.timestamp - start) * 1000 });
			}
		});
		if (!destination) {
			const loaded = browser.on(({ method }) => {
				if (method === 'Page.loadEventFired') { clearTimeout(timeout); stop(); loaded(); resolve(); }
			});
		}
	});
	await browser.command('Page.navigate', { url });
	return done;
}

export async function waitFor(browser, expression) {
	const deadline = Date.now() + 15000;
	while (Date.now() < deadline) {
		try { if (await browser.evaluate(expression)) return; } catch { /* Navigation may replace the context. */ }
		await new Promise(resolve => setTimeout(resolve, 25));
	}
	throw new Error(`Condition timed out: ${expression}`);
}
