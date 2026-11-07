// Frames: page.js runs in every frame of a tab, with refs of its own. Frame refs look like "f3:e5" (top frame
// stays "e5"); "f3" is a short number this file gives each frame id of a tab. Loaded by background.js.

const FRAME_MARK = "\u0002frame ";

let fmapPromise;
const fmap = () => (fmapPromise ??= chrome.storage.session.get({ fmap: {} }).then((r) => r.fmap));
const persistFrames = async () => chrome.storage.session.set({ fmap: await fmap() });
const shortOf = async (tab, frameId) => {
	const all = await fmap();
	const m = (all[tab] ??= { next: 1, ids: {} });
	if (!(frameId in m.ids)) {
		m.ids[frameId] = m.next++;
		persistFrames();
	}
	return m.ids[frameId];
};
const frameOfShort = async (tab, n) => {
	const m = (await fmap())[tab];
	for (const [fid, s] of Object.entries(m?.ids || {})) if (s === n) return Number(fid);
	return undefined;
};
const forgetFrames = async (tab) => {
	const all = await fmap();
	if (delete all[tab]) persistFrames();
};

const getFrames = async (tab) => {
	const all = (await chrome.webNavigation.getAllFrames({ tabId: tab })) || [];
	return all.filter((f) => !f.errorOccurred && f.documentLifecycle !== "prerender");
};

// Runs a page command in one frame of a tab, injecting page.js first (a no-op when it is already there).
const inPage = async (tabId, cmd, frameId = 0) => {
	const target = { tabId, frameIds: [frameId] };
	await chrome.scripting.executeScript({ target, files: ["page.js"] });
	const [res] = await chrome.scripting.executeScript({
		target,
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

// Which child frame sits behind each iframe element of a parent. The page gives the src and the box of the
// iframe, webNavigation gives the url of the child: equal urls win, about:blank / srcdoc children match
// iframes without a src, and what is left is paired in document order. Every child is used at most once.
const norm = (u) => String(u || "").replace(/#.*$/, "");
const matchKids = (infos, kids) => {
	const taken = new Set();
	return infos.map((info) => {
		let best;
		let bestScore = -1;
		for (const k of kids) {
			if (taken.has(k.frameId)) continue;
			let s = 0;
			if (info.src && norm(info.src) === norm(k.url)) s = 4;
			else if (!info.src && /^about:/.test(k.url)) s = 3;
			else if (info.src) s = 1;
			if (s > bestScore) {
				best = k;
				bestScore = s;
			}
		}
		if (best) taken.add(best.frameId);
		return best;
	});
};

const originLabel = (self, url) => {
	if (self?.origin && self.origin !== "null") return self.origin;
	const scheme = String(self?.url || url || "").split(":")[0];
	return scheme ? `${scheme}: (inherited origin)` : "unknown origin";
};

// Reads a tab: the top frame and, in place of every visible iframe, what that frame holds.
const readTree = async (tab, cmd) => {
	let frames;
	const kidsOf = async (fid) => ((frames ??= await getFrames(tab)), frames.filter((f) => f.parentFrameId === fid));
	const visit = async (frameId, depth) => {
		const pfx = frameId === 0 ? "" : `f${await shortOf(tab, frameId)}:`;
		const r = await inPage(tab, { ...cmd, collect: true, prefix: pfx }, frameId);
		let body = r.body;
		if (r.iframes.length) {
			const picks = depth < 4 ? matchKids(r.iframes, await kidsOf(frameId)) : [];
			const parts = await Promise.all(
				picks.map(async (k, i) => {
					if (!k) return "";
					try {
						return await visit(k.frameId, depth + 1);
					} catch (e) {
						return `<frame f${await shortOf(tab, k.frameId)} ${originLabel(null, k.url)}> (could not be read: ${String(e.message || e).slice(0, 80)}) </frame>`;
					}
				}),
			);
			body = body.replace(/^\u0001F(\d+)\u0001$/gm, (_m, i) => parts[Number(i)] ?? "").replace(/\n{2,}/g, "\n").trim();
		}
		if (frameId === 0) return `${r.header}\n\n${body}`;
		if (!body.trim()) return "";
		const name = r.iframes && r.self?.name ? ` "${r.self.name}"` : "";
		return `<frame ${pfx.slice(0, -1)} ${originLabel(r.self)}${name}>\n${body}\n</frame>`;
	};
	return visit(0, 0);
};

// Boxes for the annotated screenshot: every frame, translated into the viewport of the top frame.
const rectsTree = async (tab) => {
	const out = [];
	let width = 0;
	let height = 0;
	let frames;
	const visit = async (frameId, ox, oy, depth) => {
		const pfx = frameId === 0 ? "" : `f${await shortOf(tab, frameId)}:`;
		const r = await inPage(tab, { kind: "rects", prefix: pfx }, frameId);
		if (frameId === 0) {
			width = r.width;
			height = r.height;
		}
		for (const q of r.rects) out.push({ ...q, x: q.x + ox, y: q.y + oy });
		if (!r.iframes?.length || depth >= 4) return;
		frames ??= await getFrames(tab);
		const picks = matchKids(r.iframes, frames.filter((f) => f.parentFrameId === frameId));
		await Promise.all(picks.map((k, i) => k && visit(k.frameId, ox + r.iframes[i].x, oy + r.iframes[i].y, depth + 1).catch(() => {})));
	};
	await visit(0, 0, 0, 0);
	return { width, height, rects: out.slice(0, 150) };
};

// Offset of a frame content in the viewport of the top frame.
const frameOffset = async (tab, frameId) => {
	let ox = 0;
	let oy = 0;
	const frames = await getFrames(tab);
	let cur = frames.find((f) => f.frameId === frameId);
	for (let guard = 0; cur && cur.frameId !== 0 && guard < 6; guard++) {
		const parent = cur.parentFrameId;
		const list = await inPage(tab, { kind: "iframes" }, parent);
		const picks = matchKids(list, frames.filter((f) => f.parentFrameId === parent));
		const i = picks.findIndex((k) => k?.frameId === cur.frameId);
		if (i < 0) throw new Error("Could not place that frame in the window.");
		ox += list[i].x;
		oy += list[i].y;
		cur = frames.find((f) => f.frameId === parent);
	}
	return { x: ox, y: oy };
};

// Runs an act command. A ref "f3:e5" goes to frame f3; a click or key that lands on an iframe is re-run inside it.
const actIn = async (tab, cmd, info = {}) => {
	let frameId = 0;
	let pfx = "";
	let c = { ...cmd };
	const m = /^@?f(\d+):(e\d+)$/.exec(String(cmd.ref || ""));
	if (m) {
		const short = Number(m[1]);
		frameId = await frameOfShort(tab, short);
		const alive = frameId !== undefined && (await getFrames(tab)).some((f) => f.frameId === frameId);
		if (!alive) throw new Error(`Unknown frame "f${short}". Read the page again to get fresh refs.`);
		c.ref = m[2];
		pfx = `f${short}:`;
	}
	for (let hop = 0; hop < 5; hop++) {
		let res;
		try {
			res = await inPage(tab, { ...c, prefix: pfx }, frameId);
		} catch (e) {
			throw pfx && c.ref ? new Error(String(e.message).replaceAll(c.ref, pfx + c.ref)) : e;
		}
		if (typeof res === "string" && res.startsWith(FRAME_MARK)) {
			const at = JSON.parse(res.slice(FRAME_MARK.length));
			const kids = (await getFrames(tab)).filter((f) => f.parentFrameId === frameId);
			const [kid] = matchKids([at], kids);
			if (!kid) throw new Error("That point is inside a frame pi cannot reach.");
			frameId = kid.frameId;
			pfx = `f${await shortOf(tab, frameId)}:`;
			if (c.x !== undefined) c = { ...c, x: at.px, y: at.py, shotWidth: undefined };
			continue;
		}
		info.frameId = frameId;
		info.prefix = pfx;
		if (c.kind === "describe" && pfx) {
			try {
				res = JSON.stringify({ ...JSON.parse(res), frame: pfx.slice(0, -1) });
			} catch {}
		}
		return res;
	}
	throw new Error("Too many nested frames.");
};
