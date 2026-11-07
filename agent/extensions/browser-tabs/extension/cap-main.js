// Console capture, page-world half (see debug.js). Reports through a CustomEvent that only cap-iso.js listens to.
(() => {
	const EVT = "__pi_cap_k3x9";
	const inst = Math.random().toString(36).slice(2);
	const sent = [];
	let n = 0;
	const send = (l, text, s) => {
		try {
			const detail = JSON.stringify({ l, t: String(text).slice(0, 400), s, at: Date.now(), i: inst, n: ++n });
			if (sent.length < 300) sent.push(detail);
			dispatchEvent(new CustomEvent(EVT, { detail }));
		} catch {}
	};
	// cap-iso.js announces itself when it starts listening; replay whatever it could not have heard.
	addEventListener("__pi_cap_r7", () => {
		for (const detail of sent) dispatchEvent(new CustomEvent(EVT, { detail }));
	});
	const fmt = (a) => {
		try {
			if (typeof a === "string") return a;
			// Chromium's stack starts with "Name: message"; Firefox's holds frames only.
			if (a instanceof Error) return a.stack && a.stack.includes(a.message) ? a.stack : `${a.name}: ${a.message}${a.stack ? `\n${a.stack}` : ""}`;
			if (a && typeof a === "object") return JSON.stringify(a);
			return String(a);
		} catch {
			return Object.prototype.toString.call(a);
		}
	};
	for (const [m, l] of [["error", "error"], ["warn", "warn"], ["log", "log"], ["info", "log"]]) {
		const orig = console[m];
		if (typeof orig !== "function") continue;
		// A Proxy keeps name, length and behaviour of the native function.
		console[m] = new Proxy(orig, {
			apply(t, self, args) {
				send(l, args.map(fmt).join(" "));
				return Reflect.apply(t, self, args);
			},
		});
	}
	addEventListener(
		"error",
		(e) => {
			if (e instanceof ErrorEvent) send("error", `${e.message} (${String(e.filename || "").split("/").pop()}:${e.lineno})`, "uncaught");
			else if (e.target && e.target !== window && e.target.tagName) {
				send("error", `failed to load <${e.target.tagName.toLowerCase()}> ${e.target.currentSrc || e.target.src || e.target.href || ""}`, "resource");
			}
		},
		true,
	);
	addEventListener("unhandledrejection", (e) => send("error", `unhandled rejection: ${fmt(e.reason)}`, "uncaught"));
})();
