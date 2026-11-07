import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n');
const config = html.match(/<script type="application\/json" id="config">([\s\S]*?)<\/script>/)[1];
const workerSource = await readFile(new URL('../bangs.js', import.meta.url), 'utf8');

async function redirect(query, options = {}) {
	let target;
	let loads = 0;
	const lookups = [];
	const status = {};
	const params = new URLSearchParams({ q: query });
	if (options.default) params.set('default', options.default);
	const context = vm.createContext({
		URL, URLSearchParams, console: { error() {}, warn() {} }, setTimeout, clearTimeout,
		navigator: {},
		location: { search: `?${params}`, replace(url) { target = url; } },
		document: {
			getElementById: id => id === 'config' ? { textContent: config } : status,
			createElement: () => ({}),
			head: { append(script) { loads++; options.scriptError ? script.onerror() : script.onload(); } },
		},
		resolveBang: async trigger => {
			lookups.push(trigger);
			return new Map([
				['ddg', 'https://duckduckgo.com/?q={{{s}}}'],
				['c++', 'https://cpp.test/?q={{{s}}}&again={{{s}}}'],
				['a.de', 'https://a.de/?q={{{s}}}'],
			]).get(trigger);
		},
	});
	vm.runInContext(source, context);
	await new Promise(resolve => setImmediate(resolve));
	if (query && !options.scriptError) {
		const worker = vm.createContext({ query, engine: options.default, options: JSON.parse(config) });
		vm.runInContext(workerSource, worker);
		worker.resolveBang = context.resolveBang;
		const pageLookups = lookups.slice();
		assert.equal(await vm.runInContext('resolveQuery(query, engine, options)', worker), target, 'page and worker must agree');
		lookups.splice(0, lookups.length, ...pageLookups);
	}
	return { target, loads, lookups, status: status.textContent };
}

for (const [query, target] of [
	['hello world', 'https://google.com/search?q=hello%20world'],
	['  preserve   spaces  ', 'https://google.com/search?q=%20%20preserve%20%20%20spaces%20%20'],
	['bang!inside', 'https://google.com/search?q=bang!inside'],
	['a ! b', 'https://google.com/search?q=a%20!%20b'],
	['!yt hello', 'https://www.youtube.com/results?search_query=hello'],
	['hello !YT world', 'https://www.youtube.com/results?search_query=hello%20world'],
	['  hello \t!g\n world  ', 'https://www.google.com/search?q=hello%20world'],
	['!g', 'https://www.google.com/search?q='],
	['!g !yt cats', 'https://www.google.com/search?q=!yt%20cats'],
	['!yt café & # + 日本', 'https://www.youtube.com/results?search_query=caf%C3%A9%20%26%20%23%20%2B%20%E6%97%A5%E6%9C%AC'],
]) {
	test(`inline redirect: ${JSON.stringify(query)}`, async () => {
		const result = await redirect(query);
		assert.equal(result.target, target);
		assert.equal(result.loads, 0, 'fast paths must not load a script');
		assert.deepEqual(result.lookups, []);
	});
}

test('empty queries show the ready message without loading the cache', async () => {
	const result = await redirect('');
	assert.equal(result.target, undefined);
	assert.equal(result.loads, 0);
	assert.match(result.status, /Ready/);
});

for (const [query, engine, target, lookups] of [
	['hello', 'g', 'https://www.google.com/search?q=hello', []],
	['hello', '!YT', 'https://www.youtube.com/results?search_query=hello', []],
	['hello', 'ddg', 'https://duckduckgo.com/?q=hello', ['ddg']],
	['!g hello', 'ddg', 'https://www.google.com/search?q=hello', []],
	['!missing hello', 'ddg', 'https://duckduckgo.com/?q=!missing%20hello', ['missing', 'ddg']],
	['hello', 'missing', 'https://google.com/search?q=hello', ['missing']],
	['!c++ a b', 'ddg', 'https://cpp.test/?q=a%20b&again=a%20b', ['c++']],
	['hello !a.de', '', 'https://a.de/?q=hello', ['a.de']],
	['!constructor test', '', 'https://google.com/search?q=!constructor%20test', ['constructor']],
]) {
	test(`default=${engine}, q=${query}`, async () => {
		const result = await redirect(query, { default: engine });
		assert.equal(result.target, target);
		assert.deepEqual(result.lookups, lookups);
		assert.equal(result.loads, lookups.length ? 1 : 0);
	});
}

test('a failed lazy script falls back instead of leaving a blank page', async () => {
	const result = await redirect('!ddg hello', { scriptError: true });
	assert.equal(result.target, 'https://google.com/search?q=!ddg%20hello');
});
