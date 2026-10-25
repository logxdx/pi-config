// Polls the pi bridge on 127.0.0.1 for commands and runs them with ordinary extension
// APIs (tabs, scripting). It never uses chrome.debugger, so the browser is not put in
// automation mode: no banner, no navigator.webdriver, no DevTools protocol attached.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cfg = () => chrome.storage.local.get({ token: "", port: 17420, allowAll: false });
const getSet = async (key) => new Set((await chrome.storage.session.get({ [key]: [] }))[key]);
const putSet = (key, set) => chrome.storage.session.set({ [key]: [...set] });

// ── Sharing ──────────────────────────────────────────────────────────

// "shared" tabs were granted with the toolbar button; "owned" tabs were opened by pi.
const mayControl = async (tabId) => {
	if ((await cfg()).allowAll) return true;
	return (await getSet("shared")).has(tabId) || (await getSet("owned")).has(tabId);
};

const setBadge = (tabId, on) => {
	chrome.action.setBadgeText({ tabId, text: on ? "pi" : "" }).catch(() => {});
	chrome.action.setBadgeBackgroundColor({ tabId, color: "#1a73e8" }).catch(() => {});
};

// A shared tab also gets its own green "shared" tab group: native browser UI that stays in
// place in the tab strip and that the page cannot see (unlike editing its title or favicon).
// A tab already in one of the user's own groups keeps that group and only gets the badge.
const markShared = async (tabId, on) => {
	setBadge(tabId, on);
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

chrome.action.onClicked.addListener(toggleShare);

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
	for (const key of ["shared", "owned"]) {
		const set = await getSet(key);
		if (set.delete(tabId)) await putSet(key, set);
	}
});

const requireControl = async (tabId) => {
	if (!Number.isInteger(tabId)) throw new Error("A tab id is required (see browser_tabs).");
	await chrome.tabs.get(tabId).catch(() => {
		throw new Error(`Tab ${tabId} no longer exists.`);
	});
	if (!(await mayControl(tabId))) {
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

const inPage = async (tabId, cmd) => {
	await chrome.scripting.executeScript({ target: { tabId }, files: ["page.js"] });
	const [res] = await chrome.scripting.executeScript({
		target: { tabId },
		args: [cmd],
		func: async (c) => {
			try {
				return { ok: true, value: await globalThis.__pi.run(c) };
			} catch (e) {
				return { ok: false, error: String((e && e.message) || e) };
			}
		},
	});
	if (!res?.result) throw new Error("The page did not respond.");
	if (!res.result.ok) throw new Error(res.result.error);
	return res.result.value;
};

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
	async list() {
		const shared = await getSet("shared");
		const owned = await getSet("owned");
		const { allowAll } = await cfg();
		const tabs = await chrome.tabs.query({});
		return tabs.map((t) => ({
			id: t.id,
			windowId: t.windowId,
			active: t.active,
			title: t.title || "",
			url: t.url || "",
			access: allowAll || shared.has(t.id) || owned.has(t.id) ? (owned.has(t.id) ? "owned" : "shared") : "none",
		}));
	},

	async read({ tab, selector, interactiveOnly, maxChars }) {
		await requireControl(tab);
		return inPage(tab, { kind: "read", selector, interactiveOnly, maxChars });
	},

	async act({ tab, ...cmd }) {
		await requireControl(tab);
		const result = await inPage(tab, cmd);
		await sleep(400);
		const now = await chrome.tabs.get(tab);
		if (now.status === "loading") await waitLoaded(tab);
		return `${result}\n---\n${await tabLine(tab)}`;
	},

	async tab({ action, tab, url, focus }) {
		if (action === "open") {
			const created = await chrome.tabs.create({ url: url || "about:blank", active: !!focus });
			const owned = await getSet("owned");
			owned.add(created.id);
			await putSet("owned", owned);
			await groupOwned(created.id).catch(() => {});
			if (url) await waitLoaded(created.id);
			return `opened tab ${created.id}\n${await tabLine(created.id)}`;
		}
		await requireControl(tab);
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
				if (!(await getSet("owned")).has(tab)) {
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

const handle = async (cmd) => {
	const { token, port } = await cfg();
	let body;
	try {
		if (!ops[cmd.op]) throw new Error(`Unknown operation "${cmd.op}".`);
		body = { id: cmd.id, ok: true, data: await ops[cmd.op](cmd.args || {}) };
	} catch (e) {
		body = { id: cmd.id, ok: false, error: String((e && e.message) || e) };
	}
	await fetch(`http://127.0.0.1:${port}/result`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	}).catch(() => {});
};

let running = false;
const loop = async () => {
	if (running) return;
	running = true;
	for (;;) {
		const { token, port } = await cfg();
		if (!token) {
			await sleep(5000);
			continue;
		}
		try {
			// Any extension API call resets the service worker's idle timer.
			await chrome.runtime.getPlatformInfo();
			const res = await fetch(`http://127.0.0.1:${port}/poll`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			if (res.status === 200) handle(await res.json());
			else if (res.status !== 204) await sleep(5000);
		} catch {
			await sleep(2000);
		}
	}
};

chrome.runtime.onStartup.addListener(loop);
chrome.runtime.onInstalled.addListener(loop);
chrome.alarms.create("pi-bridge", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(loop);
// A sleeping service worker restarts on any event, so tab activity revives the poll loop sooner than the alarm.
chrome.tabs.onActivated.addListener(loop);
chrome.tabs.onUpdated.addListener(loop);
loop();
