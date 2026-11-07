// Injected into every frame of a shared tab by background.js (one copy per frame, each with its own
// ref map; background.js adds the "f3:" frame prefix and merges the frames). Runs in the isolated
// world of the extension: the page scripts cannot see globalThis.__pi, and nothing is
// added to the page DOM (element refs live in a WeakRef map here, not in attributes).
const PI_VERSION = "0.5.0";
if (!globalThis.__pi || globalThis.__pi.v !== PI_VERSION) {
	const ids = new WeakMap();
	const byId = new Map();
	let nextId = 1;

	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const rand = (lo, hi) => lo + Math.random() * (hi - lo);

	// Closed shadow roots are reachable from an extension content script only through chrome.dom (Chromium)
	// or element.openOrClosedShadowRoot (Firefox).
	const shadowOf = (el) => {
		try {
			return el.openOrClosedShadowRoot || globalThis.chrome?.dom?.openOrClosedShadowRoot?.(el) || el.shadowRoot || null;
		} catch {
			return el.shadowRoot || null;
		}
	};
	// Frame prefix for the refs this call prints ("f3:"), set per command by background.js.
	let prefix = "";
	// A page command that hit an iframe answers with this marker + JSON so background.js can re-run it inside.
	const FRAME_MARK = "\u0002frame ";

	// role + accessible name of every ref handed out, so a ref whose element was replaced (a React
	// re-render) can be re-found: only when exactly one element still has the same role and name.
	const meta = new Map();
	const roleOf = (el) => el.getAttribute("role") || (el.tagName === "A" ? "link" : el.tagName.toLowerCase());

	const refOf = (el) => {
		let id = ids.get(el);
		if (!id) {
			id = nextId++;
			ids.set(el, id);
			byId.set(id, new WeakRef(el));
			meta.set(id, { role: roleOf(el), name: nameOf(el) });
		}
		return `${prefix}e${id}`;
	};

	const refind = (id) => {
		const want = meta.get(id);
		if (!want || !want.name) return null;
		budget = 600;
		const hits = [];
		const visit = (root) => {
			for (const el of root.querySelectorAll("*")) {
				const sr = shadowOf(el);
				if (sr) visit(sr);
				if (hits.length > 1) return;
				if (!isInteractive(el) || roleOf(el) !== want.role || nameOf(el) !== want.name) continue;
				if (visible(el)) hits.push(el);
			}
		};
		visit(document);
		return hits.length === 1 ? hits[0] : null;
	};

	const resolve = (ref) => {
		const m = /^@?(?:f\d+:)?e(\d+)$/.exec(String(ref || ""));
		if (!m || !meta.has(Number(m[1]))) {
			throw new Error(`Unknown ref "${ref}". Read the page again to get fresh refs.`);
		}
		const id = Number(m[1]);
		let el = byId.get(id)?.deref();
		if (!el || !el.isConnected) {
			el = refind(id);
			if (!el) throw new Error(`Stale ref "${ref}": stale ref, read the page again.`);
			ids.set(el, id);
			byId.set(id, new WeakRef(el));
		}
		return el;
	};

	const visible = (el) => {
		if (el.checkVisibility) return el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true });
		return el.getClientRects().length > 0;
	};

	const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "HEAD", "LINK", "META"]);
	const BLOCK = new Set([
		"ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT", "FIELDSET", "FIGCAPTION", "FIGURE",
		"FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE",
		"SECTION", "TABLE", "TR", "UL", "DETAILS", "SUMMARY",
	]);
	const ROLES = new Set([
		"button", "link", "checkbox", "radio", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option",
		"switch", "combobox", "textbox", "searchbox", "slider", "treeitem", "listbox",
	]);

	const clean = (s, max = 100) => {
		s = String(s || "").replace(/\s+/g, " ").trim();
		return s.length > max ? `${s.slice(0, max - 1)}…` : s;
	};

	const isEditable = (el) => el.isContentEditable && el.getAttribute("contenteditable") !== null;

	// Computed-style checks are the costly part of interactive detection, so each read has a budget.
	let budget = 600;
	const pointerCursor = (el) => {
		if (budget <= 0) return false;
		const p = el.parentElement;
		if (!p || el === document.body || el.children.length > 5) return false;
		budget -= 2;
		if (getComputedStyle(el).cursor !== "pointer") return false;
		return getComputedStyle(p).cursor !== "pointer";
	};

	const isInteractive = (el) => {
		const tag = el.tagName;
		if (tag === "A") return el.hasAttribute("href");
		if (tag === "INPUT") return el.type !== "hidden";
		if (tag === "BUTTON" || tag === "SELECT" || tag === "TEXTAREA" || tag === "SUMMARY") return true;
		if (isEditable(el)) return true;
		const role = el.getAttribute("role");
		if (role && ROLES.has(role)) return true;
		if (el.hasAttribute("onclick")) return true;
		if (el.hasAttribute("tabindex") && el.tabIndex >= 0) return true;
		return pointerCursor(el);
	};

	const nameOf = (el) => {
		const aria = el.getAttribute("aria-label");
		if (aria) return clean(aria);
		const labelled = el.getAttribute("aria-labelledby");
		if (labelled) {
			const t = labelled
				.split(/\s+/)
				.map((id) => el.getRootNode().getElementById?.(id)?.textContent || el.ownerDocument.getElementById(id)?.textContent || "")
				.join(" ");
			if (clean(t)) return clean(t);
		}
		const tag = el.tagName;
		if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
			// The label may wrap the control (<label>Colour <select>..</select></label>): leave the control's own text out.
			const lab = el.labels?.[0];
			let label = lab?.textContent;
			if (lab && lab.querySelector("select,option,textarea")) {
				const c = lab.cloneNode(true);
				for (const n of c.querySelectorAll("select,option,textarea")) n.remove();
				label = c.textContent;
			}
			if (clean(label)) return clean(label);
			if (el.type === "submit" || el.type === "button") return clean(el.value);
			return clean(el.placeholder || el.title || el.name);
		}
		// The text of a rich-text editor is its value, not its name.
		if (isEditable(el)) {
			return clean(el.getAttribute("aria-placeholder") || el.getAttribute("data-placeholder") || el.getAttribute("placeholder") || el.title || "");
		}
		return clean(el.innerText || el.textContent || el.title || el.querySelector("img[alt]")?.alt);
	};

	// ── Custom widgets: ARIA comboboxes, listboxes, menus ─────────────────

	const OPT_SEL = `[role="option"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="treeitem"]`;
	const POPUP_SEL = `[role="listbox"],[role="menu"],[role="tree"]`;

	// Every match of `sel` under `root`, looking into open and closed shadow roots.
	const deepAll = (root, sel, out = []) => {
		for (const el of root.querySelectorAll(sel)) out.push(el);
		for (const el of root.querySelectorAll("*")) {
			const sr = shadowOf(el);
			if (sr) deepAll(sr, sel, out);
		}
		return out;
	};

	const byIdFrom = (el, id) => el.getRootNode().getElementById?.(id) || document.getElementById(id);

	// The popup an element controls (aria-controls / aria-owns), or the element itself for a listbox / menu.
	const popupOf = (el) => {
		const ids = (el.getAttribute("aria-controls") || el.getAttribute("aria-owns") || "").split(/\s+/).filter(Boolean);
		for (const id of ids) {
			const c = byIdFrom(el, id);
			if (c) return c;
		}
		const role = el.getAttribute("role");
		if (role === "listbox" || role === "menu" || role === "tree") return el;
		return null;
	};

	const optionsFor = (el) => {
		const c = popupOf(el);
		if (!c) return [];
		const own = c === el || !c.matches?.(OPT_SEL) ? deepAll(c, OPT_SEL) : [c];
		return own.filter(visible);
	};

	// Options anywhere on the page whose popup is visible: portals (appended to body) have no aria link.
	const pageOptions = (menuish) => {
		const popups = deepAll(document, POPUP_SEL).filter(visible);
		const out = [];
		for (const p of popups) for (const o of deepAll(p, OPT_SEL)) if (visible(o)) out.push(o);
		for (const o of deepAll(document, OPT_SEL)) if (!out.includes(o) && visible(o)) out.push(o);
		// A menu button wants menu items, a combobox wants options: do not mix up two open popups.
		const kind = menuish ? /^menuitem/ : /^(option|treeitem)$/;
		return out.filter((o) => kind.test(o.getAttribute("role") || ""));
	};

	const optionLabel = (o) => clean(o.getAttribute("aria-label") || o.textContent, 80);

	const matchOption = (opts, want) => {
		const w = want.trim().toLowerCase();
		const lab = (o) => optionLabel(o).toLowerCase();
		for (const test of [(l) => l === w, (l) => l.startsWith(w), (l) => l.includes(w)]) {
			const hits = opts.filter((o) => test(lab(o)));
			if (hits.length === 1) return hits[0];
			if (hits.length > 1) {
				throw new Error(`"${want}" matches ${hits.length} options: ${hits.slice(0, 6).map((o) => `"${optionLabel(o)}"`).join(", ")}. Use the full label.`);
			}
		}
		return null;
	};

	const waitFor = async (fn, ms) => {
		const end = Date.now() + ms;
		for (;;) {
			const v = fn();
			if (v && (!Array.isArray(v) || v.length)) return v;
			if (Date.now() > end) return v;
			await sleep(80);
		}
	};

	// Opens a combobox / menu button / listbox, finds the option whose label matches and clicks it.
	const pickCustom = async (el, ref, want) => {
		const editable = el.tagName === "INPUT" || el.tagName === "TEXTAREA" || isEditable(el);
		const menuish = el.getAttribute("aria-haspopup") === "menu" || el.getAttribute("role") === "menu";
		const find = () => {
			const own = optionsFor(el);
			return own.length ? own : pageOptions(menuish);
		};
		let opts = find();
		if (!opts.length) {
			await click(ref);
			opts = await waitFor(find, 700);
		}
		if (!opts.length) {
			el.focus?.({ preventScroll: true });
			await press(ref, "ArrowDown");
			opts = await waitFor(find, 500);
		}
		if (!opts.length && editable) {
			await type(ref, want, true);
			opts = await waitFor(find, 900);
		}
		if (!opts.length) throw new Error(`${ref} shows no options. Click it, read the page again, and click the option by its ref.`);
		let opt = matchOption(opts, want);
		if (!opt && editable) {
			// Typing narrows an async or filtered list.
			await type(ref, want, true);
			await sleep(450);
			opts = find();
			opt = matchOption(opts, want);
		}
		if (!opt) {
			throw new Error(`No option "${want}" in ${ref}. Options: ${opts.slice(0, 10).map((o) => `"${optionLabel(o)}"`).join(" | ")}`);
		}
		const label = optionLabel(opt);
		const { el: hit, x, y } = await targetEl(opt, "the option");
		await clickAt(hit, x, y, {});
		await sleep(150);
		const now = el.tagName === "INPUT" ? el.value : clean(el.textContent, 60);
		return `selected "${label}"${now ? ` (now shows "${clean(now, 60)}")` : ""}`;
	};

	// ── describe / snapshot ──────────────────────────────────────────────

	const describe = (el) => {
		const tag = el.tagName.toLowerCase();
		const role = el.getAttribute("role");
		const ref = refOf(el);
		const name = nameOf(el);
		let kind = role || tag;
		const extra = [];
		if (tag === "a") {
			kind = "link";
			extra.push(`→ ${el.href}`);
		} else if (tag === "input") {
			kind = `${el.type || "text"} input`;
			if (el.type === "checkbox" || el.type === "radio") extra.push(el.checked ? "checked" : "unchecked");
			else if (el.type === "password") extra.push(el.value ? "value=••••" : "empty");
			else if (el.type !== "submit" && el.type !== "button" && el.type !== "file") {
				extra.push(el.value ? `value="${clean(el.value, 80)}"` : "empty");
			}
			if (/^(date|time|datetime-local|month|week|range|number)$/.test(el.type)) {
				for (const a of ["min", "max", "step"]) if (el.getAttribute(a)) extra.push(`${a}=${el.getAttribute(a)}`);
			}
			if (el.type === "file") {
				kind = "file input";
				extra.push(el.files?.length ? `files="${[...el.files].map((f) => f.name).join(", ")}"` : "no file");
				if (el.multiple) extra.push("multiple");
			}
			if (role === "combobox") {
				const opts = el.getAttribute("aria-expanded") === "true" ? optionsFor(el).slice(0, 12).map((o) => clean(o.textContent, 30)) : [];
				if (opts.length) extra.push(`options: ${opts.join(" | ")}`);
			}
		} else if (tag === "textarea") {
			extra.push(el.value ? `value="${clean(el.value, 80)}"` : "empty");
		} else if (isEditable(el)) {
			if (!role) kind = "editor";
			const t = clean(el.innerText, 80);
			extra.push(t ? `value="${t}"` : "empty");
		} else if (role === "combobox" || role === "listbox" || role === "menu") {
			if (role === "combobox" && clean(el.textContent, 60)) extra.push(`value="${clean(el.textContent, 60)}"`);
			if (role !== "combobox" || el.getAttribute("aria-expanded") === "true") {
				const opts = optionsFor(el).slice(0, 12).map((o) => clean(o.textContent, 30));
				if (opts.length) extra.push(`options: ${opts.join(" | ")}`);
			}
		} else if (role === "option" || role === "menuitemradio" || role === "menuitemcheckbox") {
			if (el.getAttribute("aria-selected")) extra.push(`selected=${el.getAttribute("aria-selected")}`);
		} else if (tag === "select") {
			const sel = [...el.selectedOptions].map((o) => clean(o.textContent, 40)).join(", ");
			const opts = [...el.options].slice(0, 12).map((o) => clean(o.textContent, 30));
			extra.push(`selected="${sel}"`, `options: ${opts.join(" | ")}${el.options.length > 12 ? " | …" : ""}`);
		}
		if (el.disabled) extra.push("disabled");
		const ariaState = el.getAttribute("aria-expanded");
		if (ariaState) extra.push(`expanded=${ariaState}`);
		const popup = el.getAttribute("aria-haspopup");
		if (popup && popup !== "false" && role !== "combobox") extra.push(`popup=${popup}`);
		if (el.getAttribute("aria-checked")) extra.push(`checked=${el.getAttribute("aria-checked")}`);
		return `[${ref} ${kind}${name ? ` "${name}"` : ""}${extra.length ? ` ${extra.join(" ")}` : ""}]`;
	};

	const frameInfo = (el, r = el.getBoundingClientRect()) => ({
		src: el.src || el.getAttribute("src") || "",
		name: el.name || el.getAttribute("title") || "",
		// Box of the content of the frame in the viewport of this frame: background.js uses it to translate rects.
		x: r.left + (el.clientLeft || 0),
		y: r.top + (el.clientTop || 0),
		w: el.clientWidth || r.width,
		h: el.clientHeight || r.height,
	});

	// Walks the DOM (open and closed shadow roots included) into readable text. With `frames` (an array) an
	// iframe becomes a marker line that background.js replaces by the read of that frame; without it, same-origin
	// iframes are walked inline (used when page.js runs alone).
	const snapshot = (rootEl, interactiveOnly, maxChars, frames) => {
		budget = 600;
		const out = [];
		let line = "";
		let size = 0;
		const flush = () => {
			const t = line.replace(/[ \t]+/g, " ").trim();
			if (t) {
				out.push(t);
				size += t.length + 1;
			}
			line = "";
		};
		const walk = (node) => {
			if (size > maxChars) return;
			if (node.nodeType === Node.TEXT_NODE) {
				if (!interactiveOnly) line += node.nodeValue;
				return;
			}
			if (node.nodeType !== Node.ELEMENT_NODE) return;
			const el = node;
			if (SKIP.has(el.tagName.toUpperCase())) return;
			if (!visible(el)) return;
			if (el.getAttribute("aria-hidden") === "true") return;
			if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
				if (frames) {
					flush();
					frames.push(frameInfo(el));
					line = `\u0001F${frames.length - 1}\u0001`;
					flush();
				} else {
					try {
						const d = el.contentDocument;
						if (d?.body) walk(d.body);
					} catch {}
				}
				return;
			}
			if (isInteractive(el)) {
				if (interactiveOnly) flush();
				line += ` ${describe(el)} `;
				if (interactiveOnly) flush();
				return;
			}
			const block = BLOCK.has(el.tagName);
			if (block) flush();
			if (/^H[1-6]$/.test(el.tagName) && !interactiveOnly) line += `${"#".repeat(Number(el.tagName[1]))} `;
			if (el.tagName === "LI" && !interactiveOnly) line += "- ";
			const sr = shadowOf(el);
			if (sr) for (const c of sr.childNodes) walk(c);
			for (const c of el.childNodes) walk(c);
			if (block || el.tagName === "BR") flush();
		};
		walk(rootEl);
		flush();
		let text = out.join("\n");
		if (size > maxChars) text = `${text.slice(0, maxChars)}\n… [truncated; pass a "selector" to read one part of the page]`;
		return text;
	};

	const header = () => {
		const de = document.documentElement;
		const max = Math.max(0, de.scrollHeight - innerHeight);
		return `${document.title}\n${location.href}\nscroll ${Math.round(scrollY)}/${Math.round(max)}px`;
	};

	// ── Input ────────────────────────────────────────────────────────────

	const fire = (el, type, init = {}) => {
		const Ctor = type.startsWith("pointer") ? PointerEvent : type.startsWith("key") ? KeyboardEvent : MouseEvent;
		el.dispatchEvent(
			new Ctor(type, { bubbles: true, cancelable: true, composed: true, view: window, ...init }),
		);
	};

	// Scrolls an element into view and picks a point on it; refuses when something else covers it.
	const targetEl = async (el, label, opts = {}) => {
		el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
		await sleep(rand(60, 160));
		const r = el.getBoundingClientRect();
		if (!r.width && !r.height) throw new Error(`${label} has no size on screen`);
		const x = r.left + r.width * (opts.center ? 0.5 : rand(0.3, 0.7));
		const y = r.top + r.height * (opts.center ? 0.5 : rand(0.3, 0.7));
		const root = el.getRootNode();
		const top = (root.elementFromPoint ? root : document).elementFromPoint(x, y);
		if (top && !el.contains(top) && !top.contains(el)) {
			throw new Error(
				`${label} is covered by <${top.tagName.toLowerCase()}> "${clean(top.textContent, 40)}" (a popup or overlay?). ` +
					"Dismiss it first, then read the page again.",
			);
		}
		return { el: top && el.contains(top) ? top : el, x, y, rect: r, target: el };
	};
	const target = (ref, opts) => targetEl(resolve(ref), ref, opts);

	const click = async (ref, opts = {}) => {
		const { el, x, y } = await target(ref);
		await clickAt(el, x, y, opts);
	};

	const clickAt = async (el, x, y, opts = {}) => {
		const base = { clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true };
		fire(el, "pointerover", base);
		fire(el, "mouseover", base);
		fire(el, "pointermove", base);
		fire(el, "mousemove", base);
		if (opts.hover) return;
		await sleep(rand(40, 120));
		fire(el, "pointerdown", { ...base, buttons: 1 });
		fire(el, "mousedown", { ...base, buttons: 1 });
		el.focus?.({ preventScroll: true });
		await sleep(rand(30, 90));
		fire(el, "pointerup", base);
		fire(el, "mouseup", base);
		fire(el, "click", { ...base, detail: opts.double ? 2 : 1 });
		if (opts.double) fire(el, "dblclick", { ...base, detail: 2 });
	};

	const setNative = (el, value) => {
		const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
		Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
		el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
	};

	// Date, time, range and colour inputs take a value, not keystrokes: set it the way the browser does, with
	// input and change events, and read it back so a rejected value (out of range, wrong format) is reported.
	const SPECIAL = /^(date|time|datetime-local|month|week|range|color)$/;
	const pad = (n, w = 2) => String(n).padStart(w, "0");
	const normalise = (type, text) => {
		const t = String(text).trim();
		if (type === "range" || type === "color") return t;
		const d = new Date(t);
		const valid = !Number.isNaN(d.getTime());
		const iso = (x) => `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
		const hhmm = (x) => `${pad(x.getHours())}:${pad(x.getMinutes())}`;
		switch (type) {
			case "date":
				return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : valid ? iso(d) : t;
			case "time":
				return /^\d{2}:\d{2}(:\d{2})?$/.test(t) ? t : valid ? hhmm(d) : t;
			case "datetime-local":
				return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(t) ? t : valid ? `${iso(d)}T${hhmm(d)}` : t;
			case "month":
				return /^\d{4}-\d{2}$/.test(t) ? t : valid ? iso(d).slice(0, 7) : t;
			default:
				return t;
		}
	};
	const setSpecial = async (ref, text) => {
		const el = resolve(ref);
		const want = normalise(el.type, text);
		await click(ref, { hover: true });
		el.focus?.({ preventScroll: true });
		setNative(el, want);
		el.dispatchEvent(new Event("change", { bubbles: true }));
		const clamped = el.type === "range" && el.value !== "" && el.value !== want;
		if (el.value !== want && !clamped) {
			const hint = el.type === "date" ? " Use YYYY-MM-DD." : el.type === "time" ? " Use HH:MM." : "";
			throw new Error(`${ref} did not accept "${text}" (value is now "${el.value}").${hint}`);
		}
		const bound = [el.min && `min ${el.min}`, el.max && `max ${el.max}`].filter(Boolean).join(", ");
		return `set ${el.type} to "${el.value}"${clamped ? ` (clamped from ${want}${bound ? `; ${bound}` : ""})` : ""}`;
	};

	const type = async (ref, text, clear) => {
		const el = resolve(ref);
		if (el.tagName === "INPUT" && SPECIAL.test(el.type)) return setSpecial(ref, text);
		if (el.tagName === "INPUT" && el.type === "file") throw new Error(`${ref} is a file input: use action "upload" with a file path.`);
		await click(ref);
		el.focus({ preventScroll: true });
		const rich = isEditable(el);
		if (clear) {
			if (el.select) el.select();
			else document.getSelection().selectAllChildren(el);
			if (!document.execCommand("delete")) {
				if (el.value !== undefined) setNative(el, "");
			}
			await sleep(rand(50, 120));
		} else if (el.setSelectionRange && el.value !== undefined) {
			el.setSelectionRange(el.value.length, el.value.length);
		} else if (rich) {
			const sel = document.getSelection();
			sel.selectAllChildren(el);
			sel.collapseToEnd();
		}
		const chars = [...text];
		for (let i = 0; i < chars.length; ) {
			// Long text goes in small bursts rather than one character per tick.
			const n = chars.length > 200 ? Math.floor(rand(4, 10)) : 1;
			const chunk = chars.slice(i, i + n).join("");
			i += n;
			if (chunk === "\n" && el.tagName === "INPUT") continue;
			if (chunk === "\n" && rich) {
				document.execCommand("insertParagraph");
				await sleep(rand(25, 110));
				continue;
			}
			const before = el.value;
			if (!document.execCommand("insertText", false, chunk) && el.value === before && el.value !== undefined) {
				setNative(el, before + chunk);
			}
			await sleep(chars.length > 200 ? rand(20, 60) : rand(25, 110));
		}
		el.dispatchEvent(new Event("change", { bubbles: true }));
		return rich ? `typed (editor now holds ${clean(el.innerText, 1e6).length} characters)` : "typed";
	};

	const press = async (ref, key) => {
		const el = ref ? resolve(ref) : document.activeElement || document.body;
		if (el.tagName === "IFRAME" || el.tagName === "FRAME") return `${FRAME_MARK}${JSON.stringify(frameInfo(el))}`;
		if (ref) el.focus?.({ preventScroll: true });
		const parts = key.split("+");
		const k = parts.pop();
		const mods = {
			ctrlKey: parts.includes("Control") || parts.includes("Ctrl"),
			shiftKey: parts.includes("Shift"),
			altKey: parts.includes("Alt"),
			metaKey: parts.includes("Meta"),
		};
		const init = { key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k, ...mods };
		fire(el, "keydown", init);
		fire(el, "keypress", init);
		await sleep(rand(30, 80));
		fire(el, "keyup", init);
		if (!parts.length && k === "Enter") {
			if (el.tagName === "BUTTON" || el.tagName === "A") el.click();
			else if (el.form && el.tagName === "INPUT") el.form.requestSubmit();
		} else if (k === "Tab") {
			const all = [...document.querySelectorAll("a[href],button,input,select,textarea,[tabindex]")].filter(
				(e) => !e.disabled && e.tabIndex >= 0 && visible(e),
			);
			const i = all.indexOf(el);
			const next = all[(i + (mods.shiftKey ? -1 : 1) + all.length) % all.length];
			next?.focus();
		}
		return `pressed ${key}`;
	};

	const scroll = async (ref, direction, amount) => {
		if (ref) {
			resolve(ref).scrollIntoView({ block: "center", behavior: "smooth" });
			await sleep(400);
			return;
		}
		const dy = (direction === "up" ? -1 : 1) * (amount || Math.round(innerHeight * 0.8));
		const steps = 6;
		for (let i = 0; i < steps; i++) {
			scrollBy(0, dy / steps);
			await sleep(rand(16, 40));
		}
		await sleep(150);
	};

	// File input: build the File from bytes the bridge sent and hand it over through a DataTransfer, the
	// same path a drag and drop takes. Sites see a normal change event with a real File.
	const upload = async (ref, files) => {
		const el = resolve(ref);
		if (el.tagName !== "INPUT" || el.type !== "file") throw new Error(`${ref} is not a file input. Read the page and use the ref of the "file input".`);
		if (!files?.length) throw new Error("No file to upload.");
		if (files.length > 1 && !el.multiple) throw new Error(`${ref} accepts one file only.`);
		const dt = new DataTransfer();
		for (const f of files) {
			const bin = atob(f.b64);
			const bytes = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
			dt.items.add(new File([bytes], f.name, { type: f.type || "application/octet-stream", lastModified: f.mtime || Date.now() }));
		}
		el.scrollIntoView({ block: "center", behavior: "instant" });
		el.files = dt.files;
		el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
		el.dispatchEvent(new Event("change", { bubbles: true }));
		if (el.files.length !== files.length) throw new Error(`${ref} did not accept the file.`);
		return `uploaded ${[...el.files].map((f) => `${f.name} (${f.size} bytes)`).join(", ")}`;
	};

	// ── Geometry ─────────────────────────────────────────────────────────

	// Visible iframes of this frame with their boxes in the viewport of this frame.
	const listFrames = () => {
		const out = [];
		for (const el of deepAll(document, "iframe,frame")) {
			if (!visible(el) || el.closest?.(`[aria-hidden="true"]`)) continue;
			const info = frameInfo(el);
			if (info.w < 2 || info.h < 2) continue;
			out.push(info);
		}
		return out;
	};

	// Boxes of the interactive elements currently on screen, for annotated screenshots. Drawn onto
	// the captured bitmap by background.js, never into the page.
	const rects = () => {
		const out = [];
		budget = 600;
		const visit = (root) => {
			for (const el of root.querySelectorAll("*")) {
				const sr = shadowOf(el);
				if (sr) visit(sr);
				if (!isInteractive(el) || !visible(el) || el.closest(`[aria-hidden="true"]`)) continue;
				const r = el.getBoundingClientRect();
				if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
				out.push({ ref: refOf(el), x: r.left, y: r.top, w: r.width, h: r.height });
			}
		};
		visit(document);
		return { width: innerWidth, height: innerHeight, rects: out.slice(0, 150), iframes: listFrames() };
	};

	// The element under a viewport point, looking through open and closed shadow roots.
	const elementAt = (x, y) => {
		let el = document.elementFromPoint(x, y);
		for (let guard = 0; guard < 10; guard++) {
			const sr = el && shadowOf(el);
			const inner = sr?.elementFromPoint?.(x, y);
			if (!inner || inner === el) break;
			el = inner;
		}
		return el;
	};

	// Point in screenshot pixels -> viewport pixels. `shotWidth` is the width of the screenshot the
	// caller is looking at (screenshots are downscaled), so x and y are scaled by innerWidth / shotWidth.
	const toViewport = (cmd) => {
		const k = cmd.shotWidth ? innerWidth / cmd.shotWidth : 1;
		return { x: Number(cmd.x) * k, y: Number(cmd.y) * k };
	};

	// A point inside an iframe: where the click of the caller landed, in the own viewport of the frame.
	const fromPoint = (cmd, el) => {
		const p = toViewport(cmd);
		const r = el.getBoundingClientRect();
		return { px: p.x - r.left - (el.clientLeft || 0), py: p.y - r.top - (el.clientTop || 0) };
	};

	// What the safety gate needs to know about an element: kind, label, field type, and the form it submits.
	const facts = (el) => {
		const tag = el.tagName.toLowerCase();
		const f = {
			tag,
			role: roleOf(el),
			type: tag === "input" || tag === "button" ? el.type : undefined,
			name: nameOf(el),
			placeholder: el.getAttribute("placeholder") || undefined,
			autocomplete: el.getAttribute("autocomplete") || undefined,
			field: el.name || el.id || undefined,
			// Where the element lives: the gate shows the origin of the frame, not just the tab.
			origin: location.origin,
			inFrame: window.top !== window,
		};
		const form = el.form || el.closest("form");
		if (form) {
			const inputs = [...form.elements];
			f.form = {
				method: (form.getAttribute("method") || "get").toLowerCase(),
				action: form.getAttribute("action") || "",
				textFields: inputs.filter((i) => i.tagName === "TEXTAREA" || (i.tagName === "INPUT" && /^(text|email|password|search|tel|url|number)$/.test(i.type))).length,
				hasSecret: inputs.some((i) => i.tagName === "INPUT" && (i.type === "password" || /cc-|one-time-code/.test(i.getAttribute("autocomplete") || ""))),
			};
			f.submit = (tag === "button" && el.type === "submit") || (tag === "input" && /^(submit|image)$/.test(el.type));
		}
		return f;
	};

	// Console capture, read side: background.js installs the listeners at document start.
	const consoleLines = (level, limit) => {
		const buf = globalThis.__piCap;
		if (!buf) return null;
		const order = { error: 3, warn: 2, log: 1 };
		const min = level === "all" ? 0 : level === "warn" ? 2 : 3;
		return buf.filter((m) => (order[m.l] ?? 1) >= min).slice(-limit);
	};

	const run = async (cmd) => {
		prefix = cmd.prefix || "";
		switch (cmd.kind) {
			case "describe": {
				let el;
				if (cmd.ref) el = resolve(cmd.ref);
				else if (cmd.x !== undefined) {
					const p = toViewport(cmd);
					el = elementAt(p.x, p.y);
				} else el = document.activeElement;
				if (!el) throw new Error("No element there.");
				if ((el.tagName === "IFRAME" || el.tagName === "FRAME") && cmd.x !== undefined) {
					return `${FRAME_MARK}${JSON.stringify({ ...frameInfo(el), ...fromPoint(cmd, el) })}`;
				}
				return JSON.stringify(facts(el));
			}
			case "click_xy": {
				const { x, y } = toViewport(cmd);
				if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) throw new Error(`Point (${cmd.x}, ${cmd.y}) is outside the screenshot.`);
				const el = elementAt(x, y);
				if (!el) throw new Error("Nothing at that point.");
				if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
					return `${FRAME_MARK}${JSON.stringify({ ...frameInfo(el), ...fromPoint(cmd, el) })}`;
				}
				await clickAt(el, x, y, { double: cmd.double });
				return `clicked <${el.tagName.toLowerCase()}> at (${Math.round(x)}, ${Math.round(y)})`;
			}
			case "rects":
				return rects();
			case "iframes":
				return listFrames();
			case "screenpos": {
				// Centre of the element in viewport CSS pixels plus the window numbers the caller needs to turn it into
				// screen coordinates. Scrolls the element into view; sends no mouse events.
				const t = await target(cmd.ref, { center: true });
				const r = t.rect;
				return JSON.stringify({
					cx: r.left + r.width / 2,
					cy: r.top + r.height / 2,
					w: r.width,
					h: r.height,
					name: nameOf(t.target),
					iw: innerWidth,
					ih: innerHeight,
					ow: outerWidth,
					oh: outerHeight,
					sx: window.screenX,
					sy: window.screenY,
					dpr: devicePixelRatio,
					focused: document.hasFocus(),
				});
			}
			case "read": {
				const root = cmd.selector ? document.querySelector(cmd.selector) : document.body;
				if (!root) throw new Error(`No element matches selector "${cmd.selector}"`);
				if (cmd.collect) {
					const frames = [];
					const body = snapshot(root, !!cmd.interactiveOnly, cmd.maxChars || 30000, frames);
					return { header: header(), body, iframes: frames, self: { origin: location.origin, url: location.href, name: window.name } };
				}
				const body = snapshot(root, !!cmd.interactiveOnly, cmd.maxChars || 30000);
				return `${header()}\n\n${body}`;
			}
			case "click":
				await click(cmd.ref, { double: cmd.double });
				return "clicked";
			case "hover":
				await click(cmd.ref, { hover: true });
				return "hovered";
			case "type":
				return await type(cmd.ref, String(cmd.text ?? ""), cmd.clear !== false);
			case "press":
				return await press(cmd.ref, String(cmd.key));
			case "select": {
				let el = resolve(cmd.ref);
				let ref = cmd.ref;
				let want = String(cmd.value);
				// A planner often passes the ref of an <option>: act on the dropdown that holds it.
				if (el.tagName === "OPTION") {
					const dd = el.closest("select");
					if (dd) {
						const optVal = el.value;
						if (!Array.from(dd.options).some((o) => o.value === want || clean(o.textContent) === want)) want = optVal;
						el = dd;
						ref = refOf(dd);
					}
				}
				if (el.tagName === "INPUT" && SPECIAL.test(el.type)) return setSpecial(ref, want);
				if (el.tagName === "INPUT" && el.list) {
					const o = [...el.list.options].find((x) => x.value === want || clean(x.label || x.textContent) === want);
					if (!o) throw new Error(`No suggestion "${want}" in ${cmd.ref}. Options: ${[...el.list.options].slice(0, 10).map((x) => `"${x.value}"`).join(" | ")}`);
					await click(ref, { hover: true });
					setNative(el, o.value);
					el.dispatchEvent(new Event("change", { bubbles: true }));
					return `selected "${o.value}"`;
				}
				if (el.tagName !== "SELECT") {
					const role = el.getAttribute("role");
					if (role === "option" || role === "menuitem") {
						await click(ref);
						return `clicked ${role} "${nameOf(el)}"`;
					}
					if (role === "combobox" || role === "listbox" || role === "menu" || el.hasAttribute("aria-haspopup") || el.hasAttribute("aria-expanded") || el.hasAttribute("aria-controls") || el.tagName === "INPUT") {
						return await pickCustom(el, ref, want);
					}
					throw new Error(`${cmd.ref} is not a <select>, combobox, listbox or menu. Click it and click the option by its ref.`);
				}
				// Options filled in by script keep the dropdown disabled for a moment.
				for (let i = 0; i < 12 && el.disabled; i++) await sleep(500);
				if (el.disabled) throw new Error(`The dropdown ${cmd.ref} is disabled (its options may still be loading). Read the page again, then select.`);
				const opt = [...el.options].find((o) => o.value === want || clean(o.textContent) === want);
				if (!opt) throw new Error(`No option "${want}" in ${cmd.ref}. Options: ${[...el.options].slice(0, 12).map((o) => `"${clean(o.textContent, 40)}"`).join(" | ")}`);
				await click(ref, { hover: true });
				el.value = opt.value;
				el.dispatchEvent(new Event("input", { bubbles: true }));
				el.dispatchEvent(new Event("change", { bubbles: true }));
				// Verify: a framework may have reset the value.
				await sleep(60);
				if (el.value !== opt.value) {
					throw new Error(`The dropdown did not change: its value is "${el.value}", not "${opt.value}". Read the page again: the options may still be loading, or the value must be one of the option texts exactly.`);
				}
				return `selected "${clean(opt.textContent)}" (value now "${el.value}")`;
			}
			case "upload":
				return await upload(cmd.ref, cmd.files);
			case "check":
			case "uncheck": {
				const el = resolve(cmd.ref);
				const want = cmd.kind === "check";
				if (el.checked === want) return `already ${cmd.kind}ed`;
				await click(cmd.ref);
				return `${cmd.kind}ed`;
			}
			case "scroll":
				await scroll(cmd.ref, cmd.direction, cmd.amount);
				return "scrolled";
			case "wait-text": {
				const end = Date.now() + (cmd.ms || 10000);
				while (Date.now() < end) {
					if (document.body?.innerText.includes(cmd.text)) return "found";
					await sleep(250);
				}
				throw new Error(`Text "${cmd.text}" did not appear`);
			}
			case "console-read":
				return { lines: consoleLines(cmd.level || "error", cmd.limit || 50), origin: location.origin, top: window.top === window };
			case "console-clear":
				if (globalThis.__piCap) globalThis.__piCap.length = 0;
				return "cleared";
			case "header":
				return header();
			default:
				throw new Error(`Unknown page command "${cmd.kind}"`);
		}
	};

	globalThis.__pi = { run, header, v: PI_VERSION };
}
