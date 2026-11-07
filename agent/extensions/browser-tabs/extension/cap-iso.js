// Console capture, isolated-world half (see debug.js). Buffers what cap-main.js reports; page.js reads the buffer.
(() => {
	if (globalThis.__piCap) return;
	const buf = (globalThis.__piCap = []);
	const last = {}; // last sequence number seen per cap-main instance, so a replay adds nothing twice
	addEventListener("__pi_cap_k3x9", (e) => {
		try {
			const m = JSON.parse(e.detail);
			if (m.n <= (last[m.i] ?? 0)) return;
			last[m.i] = m.n;
			buf.push(m);
			if (buf.length > 300) buf.shift();
		} catch {}
	});
	// Tell cap-main.js we listen now: it replays what it reported before this script existed (Firefox may run the
	// page-world script first).
	try {
		dispatchEvent(new CustomEvent("__pi_cap_r7"));
	} catch {}
})();
