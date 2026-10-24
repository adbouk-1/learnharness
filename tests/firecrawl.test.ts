/** Firecrawl page-fetcher adapter (home-stack integration). Stub fetch only —
 *  no network. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { firecrawlFetcher } from "../src/server/firecrawl.ts";

type Call = { url: string; init: RequestInit };

function stubFetch(respond: () => Response | Promise<Response>): { calls: Call[]; fn: (u: string, i: RequestInit) => Promise<Response> } {
	const calls: Call[] = [];
	return {
		calls,
		fn: async (url, init) => {
			calls.push({ url, init });
			return respond();
		},
	};
}

const OK_BODY = {
	success: true,
	data: {
		markdown: "# Body\n\ntext",
		metadata: { title: "T", sourceURL: "https://x/", url: "https://x/final", statusCode: 200, contentType: "text/html" },
	},
};

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("firecrawlFetcher", () => {
	it("POSTs the scrape request with a Bearer key when one is given", async () => {
		const stub = stubFetch(() => json(OK_BODY));
		await firecrawlFetcher("https://f.example", "k-123456789012", stub.fn).fetch("https://x/");
		assert.equal(stub.calls.length, 1);
		assert.equal(stub.calls[0]!.url, "https://f.example/v2/scrape");
		const init = stub.calls[0]!.init;
		assert.equal(init.method, "POST");
		const headers = init.headers as Record<string, string>;
		assert.equal(headers["content-type"], "application/json");
		assert.equal(headers.authorization, "Bearer k-123456789012");
		assert.deepEqual(JSON.parse(String(init.body)), { url: "https://x/", formats: ["markdown"], onlyMainContent: true });
		assert.ok(init.signal, "bounded by a timeout signal");
	});

	it("sends no authorization header without an API key", async () => {
		const stub = stubFetch(() => json(OK_BODY));
		await firecrawlFetcher("https://f.example", undefined, stub.fn).fetch("https://x/");
		const headers = stub.calls[0]!.init.headers as Record<string, string>;
		assert.equal("authorization" in headers, false);
	});

	it("maps the response onto a FetchedPage", async () => {
		const page = await firecrawlFetcher("https://f.example", undefined, stubFetch(() => json(OK_BODY)).fn).fetch("https://x/");
		assert.deepEqual(page, {
			title: "T",
			markdown: "# Body\n\ntext",
			finalUrl: "https://x/final",
			status: 200,
			contentType: "text/html",
		});
	});

	it("finalUrl prefers metadata.url, then sourceURL, then the requested URL", async () => {
		const mk = (metadata: Record<string, unknown>) =>
			firecrawlFetcher(
				"https://f.example",
				undefined,
				stubFetch(() => json({ success: true, data: { markdown: "m", metadata } })).fn,
			).fetch("https://req/");
		assert.equal((await mk({ url: "https://u/", sourceURL: "https://s/" })).finalUrl, "https://u/");
		assert.equal((await mk({ sourceURL: "https://s/" })).finalUrl, "https://s/");
		const bare = await mk({});
		assert.equal(bare.finalUrl, "https://req/");
		assert.equal(bare.title, "");
		assert.equal(bare.status, 200);
		assert.equal(bare.contentType, null);
	});

	it("rejects on a non-2xx response", async () => {
		const f = firecrawlFetcher("https://f.example", undefined, stubFetch(() => new Response("nope", { status: 502 })).fn);
		await assert.rejects(f.fetch("https://x/"), /^Error: Firecrawl 502: nope/);
	});

	it("rejects on success:false", async () => {
		const f = firecrawlFetcher("https://f.example", undefined, stubFetch(() => json({ success: false, error: "blocked" })).fn);
		await assert.rejects(f.fetch("https://x/"), /^Error: Firecrawl reported failure: blocked/);
	});

	it("rejects on a network TypeError", async () => {
		const f = firecrawlFetcher("https://f.example", undefined, async () => {
			throw new TypeError("fetch failed");
		});
		await assert.rejects(f.fetch("https://x/"), /^Error: Firecrawl request failed: fetch failed/);
	});
});
