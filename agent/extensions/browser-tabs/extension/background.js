// Polls the pi bridge on 127.0.0.1 for commands and runs them with ordinary extension
// APIs (tabs, scripting). It never uses chrome.debugger, so the browser is not put in
// automation mode: no banner, no navigator.webdriver, no DevTools protocol attached.

// Chromium: a service worker, so the helper files are imported. Firefox: a background page that lists them as
// scripts in its manifest (see build.mjs), where importScripts does not exist.
if (typeof importScripts === "function") importScripts("frames.js", "debug.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// An optional preset.js (used by the test copies) holds the bridge token and port, so nothing needs pasting. Settings saved in the options page win over the preset.
if (typeof importScripts === "function") {
	try {
		importScripts("preset.js");
	} catch {}
}
const PRESET = globalThis.PI_PRESET ?? {};
let lastCapture = 0;
/** captureVisibleTab, at most one call per 650 ms, retried when Chrome still reports its per-second quota. */
async function captureThrottled(windowId) {
	for (let i = 0; i < 4; i++) {
		const wait = lastCapture + 650 - Date.now();
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
		lastCapture = Date.now();
		try {
			return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
		} catch (e) {
			if (!/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/.test(String(e?.message ?? e))) throw e;
		}
	}
	throw new Error("The browser refused screenshots for now (rate limit). Wait a second and try again.");
}

const cfg = async () => {
	const c = await chrome.storage.local.get({ token: "", port: 0, allowAll: false });
	return { token: c.token || PRESET.token || "", port: c.port || PRESET.port || 17420, allowAll: c.allowAll };
};
// Which browser this copy runs in. Sent with every request: the bridge serves one kind only (PI_BROWSER_CLIENT, default chromium).
const CLIENT = typeof browser !== "undefined" && browser.runtime?.getBrowserInfo ? "firefox" : "chromium";
const CLIENT_ID = `${CLIENT}/${chrome.runtime.getManifest().version}`;
// Toolbar button: chrome.action (MV3) or chrome.browserAction (Firefox MV2).
const action = chrome.action || chrome.browserAction;
// Tab groups exist in Chromium and recent Firefox; without them tabs are marked with the badge only.
const hasGroups = !!(chrome.tabGroups && chrome.tabs.group);
// Each pi session runs its own bridge on a port in [port, port + PORT_COUNT). Keep in sync with bridge.ts.
const PORT_COUNT = 10;
const getSet = async (key) => new Set((await chrome.storage.session.get({ [key]: [] }))[key]);
const putSet = (key, set) => chrome.storage.session.set({ [key]: [...set] });
// Tabs a pi session opened, as tabId -> session id: only that session may control them.
const getOwned = async () => (await chrome.storage.session.get({ owned: {} })).owned;
const putOwned = (owned) => chrome.storage.session.set({ owned });

// ── Sharing ──────────────────────────────────────────────────────────

// "shared" tabs were granted with the toolbar button (usable by every pi session); "owned" tabs
// were opened by one pi session and belong to it alone.
const mayControl = async (tabId, session) => {
	if ((await cfg()).allowAll) return true;
	return (await getSet("shared")).has(tabId) || (await getOwned())[tabId] === session;
};

const setBadge = (tabId, on, text = "pi", color = "#1a73e8") => {
	Promise.resolve(action.setBadgeText({ tabId, text: on ? text : "" })).catch(() => {});
	Promise.resolve(action.setBadgeBackgroundColor({ tabId, color })).catch(() => {});
};

// A shared tab also gets its own green "shared" tab group: native browser UI that stays in
// place in the tab strip and that the page cannot see (unlike editing its title or favicon).
// A tab already in one of the user's own groups keeps that group and only gets the badge.
const markShared = async (tabId, on) => {
	setBadge(tabId, on);
	if (!hasGroups) return;
	try {
		const tab = await chrome.tabs.get(tabId);
		const none = chrome.tabGroups.TAB_GROUP_ID_NONE;
		const ours = await getSet("sharedGroups");
		if (on && tab.groupId === none) {
			const groupId = await chrome.tabs.group({ tabIds: [tabId] });
			await chrome.tabGroups.update(groupId, { title: "shared", color: "green" });
			ours.add(groupId);
			await putSet("sharedGroups", ours);
		} else if (!on && ours.has(tab.groupId)) {
			await chrome.tabs.ungroup(tabId);
			ours.delete(tab.groupId);
			await putSet("sharedGroups", ours);
		}
	} catch {}
};

const toggleShare = async (tab) => {
	if (!tab) return;
	const shared = await getSet("shared");
	if (shared.has(tab.id)) shared.delete(tab.id);
	else shared.add(tab.id);
	await putSet("shared", shared);
	await markShared(tab.id, shared.has(tab.id));
};

action.onClicked.addListener(toggleShare);

// Keyboard shortcuts; rebind them on the browser's extension shortcuts page.
chrome.commands.onCommand.addListener(async (command, tab) => {
	if (command === "toggle-share") {
		const [active] = tab ? [tab] : await chrome.tabs.query({ active: true, lastFocusedWindow: true });
		await toggleShare(active);
	} else if (command === "unshare-all") {
		const shared = await getSet("shared");
		await putSet("shared", new Set());
		for (const id of shared) await markShared(id, false);
	}
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
	const shared = await getSet("shared");
	if (shared.delete(tabId)) await putSet("shared", shared);
	const owned = await getOwned();
	if (delete owned[tabId]) await putOwned(owned);
	forgetFrames(tabId);
	forgetDebug(tabId);
});

const requireControl = async (tabId, session) => {
	if (!Number.isInteger(tabId)) throw new Error("A tab id is required (see browser_tabs).");
	await chrome.tabs.get(tabId).catch(() => {
		throw new Error(`Tab ${tabId} no longer exists.`);
	});
	if (!(await mayControl(tabId, session))) {
		throw new Error(
			`Tab ${tabId} is not shared with pi. Ask the user to click the Pi Browser Bridge toolbar button on that tab.`,
		);
	}
};

// ── Tab helpers ──────────────────────────────────────────────────────

const waitLoaded = (tabId, timeout = 20000) =>
	new Promise((resolve) => {
		let sawLoading = false;
		const done = () => {
			clearTimeout(timer);
			clearTimeout(check);
			chrome.tabs.onUpdated.removeListener(listener);
			resolve();
		};
		const listener = (id, change) => {
			if (id !== tabId) return;
			if (change.status === "loading") sawLoading = true;
			if (change.status === "complete" && sawLoading) done();
		};
		const timer = setTimeout(done, timeout);
		// Same-document navigations (hash changes, history.pushState) never fire "loading".
		const check = setTimeout(async () => {
			const tab = await chrome.tabs.get(tabId).catch(() => null);
			if (!tab || (!sawLoading && tab.status === "complete")) done();
		}, 1500);
		chrome.tabs.onUpdated.addListener(listener);
	});

const historyStep = async (tabId, delta) => {
	const before = (await chrome.tabs.get(tabId)).url;
	try {
		await chrome.tabs[delta < 0 ? "goBack" : "goForward"](tabId);
	} catch {
		// History entries made by synthetic clicks have no user activation, which Chrome's
		// history intervention can skip; history.go() from the page still reaches them.
		await chrome.scripting.executeScript({ target: { tabId }, args: [delta], func: (d) => history.go(d) });
	}
	await waitLoaded(tabId);
	if ((await chrome.tabs.get(tabId)).url === before) {
		throw new Error(`There is no ${delta < 0 ? "earlier" : "later"} page in this tab's history.`);
	}
};

const tabLine = async (tabId) => {
	const tab = await chrome.tabs.get(tabId);
	return `${tab.title || "(untitled)"}\n${tab.url}`;
};

const groupOwned = async (tabId) => {
	if (!hasGroups) return setBadge(tabId, true, "own", "#188038"); // marker the page cannot see
	const { piGroup } = await chrome.storage.session.get("piGroup");
	let groupId;
	if (piGroup !== undefined) {
		const tab = await chrome.tabs.get(tabId);
		const g = await chrome.tabGroups.get(piGroup).catch(() => null);
		if (g && g.windowId === tab.windowId) groupId = piGroup;
	}
	groupId = await chrome.tabs.group(groupId !== undefined ? { tabIds: [tabId], groupId } : { tabIds: [tabId] });
	await chrome.tabGroups.update(groupId, { title: "Pi", color: "blue" });
	await chrome.storage.session.set({ piGroup: groupId });
};

// ── Operations ───────────────────────────────────────────────────────

const ops = {
	async list(_args, session) {
		const shared = await getSet("shared");
		const owned = await getOwned();
		const { allowAll } = await cfg();
		const tabs = await chrome.tabs.query({});
		return tabs.map((t) => ({
			id: t.id,
			windowId: t.windowId,
			active: t.active,
			title: t.title || "",
			url: t.url || "",
			access:
				owned[t.id] === session ? "owned" : allowAll || shared.has(t.id) ? "shared" : "none",
		}));
	},

	async read({ tab, selector, interactiveOnly, maxChars }, session) {
		await requireControl(tab, session);
		return readTree(tab, { kind: "read", selector, interactiveOnly, maxChars });
	},

	// captureVisibleTab only sees the active tab of a window, so a background tab is brought to the
	// front for the shot and the previously active tab is restored. No DevTools protocol involved.
	// Chrome allows about 2 captures a second (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND): captureThrottled spaces them.
	async screenshot({ tab, annotate, maxWidth }, session) {
		await requireControl(tab, session);
		const target = await chrome.tabs.get(tab);
		let restore;
		if (!target.active) {
			const [prev] = await chrome.tabs.query({ active: true, windowId: target.windowId });
			restore = prev?.id;
			await chrome.tabs.update(tab, { active: true });
			await sleep(250);
		}
		try {
			const shot = annotate ? await rectsTree(tab) : null;
			const dataUrl = await captureThrottled(target.windowId);
			const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
			const scale = Math.min(1, (maxWidth || 1568) / bitmap.width);
			const w = Math.round(bitmap.width * scale);
			const h = Math.round(bitmap.height * scale);
			const canvas = new OffscreenCanvas(w, h);
			const ctx = canvas.getContext("2d");
			ctx.drawImage(bitmap, 0, 0, w, h);
			if (shot) {
				const k = w / shot.width;
				ctx.font = "bold 12px sans-serif";
				ctx.textBaseline = "top";
				for (const r of shot.rects) {
					const x = r.x * k, y = r.y * k;
					ctx.strokeStyle = "#e8710a";
					ctx.lineWidth = 1.5;
					ctx.strokeRect(x, y, r.w * k, r.h * k);
					const tw = ctx.measureText(r.ref).width + 6;
					ctx.fillStyle = "#e8710a";
					ctx.fillRect(x, Math.max(0, y - 14), tw, 14);
					ctx.fillStyle = "#fff";
					ctx.fillText(r.ref, x + 3, Math.max(0, y - 14) + 1);
				}
			}
			const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
			const bytes = new Uint8Array(await blob.arrayBuffer());
			let bin = "";
			for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
			return { data: btoa(bin), mimeType: "image/jpeg", width: w, height: h, labelled: shot?.rects.length ?? 0, info: await tabLine(tab) };
		} finally {
			if (restore !== undefined) await chrome.tabs.update(restore, { active: true }).catch(() => {});
		}
	},

	async act({ tab, ...cmd }, session) {
		await requireControl(tab, session);
		const where = {};
		let result = await actIn(tab, cmd, where);
		if (cmd.kind === "screenpos") {
			// Add where the frame sits in the window, so the caller gets viewport coordinates of the tab.
			const o = where.frameId ? await frameOffset(tab, where.frameId) : { x: 0, y: 0 };
			const v = JSON.parse(result);
			result = JSON.stringify({ ...v, cx: v.cx + o.x, cy: v.cy + o.y });
		}
		await sleep(400);
		const now = await chrome.tabs.get(tab);
		if (now.status === "loading") await waitLoaded(tab);
		return `${result}\n---\n${await tabLine(tab)}`;
	},

	// Version and features, so pi can tell an old copy of this extension from this one.
	async info() {
		return {
			version: chrome.runtime.getManifest().version,
			features: ["frames", "closed-shadow", "widgets", "upload", "screenpos", "console"],
			client: CLIENT,
			tabGroups: hasGroups,
			closedShadow: CLIENT === "firefox" || !!globalThis.chrome?.dom,
		};
	},

	// Console messages and failed requests of one tab; capture starts with the first call for that tab.
	async console({ tab, level, limit, clear, reload }, session) {
		await requireControl(tab, session);
		const fresh = await enableDebug(tab);
		if (reload) {
			await chrome.tabs.reload(tab);
			await waitLoaded(tab);
			await sleep(300);
		}
		const out = await readDebug(tab, { level, limit, clear });
		return { ...out, started: fresh && !reload, info: await tabLine(tab) };
	},

	async tab({ action, tab, url, focus }, session) {
		if (action === "open") {
			const created = await chrome.tabs.create({ url: url || "about:blank", active: !!focus });
			const owned = await getOwned();
			owned[created.id] = session;
			await putOwned(owned);
			await groupOwned(created.id).catch(() => {});
			if (url) await waitLoaded(created.id);
			return `opened tab ${created.id}\n${await tabLine(created.id)}`;
		}
		await requireControl(tab, session);
		switch (action) {
			case "navigate":
				if (!url) throw new Error("'url' is required.");
				await chrome.tabs.update(tab, { url });
				await waitLoaded(tab);
				break;
			case "back":
				await historyStep(tab, -1);
				break;
			case "forward":
				await historyStep(tab, 1);
				break;
			case "reload":
				await chrome.tabs.reload(tab);
				await waitLoaded(tab);
				break;
			case "focus": {
				const t = await chrome.tabs.update(tab, { active: true });
				await chrome.windows.update(t.windowId, { focused: true });
				break;
			}
			case "close":
				if ((await getOwned())[tab] !== session) {
					throw new Error("pi only closes tabs it opened itself. Ask the user to close this one.");
				}
				await chrome.tabs.remove(tab);
				return `closed tab ${tab}`;
			default:
				throw new Error(`Unknown tab action "${action}".`);
		}
		return await tabLine(tab);
	},
};

// ── Bridge loop ──────────────────────────────────────────────────────

const handle = async (cmd, port) => {
	const { token } = await cfg();
	let body;
	try {
		if (!ops[cmd.op]) throw new Error(`Unknown operation "${cmd.op}".`);
		body = { id: cmd.id, ok: true, data: await ops[cmd.op](cmd.args || {}, cmd.session) };
	} catch (e) {
		body = { id: cmd.id, ok: false, error: String((e && e.message) || e) };
	}
	await fetch(`http://127.0.0.1:${port}/result`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Pi-Client": CLIENT_ID },
		body: JSON.stringify(body),
	}).catch(() => {});
};

// The bridge holds a poll up to 20s, so anything much longer means a dead connection.
const POLL_TIMEOUT_MS = 30000;

// Ports whose bridge rejected our token or our browser kind; a red "!" on the toolbar button shows it, since it is otherwise invisible.
const unauthorized = new Set();
const showAuthBadge = () => {
	Promise.resolve(action.setBadgeText({ text: unauthorized.size ? "!" : "" })).catch(() => {});
	Promise.resolve(action.setBadgeBackgroundColor({ color: "#d93025" })).catch(() => {});
};

// One poll loop per port in the range: a port with no bridge just refuses connections and is retried.
const polling = new Set();
const pollPort = async (port) => {
	if (polling.has(port)) return;
	polling.add(port);
	try {
		for (;;) {
			try {
				const cur = await cfg();
				if (port < cur.port || port >= cur.port + PORT_COUNT) return;
				if (!cur.token) {
					await sleep(5000);
					continue;
				}
				// Any extension API call resets the service worker's idle timer.
				await chrome.runtime.getPlatformInfo();
				const res = await fetch(`http://127.0.0.1:${port}/poll`, {
					headers: { Authorization: `Bearer ${cur.token}`, "X-Pi-Client": CLIENT_ID },
					signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
				});
				const rejected = res.status === 401 || res.status === 403;
				if (rejected !== unauthorized.has(port)) {
					if (rejected) unauthorized.add(port);
					else unauthorized.delete(port);
					showAuthBadge();
				}
				if (res.status === 200) handle(await res.json(), port);
				else if (res.status !== 204) await sleep(5000);
			} catch {
				if (unauthorized.delete(port)) showAuthBadge();
				await sleep(2000);
			}
		}
	} finally {
		polling.delete(port);
	}
};

const loop = async () => {
	const { port } = await cfg();
	for (let i = 0; i < PORT_COUNT; i++) pollPort(port + i);
};

chrome.runtime.onStartup.addListener(loop);
chrome.runtime.onInstalled.addListener(loop);
chrome.alarms.create("pi-bridge", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(loop);
// A sleeping service worker restarts on any event, so tab activity revives the poll loops sooner than the alarm.
chrome.tabs.onActivated.addListener(loop);
chrome.tabs.onUpdated.addListener(loop);
loop();
