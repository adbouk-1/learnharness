/**
 * The search engines' server composition (search port + model slots wave,
 * 2026-09-20): the Tavily + Brave adapters (+ SearXNG, home-stack
 * integration) behind the core port (core/search.ts) + the live-engine
 * resolution the settings UI and the agent-layer tool both read.
 *
 * Owner decisions (2026-09-20) baked in:
 *  - NO default engine: an engine is live iff its key is present (auth
 *    store or env — env wins, keyed via server/keys.ts keyValue).
 *  - Setting a key is ALL the user does — auto-detection: explicit
 *    agent.search.engine pins the preference (when several engines are live
 *    the preference order is SearXNG → Tavily → Brave); without a pin,
 *    whichever engine has a key is the engine.
 *  - An explicit choice does NOT silently fall back to the other engine:
 *    engine pinned but its key missing = honestly unavailable (reason
 *    says so) — no guessing what the user meant.
 *
 * The adapters are injected dependencies (fetch-shaped) so the agent-layer
 * tool depends on the PORT only and tests never touch the network.
 */

import type { SearchEngineId, SearchHit, SearchProvider, SearchStatus } from "../core/search.ts";
import { baseUrlValue, keyValue } from "./keys.ts";
import { effectiveSettings } from "./stores.ts";

/** The wire-callable shape the adapters close over (tests inject a stub). */
type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Tavily: POST https://api.tavily.com/search — Bearer auth in the
 *  Authorization header (the current documented scheme; the legacy
 *  api_key-in-body form is retired), query + max_results (0–20) in the
 *  JSON body. VERIFIED against docs.tavily.com's OpenAPI, 2026-09-20:
 *  response {results: [{title, url, content, score, …}]}, errors
 *  {detail: {error}}. */
export function tavilyProvider(apiKey: string, fetchFn: FetchLike = fetch): SearchProvider {
	return {
		id: "tavily",
		async search(query: string, count: number): Promise<SearchHit[]> {
			const resp = await fetchFn("https://api.tavily.com/search", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({ query, max_results: Math.min(count, 20) }),
				signal: AbortSignal.timeout(30_000),
			});
			if (!resp.ok) {
				const body = await resp.text();
				// Their error body is {detail: {error: "…"}} — surface the
				// message when present, else the raw slice.
				let detail = body.slice(0, 200);
				try {
					const parsed = JSON.parse(body) as { detail?: { error?: string } };
					if (parsed.detail?.error) detail = parsed.detail.error.slice(0, 200);
				} catch {
					/* keep the raw slice */
				}
				throw new Error(`Tavily search API ${resp.status}: ${detail}`);
			}
			const data = (await resp.json()) as {
				results?: Array<{ title?: string; url?: string; content?: string }>;
			};
			return (data.results ?? [])
				.filter((r) => typeof r.url === "string" && r.url)
				.map((r) => ({
					title: r.title ?? r.url ?? "",
					url: r.url ?? "",
					snippet: (r.content ?? "").replace(/\n/g, " ").slice(0, 500),
				}));
		},
	};
}

/** Brave: GET https://api.search.brave.com/res/v1/web/search with the
 *  key in the X-Subscription-Token header. VERIFIED against Brave's
 *  dashboard docs, 2026-09-20: count max 20; response
 *  {web: {results: [{title, url, description, …}]}}. */
export function braveProvider(apiKey: string, fetchFn: FetchLike = fetch): SearchProvider {
	return {
		id: "brave",
		async search(query: string, count: number): Promise<SearchHit[]> {
			const url = new URL("https://api.search.brave.com/res/v1/web/search");
			url.searchParams.set("q", query);
			url.searchParams.set("count", String(Math.min(count, 20)));
			const resp = await fetchFn(url.toString(), {
				headers: {
					accept: "application/json",
					"x-subscription-token": apiKey,
				},
				signal: AbortSignal.timeout(30_000),
			});
			if (!resp.ok) {
				const body = await resp.text();
				throw new Error(`Brave search API ${resp.status}: ${body.slice(0, 200)}`);
			}
			const data = (await resp.json()) as {
				web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
			};
			return (data.web?.results ?? [])
				.filter((r) => typeof r.url === "string" && r.url)
				.map((r) => ({
					title: r.title ?? r.url ?? "",
					url: r.url ?? "",
					snippet: (r.description ?? "").replace(/\n/g, " ").slice(0, 500),
				}));
		},
	};
}

/** SearXNG (self-hosted metasearch): GET <baseUrl>/search?q=…&format=json.
 *  `baseUrl` is the stored SEARXNG_URL, already normalized (http(s), no
 *  trailing slash/path/query/hash — server/keys.ts normalizeBaseUrl). The
 *  instance must list "json" under search.formats in settings.yml, else it
 *  answers 403. SearXNG has no result-count parameter, so `count` slices
 *  the response; response {results: [{title, url, content, …}]}. */
export function searxngProvider(baseUrl: string, fetchFn: FetchLike = fetch): SearchProvider {
	return {
		id: "searxng",
		async search(query: string, count: number): Promise<SearchHit[]> {
			const url = new URL(`${baseUrl}/search`);
			url.searchParams.set("q", query);
			url.searchParams.set("format", "json");
			let resp: Response;
			try {
				resp = await fetchFn(url.toString(), {
					headers: { accept: "application/json" },
					signal: AbortSignal.timeout(30_000),
				});
			} catch (err) {
				throw new Error(`SearXNG request failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			if (!resp.ok) {
				if (resp.status === 403) {
					throw new Error('SearXNG returned 403 — enable "json" under search.formats in settings.yml');
				}
				const body = await resp.text();
				throw new Error(`SearXNG search ${resp.status}: ${body.slice(0, 200)}`);
			}
			const data = (await resp.json()) as {
				results?: Array<{ title?: string; url?: string; content?: string }>;
			};
			return (data.results ?? [])
				.filter((r) => typeof r.url === "string" && r.url)
				.slice(0, count)
				.map((r) => ({
					title: r.title ?? r.url ?? "",
					url: r.url ?? "",
					snippet: (r.content ?? "").replace(/\n/g, " ").slice(0, 500),
				}));
		},
	};
}

/** The engines, in PREFERENCE order (several live, no explicit pin → the
 *  first live engine wins; owner decision 2026-09-20: Tavily over Brave;
 *  home-stack integration: the self-hosted SearXNG ahead of both). For
 *  SearXNG the "key" is its URL (SEARXNG_URL). */
const ENGINE_ORDER: ReadonlyArray<{ id: SearchEngineId; envVar: string }> = [
	{ id: "searxng", envVar: "SEARXNG_URL" },
	{ id: "tavily", envVar: "TAVILY_API_KEY" },
	{ id: "brave", envVar: "BRAVE_API_KEY" },
];

/** The engine's key (env-or-file; env wins) — null when the engine is
 *  not keyed, which by owner decision means NOT LIVE. */
function engineKey(id: SearchEngineId): string | null {
	const envVar = ENGINE_ORDER.find((e) => e.id === id)?.envVar;
	const value = envVar ? (id === "searxng" ? baseUrlValue(envVar) : keyValue(envVar)) : undefined;
	return value ? value : null;
}

/** Resolve the search state PURELY from the given pins (testable): the
 *  explicit engine (if pinned) wins but must be keyed; absent pin → first
 *  keyed engine in preference order. Never throws. */
export function resolveSearchEngineFor(
	pinned: SearchEngineId | undefined,
	/** Per-engine live keys (absent engine = absent property is fine). */
	keys: Partial<Record<SearchEngineId, string | undefined>>,
): SearchStatus & { key: string | null } {
	const pinnedKey = pinned ? keys[pinned] ?? null : null;
	if (pinned) {
		if (!pinnedKey) {
			const envVar = ENGINE_ORDER.find((e) => e.id === pinned)?.envVar;
			return {
				available: false,
				engine: null,
				reason: `search engine is set to "${pinned}" but its API key is missing — set the ${envVar} key`,
				key: null,
			};
		}
		return { available: true, engine: pinned, reason: `search engine: ${pinned} (chosen)`, key: pinnedKey };
	}
	for (const { id } of ENGINE_ORDER) {
		const key = keys[id] ?? null;
		if (key) return { available: true, engine: id, reason: `search engine: ${id} (auto)`, key };
	}
	return {
		available: false,
		engine: null,
		reason: "no search engine configured — set a SearXNG URL or a Tavily or Brave search API key",
		key: null,
	};
}

/** The live search state (the honest availability signal): reads the
 *  settings record's pin + the auth store fresh each call, so a key saved
 *  mid-session activates on the next check (no restart). */
export function searchStatus(): SearchStatus {
	const { available, engine, reason } = resolveSearchEngineFor(
		effectiveSettings().agent.search?.engine,
		{
			searxng: engineKey("searxng") ?? undefined,
			tavily: engineKey("tavily") ?? undefined,
			brave: engineKey("brave") ?? undefined,
		},
	);
	return { available, engine, reason };
}

/** Search available at all? (the settings UI's gray-out signal + the
 *  researcher's enable/disable pin — Teacher stream's rewiring reads this.) */
export function searchAvailable(): boolean {
	return searchStatus().available;
}

/** The LIVE adapter, or null when unavailable. Composed fresh each call —
 *  the tool layer (Teacher stream) calls this once per search, so key
 *  rotations take effect immediately. */
export function searchProvider(): SearchProvider | null {
	const resolved = resolveSearchEngineFor(effectiveSettings().agent.search?.engine, {
		searxng: engineKey("searxng") ?? undefined,
		tavily: engineKey("tavily") ?? undefined,
		brave: engineKey("brave") ?? undefined,
	});
	if (!resolved.available || !resolved.key) return null;
	if (resolved.engine === "searxng") return searxngProvider(resolved.key);
	return resolved.engine === "tavily" ? tavilyProvider(resolved.key) : braveProvider(resolved.key);
}
