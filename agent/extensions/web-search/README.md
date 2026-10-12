# web-search

`web_search` tool for pi: one interface over several search providers, with automatic fallback.

| Order | Provider | Key name | Cost and limits |
|---|---|---|---|
| 1 | [TinyFish](https://docs.tinyfish.ai/search-api/reference) | `TINYFISH_API_KEY` | Free: 30 requests/min, 500/hour |
| 2 | [LangSearch](https://langsearch.com/install/langsearch/SKILL.md) | `LANGSEARCH_API_KEY` | Free: 1M tokens/min (input + output) |
| 3 | [Exa](https://exa.ai/docs/reference/search) | `EXA_API_KEY` | **Paid**: $4 / 1k searches (`instant`) |
| 4 | ddgs | none | Keyless metasearch (DuckDuckGo, Bing, Brave, …); least reliable |

Exa is the only paid provider, so it sits after the two free ones and is only reached when both fail or return nothing. Each Exa search is one `/search` call with `type: "instant"` and `contents: {highlights: true}`; page content comes back inside that call, which is cheaper than separate `/contents` ($1 / 1k) or `/answer` ($5 / 1k) requests, so the extension never uses those.

TinyFish also offers a free Fetch API (150 URLs/min, 1,000 URLs/day) that `web_search` doesn't use.

A provider is skipped when its key is missing; the next one is tried on any error (bad key, 402/429 allowance or rate limits, 5xx, timeout) or an empty result. The tool result says which provider answered; `details.skipped` lists the rest with reasons.

Tool parameters: `query`, `count` (1–10, default 5), `site`, `exclude_sites`, `recency` (`day`/`week`/`month`/`year`).

## Setup

Keys live in the system keyring (libsecret), service `pi-web-search`. The extension looks them up itself, so they are never exported to the shell environment the agent's `bash` commands inherit. Store each key once (it prompts for the value):

```bash
secret-tool store --label="pi web_search: TINYFISH_API_KEY" service pi-web-search key TINYFISH_API_KEY
secret-tool store --label="pi web_search: LANGSEARCH_API_KEY" service pi-web-search key LANGSEARCH_API_KEY
secret-tool store --label="pi web_search: EXA_API_KEY" service pi-web-search key EXA_API_KEY
```

Check: `secret-tool lookup service pi-web-search key EXA_API_KEY`. Remove: `secret-tool clear service pi-web-search key EXA_API_KEY`. A key added mid-session is picked up on the next search. An environment variable of the same name still works as a fallback, but avoid exporting keys globally.

ddgs runs from a local venv:

```bash
cd ~/.pi/agent/extensions/web-search
uv venv .venv && uv pip install --python .venv/bin/python -r requirements.txt
```

## Customizing

- Change the order or drop providers without editing code: `PI_WEB_SEARCH_PROVIDERS="exa,ddgs"`.
- Add a provider: implement `SearchProvider` in `providers.ts` (a name, an optional `keyEnv`, and `search(req, key)` returning `{title, url, snippet, date?}[]`) and add it to `PROVIDERS`.
