/**
 * Env-sourced base URLs are normalized like saved ones (final review): a
 * trailing slash in FIRECRAWL_URL / SEARXNG_URL from .env.local must not
 * produce `//v2/scrape` or `//search`. Stub fetch only — no network. The
 * data dir and auth file are redirected to a tmp dir BEFORE the imports.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-base-url-"));
process.env.LH_DATA_DIR = path.join(TMP, "data");
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
delete process.env.LH_IGNORE_ENV_KEYS;

const { baseUrlValue } = await import("../src/server/keys.ts");
const { pageFetcher } = await import("../src/server/firecrawl.ts");
const { searchProvider } = await import("../src/server/search.ts");

const ENV_IDS = ["FIRECRAWL_URL", "FIRECRAWL_API_KEY", "SEARXNG_URL", "TAVILY_API_KEY", "BRAVE_API_KEY"] as const;
const saved = Object.fromEntries(ENV_IDS.map((id) => [id, process.env[id]]));
for (const id of ENV_IDS) delete process.env[id];
const originalFetch = globalThis.fetch;

function restore() {
	for (const id of ENV_IDS) {
		if (saved[id] === undefined) delete process.env[id];
		else process.env[id] = saved[id];
	}
	globalThis.fetch = originalFetch;
}

afterEach(() => {
	for (const id of ENV_IDS) delete process.env[id];
	globalThis.fetch = originalFetch;
});
after(() => {
	restore();
	fs.rmSync(TMP, { recursive: true, force: true });
});

function stubGlobalFetch(body: unknown): string[] {
	const urls: string[] = [];
	globalThis.fetch = (async (input: string | URL | Request) => {
		urls.push(String(input));
		return Response.json(body);
	}) as typeof fetch;
	return urls;
}

describe("baseUrlValue", () => {
	it("normalizes a valid env URL, passes an invalid one through raw, and is undefined when unset", () => {
		assert.equal(baseUrlValue("SEARXNG_URL"), undefined);
		process.env.SEARXNG_URL = " https://s.example/ ";
		assert.equal(baseUrlValue("SEARXNG_URL"), "https://s.example");
		process.env.SEARXNG_URL = "not a url";
		assert.equal(baseUrlValue("SEARXNG_URL"), "not a url");
	});
});

describe("env-sourced base URLs", () => {
	it("pageFetcher() posts to <FIRECRAWL_URL without slash>/v2/scrape", async () => {
		process.env.FIRECRAWL_URL = "https://f.example/";
		const urls = stubGlobalFetch({ success: true, data: { markdown: "# hi", metadata: {} } });
		const fetcher = pageFetcher();
		assert.ok(fetcher);
		await fetcher.fetch("https://page.example/");
		assert.deepEqual(urls, ["https://f.example/v2/scrape"]);
	});

	it("SearXNG resolution requests <SEARXNG_URL without slash>/search?...", async () => {
		process.env.SEARXNG_URL = "https://s.example/";
		const urls = stubGlobalFetch({ results: [] });
		const provider = searchProvider();
		assert.equal(provider?.id, "searxng");
		await provider.search("q", 3);
		assert.equal(urls.length, 1);
		assert.ok(urls[0]!.startsWith("https://s.example/search?"), urls[0]);
	});
});
