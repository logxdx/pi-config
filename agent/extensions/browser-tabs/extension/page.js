// Injected into a shared tab's top frame by background.js. Runs in the extension's
// isolated world: the page's own scripts cannot see globalThis.__pi, and nothing is
// added to the page DOM (element refs live in a WeakRef map here, not in attributes).
if (!globalThis.__pi) {
	const ids = new WeakMap();
	const byId = new Map();
	let nextId = 1;

	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const rand = (lo, hi) => lo + Math.random() * (hi - lo);

	const refOf = (el) => {
		let id = ids.get(el);
		if (!id) {
			id = nextId++;
			ids.set(el, id);
			byId.set(id, new WeakRef(el));
		}
		return `e${id}`;
	};

	const resolve = (ref) => {
		const m = /^@?e(\d+)$/.exec(String(ref || ""));
		const el = m && byId.get(Number(m[1]))?.deref();
		if (!el || !el.isConnected) {
			throw new Error(`Unknown or stale ref "${ref}". Read the page again to get fresh refs.`);
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
		"switch", "combobox", "textbox", "searchbox", "slider", "treeitem",
	]);

	const clean = (s, max = 100) => {
		s = String(s || "").replace(/\s+/g, " ").trim();
		return s.length > max ? `${s.slice(0, max - 1)}…` : s;
	};

	const isInteractive = (el) => {
		const tag = el.tagName;
		if (tag === "A") return el.hasAttribute("href");
		if (tag === "INPUT") return el.type !== "hidden";
		if (tag === "BUTTON" || tag === "SELECT" || tag === "TEXTAREA" || tag === "SUMMARY") return true;
		if (el.isContentEditable && el.getAttribute("contenteditable") !== null) return true;
		const role = el.getAttribute("role");
		if (role && ROLES.has(role)) return true;
		return el.hasAttribute("onclick");
	};

	const nameOf = (el) => {
		const aria = el.getAttribute("aria-label");
		if (aria) return clean(aria);
		const labelled = el.getAttribute("aria-labelledby");
		if (labelled) {
			const t = labelled
				.split(/\s+/)
				.map((id) => el.ownerDocument.getElementById(id)?.textContent || "")
				.join(" ");
			if (clean(t)) return clean(t);
		}
		const tag = el.tagName;
		if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
			const label = el.labels?.[0]?.textContent;
			if (clean(label)) return clean(label);
			if (el.type === "submit" || el.type === "button") return clean(el.value);
			return clean(el.placeholder || el.title || el.name);
		}
		return clean(el.innerText || el.textContent || el.title || el.querySelector("img[alt]")?.alt);
	};

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
		} else if (tag === "textarea") {
			extra.push(el.value ? `value="${clean(el.value, 80)}"` : "empty");
		} else if (tag === "select") {
			const sel = [...el.selectedOptions].map((o) => clean(o.textContent, 40)).join(", ");
			const opts = [...el.options].slice(0, 12).map((o) => clean(o.textContent, 30));
			extra.push(`selected="${sel}"`, `options: ${opts.join(" | ")}${el.options.length > 12 ? " | …" : ""}`);
		}
		if (el.disabled) extra.push("disabled");
		const ariaState = el.getAttribute("aria-expanded");
		if (ariaState) extra.push(`expanded=${ariaState}`);
		if (el.getAttribute("aria-checked")) extra.push(`checked=${el.getAttribute("aria-checked")}`);
		return `[${ref} ${kind}${name ? ` "${name}"` : ""}${extra.length ? ` ${extra.join(" ")}` : ""}]`;
	};

	// Walks the DOM (open shadow roots and same-origin iframes included) into readable text.
	const snapshot = (rootEl, interactiveOnly, maxChars) => {
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
			if (el.shadowRoot) for (const c of el.shadowRoot.childNodes) walk(c);
			if (el.tagName === "IFRAME") {
				try {
					const d = el.contentDocument;
					if (d?.body) walk(d.body);
				} catch {}
			}
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

	const fire = (el, type, init = {}) => {
		const Ctor = type.startsWith("pointer") ? PointerEvent : type.startsWith("key") ? KeyboardEvent : MouseEvent;
		el.dispatchEvent(
			new Ctor(type, { bubbles: true, cancelable: true, composed: true, view: window, ...init }),
		);
	};

	const target = async (ref) => {
		const el = resolve(ref);
		el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
		await sleep(rand(60, 160));
		const r = el.getBoundingClientRect();
		if (!r.width && !r.height) throw new Error(`${ref} has no size on screen`);
		const x = r.left + r.width * rand(0.3, 0.7);
		const y = r.top + r.height * rand(0.3, 0.7);
		const root = el.getRootNode();
		const top = (root.elementFromPoint ? root : document).elementFromPoint(x, y);
		if (top && !el.contains(top) && !top.contains(el)) {
			throw new Error(
				`${ref} is covered by <${top.tagName.toLowerCase()}> "${clean(top.textContent, 40)}" (a popup or overlay?). ` +
					"Dismiss it first, then read the page again.",
			);
		}
		return { el: top && el.contains(top) ? top : el, x, y };
	};

	const click = async (ref, opts = {}) => {
		const { el, x, y } = await target(ref);
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

	const type = async (ref, text, clear) => {
		const el = resolve(ref);
		await click(ref);
		el.focus({ preventScroll: true });
		if (clear) {
			if (el.select) el.select();
			else document.getSelection().selectAllChildren(el);
			if (!document.execCommand("delete")) {
				if (el.value !== undefined) setNative(el, "");
			}
			await sleep(rand(50, 120));
		} else if (el.setSelectionRange && el.value !== undefined) {
			el.setSelectionRange(el.value.length, el.value.length);
		}
		const chars = [...text];
		for (let i = 0; i < chars.length; ) {
			// Long text goes in small bursts rather than one character per tick.
			const n = chars.length > 200 ? Math.floor(rand(4, 10)) : 1;
			const chunk = chars.slice(i, i + n).join("");
			i += n;
			if (chunk === "\n" && el.tagName === "INPUT") continue;
			const before = el.value;
			if (!document.execCommand("insertText", false, chunk) && el.value === before && el.value !== undefined) {
				setNative(el, before + chunk);
			}
			await sleep(chars.length > 200 ? rand(20, 60) : rand(25, 110));
		}
		el.dispatchEvent(new Event("change", { bubbles: true }));
	};

	const press = async (ref, key) => {
		const el = ref ? resolve(ref) : document.activeElement || document.body;
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

	// Boxes of the interactive elements currently on screen, for annotated screenshots. Drawn onto
	// the captured bitmap by background.js, never into the page.
	const rects = () => {
		const out = [];
		const visit = (root) => {
			for (const el of root.querySelectorAll("*")) {
				if (el.shadowRoot) visit(el.shadowRoot);
				if (!isInteractive(el) || !visible(el)) continue;
				const r = el.getBoundingClientRect();
				if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
				out.push({ ref: refOf(el), x: r.left, y: r.top, w: r.width, h: r.height });
			}
		};
		visit(document);
		return { width: innerWidth, height: innerHeight, rects: out.slice(0, 150) };
	};

	const run = async (cmd) => {
		switch (cmd.kind) {
			case "rects":
				return rects();
			case "read": {
				const root = cmd.selector ? document.querySelector(cmd.selector) : document.body;
				if (!root) throw new Error(`No element matches selector "${cmd.selector}"`);
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
				await type(cmd.ref, String(cmd.text ?? ""), cmd.clear !== false);
				return "typed";
			case "press":
				await press(cmd.ref, String(cmd.key));
				return `pressed ${cmd.key}`;
			case "select": {
				const el = resolve(cmd.ref);
				if (el.tagName !== "SELECT") throw new Error(`${cmd.ref} is not a <select>`);
				const want = String(cmd.value);
				const opt = [...el.options].find((o) => o.value === want || clean(o.textContent) === want);
				if (!opt) throw new Error(`No option "${want}" in ${cmd.ref}`);
				await click(cmd.ref, { hover: true });
				el.value = opt.value;
				el.dispatchEvent(new Event("input", { bubbles: true }));
				el.dispatchEvent(new Event("change", { bubbles: true }));
				return `selected "${clean(opt.textContent)}"`;
			}
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
			case "header":
				return header();
			default:
				throw new Error(`Unknown page command "${cmd.kind}"`);
		}
	};

	globalThis.__pi = { run, header };
}
