import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@mariozechner/pi-tui";
import { searchWithFallback, type Recency, type SearchResult } from "./providers.ts";

const SNIPPET_CHARS = 500;

interface SearchParams {
	query: string;
	count?: number;
	site?: string;
	exclude_sites?: string[];
	recency?: Recency;
}

function normalizeDomain(value: string): string {
	let domain = value.trim().replace(/^site:/i, "");
	try {
		domain = new URL(/^[a-z]+:\/\//i.test(domain) ? domain : `https://${domain}`).hostname;
	} catch {}
	return domain.replace(/^www\./, "");
}

function formatResults(provider: string, results: SearchResult[]): string {
	const lines = [`Provider: ${provider} (${results.length} results)`];
	results.forEach((r, i) => {
		let snippet = r.snippet.replace(/\s+/g, " ").trim();
		if (snippet.length > SNIPPET_CHARS) snippet = `${snippet.slice(0, SNIPPET_CHARS)}…`;
		const date = r.date ? ` (${r.date.slice(0, 10)})` : "";
		lines.push(`\n${i + 1}. ${r.title}${date}\n   ${r.url}\n   ${snippet}`);
	});
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web. Returns title, URL, date and snippet per result. " +
			"Tries TinyFish, LangSearch, Exa, then a keyless metasearch, falling back automatically when a provider fails.",
		promptSnippet: "Search the web for current information, docs and sources. One search per call.",
		promptGuidelines: [
			"Use one web_search call per search angle; rephrase rather than repeating the same query.",
			"Then use web_fetch on the one or two most relevant URLs for full content.",
		],

		parameters: Type.Object({
			query: Type.String({ description: "Search query in plain words" }),
			count: Type.Optional(
				Type.Number({ description: "Number of results (default 5)", minimum: 1, maximum: 10 }),
			),
			site: Type.Optional(
				Type.String({ description: "Only return results from this domain, e.g. github.com" }),
			),
			exclude_sites: Type.Optional(
				Type.Array(Type.String(), { description: "Domains to leave out, e.g. [\"pinterest.com\"]" }),
			),
			recency: Type.Optional(
				Type.Union([Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")], {
					description: "Only results published within this period",
				}),
			),
		}),

		async execute(_toolCallId, params: SearchParams, signal) {
			const query = params.query?.trim();
			if (!query) throw new Error("'query' is required.");

			const outcome = await searchWithFallback({
				query,
				count: Math.min(Math.max(Math.round(params.count ?? 5), 1), 10),
				countRequested: params.count !== undefined,
				includeDomains: params.site ? [normalizeDomain(params.site)] : undefined,
				excludeDomains: params.exclude_sites?.map(normalizeDomain).filter(Boolean),
				recency: params.recency,
				signal,
			});

			return {
				content: [{ type: "text" as const, text: formatResults(outcome.provider, outcome.results) }],
				details: {
					query,
					provider: outcome.provider,
					resultCount: outcome.results.length,
					skipped: outcome.skipped,
				},
			};
		},

		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const { query, site, recency } = args as SearchParams;
			if (!query) {
				text.setText(theme.fg("toolTitle", theme.bold("search ")) + theme.fg("error", "(no query)"));
				return text;
			}
			const display = query.length > 70 ? `${query.slice(0, 67)}...` : query;
			const extras = [site && `site:${site}`, recency && `past ${recency}`].filter(Boolean).join(", ");
			text.setText(
				theme.fg("toolTitle", theme.bold("search ")) +
					theme.fg("accent", `"${display}"`) +
					(extras ? theme.fg("dim", ` (${extras})`) : ""),
			);
			return text;
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			if (isPartial) {
				text.setText(theme.fg("warning", "Searching…"));
				return text;
			}
			if (context.isError) {
				text.setText(theme.fg("error", result.content.find((c) => c.type === "text")?.text || "Error"));
				return text;
			}
			const details = result.details as { provider?: string; resultCount?: number; skipped?: string[] };
			const status =
				theme.fg("success", `${details?.resultCount ?? 0} results`) +
				theme.fg("muted", ` via ${details?.provider ?? "?"}`);
			if (!expanded) {
				text.setText(status);
				return text;
			}
			const content = result.content.find((c) => c.type === "text")?.text || "";
			const skipped = details?.skipped?.length ? theme.fg("dim", `skipped: ${details.skipped.join("; ")}`) : "";
			const preview = content.length > 500 ? `${content.slice(0, 500)}...` : content;
			text.setText([status, skipped, theme.fg("dim", preview)].filter(Boolean).join("\n"));
			return text;
		},
	});
}
