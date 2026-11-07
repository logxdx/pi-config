import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Serves the fixtures on two ports (two origins) and records /log events. Usage: startFixtures(portA, portB)
const here = path.dirname(fileURLToPath(import.meta.url));
export const events = [];
export function startFixtures(A, B) {
	const handler = (req, res) => {
		const u = new URL(req.url, "http://x");
		res.setHeader("Access-Control-Allow-Origin", "*");
		if (u.pathname === "/log") {
			events.push(Object.fromEntries(u.searchParams));
			return res.writeHead(204).end();
		}
		if (u.pathname === "/events") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(events));
		const f = path.join(here, u.pathname === "/" ? "frames.html" : u.pathname.slice(1));
		if (!/^[\w.-]+\.html$/.test(path.basename(f)) || !existsSync(f)) return res.writeHead(404, { "content-type": "text/plain" }).end("not found");
		res.writeHead(200, { "content-type": "text/html" }).end(readFileSync(f, "utf8").replaceAll("__A__", A).replaceAll("__B__", B));
	};
	const servers = [http.createServer(handler).listen(A, "127.0.0.1"), http.createServer(handler).listen(B, "127.0.0.1")];
	return () => servers.forEach((s) => s.close());
}
