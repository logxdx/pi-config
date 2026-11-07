// Debug parity (read only): console messages and failed network requests of a tab. Nothing is installed until
// browser_console is first used on a tab; then that tab (not the others) gets console listeners at document
// start and webRequest records failures for it. Loaded by background.js.

// Two small files do the work: cap-main.js (page world: wraps console, listens for errors) and cap-iso.js
// (isolated world: buffers what the first reports, through a CustomEvent of a name only these two files use).
// They are registered for the origin of a tab with capture on, so they run at document start, before the
// scripts of the page; other sites are not touched.

const debugTabs = new Set();
const netLog = new Map();
let netOn = false;
const debugReady = chrome.storage.session.get({ debugTabs: [] }).then((r) => {
	for (const t of r.debugTabs) debugTabs.add(t);
	if (debugTabs.size) ensureNet();
});
const saveDebugTabs = () => chrome.storage.session.set({ debugTabs: [...debugTabs] });

const ensureNet = () => {
	if (netOn) return;
	netOn = true;
	const rec = (d, extra) => {
		if (!debugTabs.has(d.tabId)) return;
		const a = netLog.get(d.tabId) ?? [];
		a.push({ at: Date.now(), m: d.method, u: d.url, type: d.type, f: d.frameId, ...extra });
		if (a.length > 200) a.shift();
		netLog.set(d.tabId, a);
	};
	chrome.webRequest.onCompleted.addListener((d) => (d.statusCode >= 400 ? rec(d, { s: d.statusCode }) : undefined), { urls: ["<all_urls>"] });
	chrome.webRequest.onErrorOccurred.addListener((d) => (!/ABORT/i.test(d.error || "") ? rec(d, { e: d.error }) : undefined), { urls: ["<all_urls>"] });
};

const originOf = (url) => {
	try {
		const u = new URL(url);
		return /^https?:$/.test(u.protocol) ? u.origin : undefined;
	} catch {
		return undefined;
	}
};
const scriptId = (origin) => `pi-cap-${origin.replace(/[^a-z0-9]/gi, "_")}`;

// Registers both halves for an origin, so the next document there is captured from its first script on.
const registerOrigin = async (origin) => {
	const id = scriptId(origin);
	const have = await chrome.scripting.getRegisteredContentScripts({ ids: [`${id}-m`] }).catch(() => []);
	if (have.length) return;
	// Match patterns carry no port (Firefox never matches a pattern with one; Chromium ignores it): scheme + host.
	const common = { matches: [`${origin.replace(/:\d+$/, "")}/*`], runAt: "document_start", allFrames: true, matchOriginAsFallback: true, persistAcrossSessions: false };
	const scripts = (c) => [
		{ ...c, id: `${id}-i`, js: ["cap-iso.js"], world: "ISOLATED" },
		{ ...c, id: `${id}-m`, js: ["cap-main.js"], world: "MAIN" },
	];
	try {
		await chrome.scripting.registerContentScripts(scripts(common));
	} catch (e) {
		// A browser that does not know matchOriginAsFallback (older Firefox) still gets the per-origin scripts.
		if (!/matchOriginAsFallback/.test(String(e?.message))) throw e;
		const { matchOriginAsFallback, ...plain } = common;
		await chrome.scripting.registerContentScripts(scripts(plain));
	}
};

// Documents that are already loaded (the tab was just enabled): install now, once per frame.
const injectNow = async (tab) => {
	const res = await chrome.scripting.executeScript({ target: { tabId: tab, allFrames: true }, injectImmediately: true, func: () => !!globalThis.__piCap });
	const fresh = res.filter((r) => r.result === false).map((r) => r.frameId);
	if (!fresh.length) return;
	const target = { tabId: tab, frameIds: fresh };
	await chrome.scripting.executeScript({ target, injectImmediately: true, files: ["cap-iso.js"] });
	await chrome.scripting.executeScript({ target, injectImmediately: true, world: "MAIN", files: ["cap-main.js"] });
};

chrome.webNavigation.onBeforeNavigate.addListener((d) => {
	if (d.frameId === 0) netLog.delete(d.tabId);
});
// A capturing tab that goes to another site gets that site registered too (the first load there may be late).
chrome.webNavigation.onCommitted.addListener(async (d) => {
	if (d.frameId !== 0) return;
	await debugReady;
	const o = originOf(d.url);
	if (debugTabs.has(d.tabId) && o) registerOrigin(o).then(() => injectNow(d.tabId)).catch(() => {});
});

const enableDebug = async (tab) => {
	await debugReady;
	const fresh = !debugTabs.has(tab);
	debugTabs.add(tab);
	ensureNet();
	await saveDebugTabs();
	const o = originOf((await chrome.tabs.get(tab)).url);
	if (o) await registerOrigin(o).catch(() => {});
	await injectNow(tab).catch(() => {});
	return fresh;
};

const forgetDebug = async (tab) => {
	await debugReady;
	netLog.delete(tab);
	if (debugTabs.delete(tab)) await saveDebugTabs();
	if (!debugTabs.size) {
		// Nobody is debugging any more: remove the per-site scripts too.
		const all = await chrome.scripting.getRegisteredContentScripts().catch(() => []);
		const ids = all.map((x) => x.id).filter((id) => id.startsWith("pi-cap-"));
		if (ids.length) await chrome.scripting.unregisterContentScripts({ ids }).catch(() => {});
	}
};

// What the tab logged since its current page started: console lines from every frame, plus failed requests.
const readDebug = async (tab, { level = "error", limit = 40, clear = false }) => {
	const min = level === "all" ? 0 : level === "warn" ? 2 : 3;
	const order = { error: 3, warn: 2, log: 1 };
	const res = await chrome.scripting
		.executeScript({
			target: { tabId: tab, allFrames: true },
			args: [clear],
			func: (clearIt) => {
				const buf = globalThis.__piCap;
				if (!buf) return null;
				const lines = buf.slice();
				if (clearIt) buf.length = 0;
				return { lines, origin: location.origin, top: window.top === window };
			},
		})
		.catch(() => []);
	const lines = [];
	for (const r of res) {
		if (!r.result) continue;
		const where = r.result.top ? "" : r.result.origin;
		for (const m of r.result.lines) if ((order[m.l] ?? 1) >= min) lines.push({ ...m, frame: where });
	}
	lines.sort((a, b) => a.at - b.at);
	const net = (netLog.get(tab) ?? []).slice();
	if (clear) netLog.delete(tab);
	return { console: lines.slice(-limit), net: net.slice(-limit), counts: { console: lines.length, net: net.length } };
};
