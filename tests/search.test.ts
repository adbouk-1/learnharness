/**
 * The search engines (search port + model slots wave, 2026-09-20):
 * engine resolution (the owner's auto-detect decision — a key is enough,
 * no engine choice needed; explicit pin requires the key; no silent
 * fallback) + the Tavily/Brave adapters against a STUB fetch (never the
 * network — the wire shapes are verified against the published docs, and
 * the tests pin those shapes).
 *
 * PURE + injected fetch — this file owns no fs.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveSearchEngineFor, tavilyProvider, braveProvider, searxngProvider } from "../src/server/search.ts";

describe("resolveSearchEngineFor (the auto-detect decision)", () => {
	it("no keys: honestly unavailable, no default", () => {
		const out = resolveSearchEngineFor(undefined, {});
		assert.ok(!out.available);
		assert.equal(out.engine, null);
		assert.match(out.reason, /no search engine configured/i);
	});

	it("a key alone is enough — no engine choice needed", () => {
		const tav = resolveSearchEngineFor(undefined, { tavily: "tvly-throwaway-key-00001" });
		assert.ok(tav.available);
		assert.equal(tav.engine, "tavily");
		assert.match(tav.reason, /auto/);

		const brv = resolveSearchEngineFor(undefined, { brave: "brave-throwaway-key-00001" });
		assert.ok(brv.available);
		assert.equal(brv.engine, "brave");
	});

	it("both keys, no pin: preference order — Tavily first (owner decision)", () => {
		const out = resolveSearchEngineFor(undefined, {
			tavily: "tvly-throwaway-key-00001",
			brave: "brave-throwaway-key-00001",
		});
		assert.ok(out.available);
		assert.equal(out.engine, "tavily");
	});

	it("the explicit pin wins when its key is present", () => {
		const out = resolveSearchEngineFor("brave", {
			tavily: "tvly-throwaway-key-00001",
			brave: "brave-throwaway-key-00001",
		});
		assert.ok(out.available);
		assert.equal(out.engine, "brave");
		assert.match(out.reason, /chosen/);
	});

	it("the explicit pin does NOT silently fall back to the other engine", () => {
		const out = resolveSearchEngineFor("tavily", { brave: "brave-throwaway-key-00001" });
		assert.ok(!out.available);
		assert.equal(out.engine, null);
		assert.match(out.reason, /tavily/);
		assert.match(out.reason, /API key is missing/);
	});

	it("SearXNG alone auto-activates", () => {
		const out = resolveSearchEngineFor(undefined, { searxng: "https://s.example" });
		assert.equal(out.engine, "searxng");
	});

	it("with all three configured and no pin, SearXNG wins", () => {
		const out = resolveSearchEngineFor(undefined, {
			searxng: "https://s.example",
			tavily: "tvly-throwaway-key-00001",
			brave: "brave-throwaway-key-00001",
		});
		assert.equal(out.engine, "searxng");
	});

	it("pinned searxng without a URL is honestly unavailable and names SEARXNG_URL", () => {
		const out = resolveSearchEngineFor("searxng", { tavily: "tvly-throwaway-key-00001" });
		assert.equal(out.available, false);
		assert.match(out.reason, /SEARXNG_URL/);
	});
});

/** A one-shot stub fetch: asserts the request shape and returns the canned response. */
function stubFetch(canned: unknown, expect: (url: string, init: RequestInit) => void) {
	return async (url: string, init: RequestInit): Promise<Response> => {
		expect(url, init);
		return new Response(JSON.stringify(canned), { status: 200 });
	};
}

describe("tavilyProvider (wire shape per docs.tavily.com, verified 2026-09-20)", () => {
	it("POSTs api.tavily.com/search with Bearer auth + the query body", async () => {
		const provider = tavilyProvider("tvly-throwaway-key-00001", stubFetch(
			{
				results: [
					{ title: "Example", url: "https://example.com/a", content: "line1\nline2" },
					{ title: "No URL", content: "dropped" },
				],
			},
			(url, init) => {
				assert.equal(url, "https://api.tavily.com/search");
				assert.equal(init.method, "POST");
				const headers = init.headers as Record<string, string>;
				assert.equal(headers.authorization, "Bearer tvly-throwaway-key-00001");
				const body = JSON.parse(init.body as string);
				assert.equal(body.query, "test query");
				assert.equal(body.max_results, 5);
				// The legacy api_key-in-body form is retired — auth is the header.
				assert.equal(body.api_key, undefined);
			},
		));
		const hits = await provider.search("test query", 5);
		assert.deepEqual(hits, [{ title: "Example", url: "https://example.com/a", snippet: "line1 line2" }]);
	});

	it("maps the {detail:{error}} error body into the message", async () => {
		const provider = tavilyProvider("tvly-throwaway-key-00001", async () =>
			new Response(JSON.stringify({ detail: { error: "Unauthorized: missing or invalid API key." } }), { status: 401 }),
		);
		await assert.rejects(provider.search("q", 5), /Tavily search API 401: Unauthorized/);
	});
});

describe("braveProvider (wire shape per Brave's dashboard docs, verified 2026-09-20)", () => {
	it("GETs res/v1/web/search with the X-Subscription-Token header", async () => {
		const provider = braveProvider("brave-throwaway-key-00001", stubFetch(
			{
				web: {
					results: [
						{ title: "Example", url: "https://example.com/b", description: "a description" },
						{ description: "dropped — no url" },
					],
				},
			},
			(url, init) => {
				assert.ok(url.startsWith("https://api.search.brave.com/res/v1/web/search?"), url);
				assert.ok(url.includes("q=test+query"), url); // URLSearchParams: spaces as +
				assert.ok(url.includes("count=5"));
				const headers = init.headers as Record<string, string>;
				assert.equal(headers["x-subscription-token"], "brave-throwaway-key-00001");
			},
		));
		const hits = await provider.search("test query", 5);
		assert.deepEqual(hits, [{ title: "Example", url: "https://example.com/b", snippet: "a description" }]);
	});

	it("surfaces the HTTP status on failure", async () => {
		const provider = braveProvider("brave-throwaway-key-00001", async () =>
			new Response("rate limited", { status: 429 }),
		);
		await assert.rejects(provider.search("q", 5), /Brave search API 429/);
	});
});

describe("searxngProvider (GET <base>/search?q=…&format=json)", () => {
	it("GETs /search with q + format=json and maps results to hits", async () => {
		let seen = "";
		let accept: string | undefined;
		const provider = searxngProvider("https://s.example", async (url, init) => {
			seen = url;
			accept = (init.headers as Record<string, string>).accept;
			return new Response(
				JSON.stringify({ results: [{ title: "T", url: "https://x/", content: "line1\nline2" }] }),
				{ status: 200 },
			);
		});
		const hits = await provider.search("a b", 5);
		assert.ok(seen.startsWith("https://s.example/search?"), seen);
		assert.equal(new URL(seen).searchParams.get("q"), "a b");
		assert.ok(seen.includes("q=a+b"), seen);
		assert.equal(new URL(seen).searchParams.get("format"), "json");
		assert.equal(accept, "application/json");
		assert.deepEqual(hits, [{ title: "T", url: "https://x/", snippet: "line1 line2" }]);
	});

	it("slices to count (SearXNG has no count parameter)", async () => {
		const results = Array.from({ length: 8 }, (_, i) => ({ title: `T${i}`, url: `https://x/${i}`, content: "c" }));
		const provider = searxngProvider("https://s.example", stubFetch({ results }, () => {}));
		const hits = await provider.search("q", 3);
		assert.equal(hits.length, 3);
		assert.equal(hits[2]?.url, "https://x/2");
	});

	it("drops results without a url", async () => {
		const provider = searxngProvider("https://s.example", stubFetch(
			{ results: [{ title: "no url", content: "dropped" }, { title: "ok", url: "https://x/ok", content: "" }] },
			() => {},
		));
		const hits = await provider.search("q", 5);
		assert.deepEqual(hits, [{ title: "ok", url: "https://x/ok", snippet: "" }]);
	});

	it("HTTP 403 tells the operator to enable the json format", async () => {
		const provider = searxngProvider("https://s.example", async () => new Response("Forbidden", { status: 403 }));
		await assert.rejects(provider.search("q", 5), (err: unknown) => {
			assert.ok(err instanceof Error);
			assert.match(err.message, /search\.formats/);
			return true;
		});
	});

	it("other non-2xx surfaces the status and a body slice", async () => {
		const provider = searxngProvider("https://s.example", async () => new Response("upstream broke", { status: 502 }));
		await assert.rejects(provider.search("q", 5), /SearXNG search 502: upstream broke/);
	});

	it("a network failure is wrapped with the engine name", async () => {
		const provider = searxngProvider("https://s.example", async () => {
			throw new TypeError("fetch failed");
		});
		await assert.rejects(provider.search("q", 5), (err: unknown) => {
			assert.ok(err instanceof Error);
			assert.match(err.message, /SearXNG/);
			assert.match(err.message, /fetch failed/);
			return true;
		});
	});
});
