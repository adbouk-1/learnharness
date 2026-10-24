/**
 * The Ollama Cloud catalog lifecycle (home stack integration, 2026-10-24):
 * fetch from /api/tags + /api/show, persist the last good copy, install it
 * at startup without network, refresh when stale, surface status. Every
 * fetch is a stub (the `fetchFn` seam) — nothing touches the network. The
 * data dir and auth file are redirected to a tmp dir BEFORE the imports
 * (both seams are module-load bound), so nothing lands in the repo's data/.
 * All key values are throwaway test strings.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it, mock } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ollama-catalog-"));
process.env.LH_DATA_DIR = path.join(TMP, "data");
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
delete process.env.OLLAMA_API_KEY;
delete process.env.OLLAMA_BASE_URL;
delete process.env.LH_IGNORE_ENV_KEYS;

const { piModels } = await import("../src/agent/models.ts");
const { installOllamaCatalog, ollamaModels } = await import("../src/agent/ollama-cloud.ts");
const { PATHS } = await import("../config.ts");
const { readOllamaCatalog, writeOllamaCatalog } = await import("../src/store/ollama-catalog.ts");
const { bootRefreshEnabled, ensureOllamaCatalog, fetchOllamaCatalog, ollamaBaseUrl, ollamaCatalogStatus, refreshOllamaCatalog } =
	await import("../src/server/ollama-cloud.ts");
const { catalogProviders, refreshConnectionCatalog, refreshPickerCatalogs, validateModelsSettings } = await import(
	"../src/server/model-catalog.ts"
);

const FILE = path.join(PATHS.catalogs, "ollama-cloud.json");
const BASE = "https://ollama.com";
const KEY = "ollama-throwaway-key-0123456789";

// A failed refresh logs its error (console.warn). Capture it so deliberate
// failures keep the test output pristine and the log itself is assertable.
const warnings: string[] = [];
mock.method(console, "warn", (message: unknown) => {
	warnings.push(String(message));
});

after(() => {
	mock.restoreAll();
	installOllamaCatalog([], BASE);
	delete process.env.OLLAMA_API_KEY;
	delete process.env.OLLAMA_BASE_URL;
	fs.rmSync(TMP, { recursive: true, force: true });
});

const TAGS = {
	models: [
		{ name: "gpt-oss:120b", capabilities: ["completion", "tools", "thinking"] },
		{ name: "gemma4:31b", capabilities: ["completion", "tools", "thinking", "vision"] },
		{ name: "embed:small", capabilities: ["embedding"] },
	],
};

const SHOW: Record<string, unknown> = {
	"gpt-oss:120b": {
		capabilities: ["completion", "tools", "thinking"],
		model_info: { "general.architecture": "gptoss", "gptoss.context_length": 131072 },
		thinking: { values: ["low", "medium", "high"], default: "medium" },
	},
	"gemma4:31b": {
		capabilities: ["completion", "tools", "thinking", "vision"],
		model_info: { "gemma4.context_length": 262144 },
		thinking: { values: [false, true], default: true },
	},
};

type Call = { url: string; method: string; body: string | null };

/** A stub Ollama: /api/tags lists TAGS, /api/show answers from SHOW (500 for
 *  anything not in SHOW and not listed in `failShow` as a clean failure). */
function stubOllama(opts: { failTags?: Error } = {}) {
	const calls: Call[] = [];
	const fetchFn = async (input: string, init: RequestInit): Promise<Response> => {
		calls.push({ url: input, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : null });
		if (opts.failTags) throw opts.failTags;
		if (input.endsWith("/api/tags")) return Response.json(TAGS);
		if (input.endsWith("/api/show")) {
			const { model } = JSON.parse(String(init.body)) as { model: string };
			const body = SHOW[model];
			return body ? Response.json(body) : new Response("boom", { status: 500 });
		}
		return new Response("not found", { status: 404 });
	};
	return { calls, fetchFn };
}

function reset() {
	warnings.length = 0;
	installOllamaCatalog([], BASE);
	delete process.env.OLLAMA_API_KEY;
	delete process.env.OLLAMA_BASE_URL;
	fs.rmSync(PATHS.catalogs, { recursive: true, force: true });
	ensureOllamaCatalog({ again: true });
}

describe("Ollama catalog store", () => {
	beforeEach(reset);

	it("round-trips and returns null for missing or invalid files", () => {
		assert.equal(readOllamaCatalog(), null);
		const stored = { version: 1 as const, baseUrl: BASE, fetchedAt: 123, entries: [{ id: "a:1", capabilities: ["tools"], contextLength: 8, thinkingValues: null }] };
		writeOllamaCatalog(stored);
		assert.deepEqual(readOllamaCatalog(), stored);
		fs.writeFileSync(FILE, "{not json");
		assert.equal(readOllamaCatalog(), null);
		fs.writeFileSync(FILE, JSON.stringify({ version: 2, baseUrl: BASE, fetchedAt: 1, entries: [] }));
		assert.equal(readOllamaCatalog(), null, "unknown version is invalid");
		fs.writeFileSync(FILE, JSON.stringify({ version: 1, baseUrl: BASE, fetchedAt: 1, entries: [{ id: 5 }] }));
		assert.equal(readOllamaCatalog(), null, "malformed entry is invalid");
	});
});

describe("fetchOllamaCatalog", () => {
	it("reads /api/tags, then POSTs /api/show per model", async () => {
		const { calls, fetchFn } = stubOllama();
		const entries = await fetchOllamaCatalog(BASE, fetchFn);
		assert.equal(calls[0]?.url, `${BASE}/api/tags`);
		const shows = calls.filter((c) => c.url === `${BASE}/api/show`);
		assert.equal(shows.length, 3);
		assert.ok(shows.every((c) => c.method === "POST"));
		assert.deepEqual(shows.map((c) => JSON.parse(c.body!).model).sort(), ["embed:small", "gemma4:31b", "gpt-oss:120b"]);
		const byId = Object.fromEntries(entries.map((e) => [e.id, e]));
		assert.deepEqual(byId["gpt-oss:120b"], {
			id: "gpt-oss:120b",
			capabilities: ["completion", "tools", "thinking"],
			contextLength: 131072,
			thinkingValues: ["low", "medium", "high"],
		});
		assert.equal(byId["gemma4:31b"]?.contextLength, 262144);
		assert.deepEqual(byId["gemma4:31b"]?.thinkingValues, [false, true]);
	});

	it("a failed /api/show keeps the model with null details", async () => {
		const { fetchFn } = stubOllama();
		const entries = await fetchOllamaCatalog(BASE, fetchFn);
		const embed = entries.find((e) => e.id === "embed:small")!;
		assert.deepEqual(embed, { id: "embed:small", capabilities: ["embedding"], contextLength: null, thinkingValues: null });
	});

	it("a failed /api/tags rejects", async () => {
		const { fetchFn } = stubOllama({ failTags: new TypeError("fetch failed") });
		await assert.rejects(() => fetchOllamaCatalog(BASE, fetchFn), /fetch failed/);
	});
});

describe("ollamaBaseUrl", () => {
	beforeEach(reset);

	it("defaults, normalizes OLLAMA_BASE_URL, and ignores an invalid one", () => {
		assert.equal(ollamaBaseUrl(), BASE);
		process.env.OLLAMA_BASE_URL = " http://10.0.0.5:11434/ ";
		assert.equal(ollamaBaseUrl(), "http://10.0.0.5:11434");
		process.env.OLLAMA_BASE_URL = "not a url";
		assert.equal(ollamaBaseUrl(), BASE);
	});
});

describe("Ollama catalog refresh", () => {
	beforeEach(reset);

	it("force with no key present does nothing and leaves error null", async () => {
		const { calls, fetchFn } = stubOllama();
		await refreshOllamaCatalog({ force: true, fetchFn });
		assert.equal(calls.length, 0);
		assert.equal(ollamaCatalogStatus().error, null);
		assert.equal(ollamaCatalogStatus().models, 0);
	});

	it("with a key: writes the file, installs the models, sets refreshedAt", async () => {
		process.env.OLLAMA_API_KEY = KEY;
		const { fetchFn } = stubOllama();
		await refreshOllamaCatalog({ force: true, fetchFn, now: () => 1_000 });
		const stored = readOllamaCatalog()!;
		assert.equal(stored.fetchedAt, 1_000);
		assert.equal(stored.baseUrl, BASE);
		assert.equal(stored.entries.length, 3);
		assert.deepEqual(ollamaModels().map((m) => m.id).sort(), ["gemma4:31b", "gpt-oss:120b"], "embed-only model has no tools");
		assert.deepEqual(ollamaCatalogStatus(), { models: 2, refreshedAt: 1_000, error: null });
	});

	it("non-forced refresh within 10 minutes skips fetch; after 10 minutes it fetches", async () => {
		process.env.OLLAMA_API_KEY = KEY;
		const { calls, fetchFn } = stubOllama();
		await refreshOllamaCatalog({ force: true, fetchFn, now: () => 0 });
		const after1 = calls.length;
		await refreshOllamaCatalog({ fetchFn, now: () => 5 * 60_000 });
		assert.equal(calls.length, after1, "fresh: no fetch");
		await refreshOllamaCatalog({ fetchFn, now: () => 10 * 60_000 + 1 });
		assert.ok(calls.length > after1, "stale: fetched");
		assert.equal(ollamaCatalogStatus().refreshedAt, 10 * 60_000 + 1);
	});

	it("concurrent refreshes share one fetch", async () => {
		process.env.OLLAMA_API_KEY = KEY;
		const { calls, fetchFn } = stubOllama();
		await Promise.all([
			refreshOllamaCatalog({ force: true, fetchFn }),
			refreshOllamaCatalog({ force: true, fetchFn }),
		]);
		assert.equal(calls.filter((c) => c.url.endsWith("/api/tags")).length, 1);
	});

	it("a failed refresh after a good one keeps models and file, and records the error", async () => {
		process.env.OLLAMA_API_KEY = KEY;
		await refreshOllamaCatalog({ force: true, fetchFn: stubOllama().fetchFn, now: () => 50 });
		const bad = stubOllama({ failTags: new TypeError("fetch failed") });
		await refreshOllamaCatalog({ force: true, fetchFn: bad.fetchFn, now: () => 60 });
		const status = ollamaCatalogStatus();
		assert.equal(status.models, 2);
		assert.equal(status.refreshedAt, 50);
		assert.match(status.error ?? "", /^Ollama catalog refresh failed/);
		assert.match(status.error ?? "", /fetch failed/);
		assert.deepEqual(warnings, [status.error], "the failure is logged once, verbatim");
		assert.equal(readOllamaCatalog()!.fetchedAt, 50);
		// A later good refresh clears the error.
		await refreshOllamaCatalog({ force: true, fetchFn: stubOllama().fetchFn, now: () => 70 });
		assert.equal(ollamaCatalogStatus().error, null);
	});

	it("a hung host is abandoned at the overall deadline; installed models and file survive", async () => {
		process.env.OLLAMA_API_KEY = KEY;
		await refreshOllamaCatalog({ force: true, fetchFn: stubOllama().fetchFn, now: () => 10 });
		// Answers /api/tags, then hangs every /api/show until its signal aborts.
		const hung = async (input: string, init: RequestInit): Promise<Response> => {
			if (input.endsWith("/api/tags")) return Response.json(TAGS);
			return new Promise<Response>((_, reject) => {
				init.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")));
			});
		};
		const started = Date.now();
		await refreshOllamaCatalog({ force: true, fetchFn: hung, now: () => 20, deadlineMs: 50 });
		assert.ok(Date.now() - started < 5_000, "returned at the deadline, not after per-request timeouts");
		const status = ollamaCatalogStatus();
		assert.match(status.error ?? "", /^Ollama catalog refresh failed/);
		assert.equal(status.refreshedAt, 10, "no half-fetched catalog was installed");
		assert.equal(status.models, 2);
		assert.equal(readOllamaCatalog()!.fetchedAt, 10);
	});

	it("a failed non-forced refresh backs off instead of retrying on every call", async () => {
		process.env.OLLAMA_API_KEY = KEY;
		const bad = stubOllama({ failTags: new TypeError("fetch failed") });
		await refreshOllamaCatalog({ fetchFn: bad.fetchFn, now: () => 0 });
		const failedCalls = bad.calls.length;
		await refreshOllamaCatalog({ fetchFn: bad.fetchFn, now: () => 10_000 });
		assert.equal(bad.calls.length, failedCalls, "inside the backoff window: no fetch");
		await refreshOllamaCatalog({ fetchFn: bad.fetchFn, now: () => 61_000 });
		assert.ok(bad.calls.length > failedCalls, "after the backoff: retried");
	});
});

describe("ensureOllamaCatalog", () => {
	beforeEach(reset);

	it("first start with no file and a failing network does not throw; the refresh records the error", async () => {
		process.env.OLLAMA_API_KEY = KEY;
		assert.doesNotThrow(() => ensureOllamaCatalog({ again: true }));
		assert.deepEqual(piModels().getModels("ollama-cloud"), []);
		const bad = stubOllama({ failTags: new TypeError("fetch failed") });
		await refreshOllamaCatalog({ fetchFn: bad.fetchFn });
		assert.match(ollamaCatalogStatus().error ?? "", /^Ollama catalog refresh failed/);
		assert.equal(ollamaCatalogStatus().models, 0);
	});

	it("installs a valid file without any fetch, and reports its age", () => {
		writeOllamaCatalog({
			version: 1,
			baseUrl: BASE,
			fetchedAt: 777,
			entries: [{ id: "gemma4:31b", capabilities: ["completion", "tools"], contextLength: 131072, thinkingValues: null }],
		});
		const original = globalThis.fetch;
		globalThis.fetch = (() => {
			throw new Error("network touched");
		}) as typeof fetch;
		try {
			ensureOllamaCatalog({ again: true });
		} finally {
			globalThis.fetch = original;
		}
		assert.deepEqual(ollamaModels().map((m) => m.id), ["gemma4:31b"]);
		assert.deepEqual(ollamaCatalogStatus(), { models: 1, refreshedAt: 777, error: null });
	});

	it("ignores a file fetched from a different base URL", () => {
		writeOllamaCatalog({
			version: 1,
			baseUrl: "http://10.0.0.5:11434",
			fetchedAt: 1,
			entries: [{ id: "gemma4:31b", capabilities: ["tools"], contextLength: null, thinkingValues: null }],
		});
		ensureOllamaCatalog({ again: true });
		assert.equal(ollamaModels().length, 0);
		assert.equal(ollamaCatalogStatus().refreshedAt, null);
	});

	it("a file-loaded catalog is stale-checked: non-forced refresh fetches once it is old", async () => {
		process.env.OLLAMA_API_KEY = KEY;
		writeOllamaCatalog({
			version: 1,
			baseUrl: BASE,
			fetchedAt: 0,
			entries: [{ id: "old:1", capabilities: ["tools"], contextLength: null, thinkingValues: null }],
		});
		ensureOllamaCatalog({ again: true });
		const { calls, fetchFn } = stubOllama();
		await refreshOllamaCatalog({ fetchFn, now: () => 60_000 });
		assert.equal(calls.length, 0, "file is 1 minute old: fresh");
		await refreshOllamaCatalog({ fetchFn, now: () => 11 * 60_000 });
		assert.ok(calls.length > 0);
		assert.deepEqual(ollamaModels().map((m) => m.id).sort(), ["gemma4:31b", "gpt-oss:120b"]);
	});
});

describe("when the refresh runs", () => {
	beforeEach(reset);

	/** Count Ollama /api/tags calls made through the global fetch (the default
	 *  fetchFn), answering from the stub so nothing touches the network. */
	async function withGlobalFetchCounted(run: () => Promise<void>): Promise<number> {
		const original = globalThis.fetch;
		let tagsCalls = 0;
		const stub = stubOllama();
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("/api/tags")) tagsCalls++;
			return stub.fetchFn(url, init ?? {});
		}) as typeof fetch;
		try {
			await run();
		} finally {
			globalThis.fetch = original;
		}
		return tagsCalls;
	}

	it("refreshConnectionCatalog (the ChatGPT turn path) makes no Ollama fetch", async () => {
		process.env.OLLAMA_API_KEY = KEY;
		assert.equal(await withGlobalFetchCounted(refreshConnectionCatalog), 0);
	});

	it("refreshPickerCatalogs (GET /api/models) runs the stale-gated Ollama refresh", async () => {
		process.env.OLLAMA_API_KEY = KEY;
		assert.equal(await withGlobalFetchCounted(refreshPickerCatalogs), 1);
		assert.equal(ollamaCatalogStatus().models, 2);
		assert.equal(await withGlobalFetchCounted(refreshPickerCatalogs), 0, "fresh now: second call is free");
	});

	it("boot refresh is off under the test runner and on otherwise", () => {
		assert.equal(bootRefreshEnabled("test"), false);
		assert.equal(bootRefreshEnabled("production"), true);
		assert.equal(bootRefreshEnabled("development"), true);
		assert.equal(bootRefreshEnabled(undefined), true);
	});
});

describe("catalog integration", () => {
	beforeEach(reset);

	it("an installed catalog validates as a models slot", async () => {
		process.env.OLLAMA_API_KEY = KEY;
		await refreshOllamaCatalog({ force: true, fetchFn: stubOllama().fetchFn });
		assert.deepEqual(validateModelsSettings({ strong: { model: { provider: "ollama-cloud", id: "gemma4:31b" } } }), { ok: true });
	});

	it("catalogProviders lists ollama-cloud with its key presence", () => {
		assert.deepEqual(
			catalogProviders().find((p) => p.id === "ollama-cloud"),
			{ id: "ollama-cloud", envVar: "OLLAMA_API_KEY", keyPresent: false },
		);
		process.env.OLLAMA_API_KEY = KEY;
		assert.deepEqual(
			catalogProviders().find((p) => p.id === "ollama-cloud"),
			{ id: "ollama-cloud", envVar: "OLLAMA_API_KEY", keyPresent: true },
		);
	});
});
