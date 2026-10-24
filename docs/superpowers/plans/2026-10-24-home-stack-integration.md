# Home Stack Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run LearnHarness on Ollama Cloud models, the owner's SearXNG for search, and the owner's Firecrawl for page fetching.

**Architecture:** Each service plugs into an existing seam. SearXNG is a third adapter behind the search port. Firecrawl is a new `PageFetcher` port injected into the researcher's web tools exactly like the search port. Ollama Cloud is a pi-ai provider built with `createProvider` from a live catalog that is persisted to disk and installed into the shared `piModels()` collection. Settings ride the existing auth store and Keys page.

**Tech Stack:** TypeScript, Next.js 16, pi-ai / pi-agent-core 1.4.0, node:test via tsx, React 19.

**Spec:** `docs/superpowers/specs/2026-10-24-home-stack-integration-design.md`

## Global Constraints

- Import law (eslint `import/no-restricted-paths`): `src/core` imports no IO layer; `src/agent` never imports `src/server` or `src/store`; `components/` imports only `@/src/core`; `app/` imports only `@/src/core` and `@/src/server`.
- Read the relevant guide in `node_modules/next/dist/docs/` before editing any file under `app/` (AGENTS.md).
- `npm test` is deterministic: no network, stubbed `fetch` only.
- `tests/auth-provider-keys.test.ts` and `tests/prices-sync.test.ts` must pass unchanged. The only existing tests that change are `tests/auth-keys.test.ts:15–19` and `tests/settings-pure.test.ts:252–256`.
- The string `"web_search is not available: no search engine is configured. Set a Tavily or Brave search API key in settings. Report in your brief that web search is unavailable."` is pinned by tests and the researcher prompt. Do not change it.
- Provider id `ollama-cloud`, label `Ollama Cloud`, key `OLLAMA_API_KEY`, optional env-only `OLLAMA_BASE_URL` (default `https://ollama.com`); chat at `${base}/v1`, catalog at `${base}/api/tags` and `${base}/api/show`.
- New auth vars: `SEARXNG_URL`, `FIRECRAWL_URL`, `FIRECRAWL_API_KEY`.
- Search preference order: `searxng`, `tavily`, `brave`.
- Timeouts: SearXNG 30 s; Firecrawl scrape 15 s; local fallback fetch 12 s when Firecrawl is configured (30 s otherwise, unchanged). Tool cap stays 30 s.
- Ollama model projection: `maxTokens = min(contextWindow, 32768)`; context fallback 131072; cost all zeros; models without `tools` capability excluded; `compat.supportsDeveloperRole = false`.
- Catalog file: `${PATHS.data}/catalogs/ollama-cloud.json`. Refresh staleness: 10 minutes.
- New server adapters declare a local `type FetchLike = (input: string, init: RequestInit) => Promise<Response>`, as `src/server/search.ts` does, and default to the global `fetch`.
- Commit after every task, on branch `feat/home-stack-integration`. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A pasted URL with a trailing slash** (`https://searxng.home.alidbouk.com/`) must save and work; a URL with a path like `/search` must be rejected with a message saying to paste the base URL. Pinned in Task 1.
2. **Off the tailnet** (DNS failure, `TypeError: fetch failed`): `web_search` returns a readable error string naming SearXNG, and `web_fetch` falls back to the local reader. Pinned in Tasks 2 and 3.
3. **First start with no catalog file and Ollama unreachable**: no crash, no Ollama models, and the Ollama row shows the error. Pinned in Task 5.
4. **Model ids containing a colon** (`gemma4:31b`) pass slot validation and round-trip through settings. Pinned in Task 5.
5. **Firecrawl "success" with almost nothing** (markdown under 200 characters) is treated as a failure and falls back. Pinned in Task 3.

---

### Task 1: Auth catalog entries and key plumbing

**Files:**
- Modify: `src/core/auth-keys.ts` (AUTH_KEYS, `AuthKeyInfo`, `validateKeyShape`, new `CUSTOM_PROVIDER_KEYS`)
- Modify: `src/server/keys.ts` (`isWritableAuthKey`, `initAuthEnv` managed set, `resolveKeyStatuses`, `keyStatuses`, `providerKeyPresent`)
- Test: `tests/auth-keys.test.ts`, `tests/settings-pure.test.ts`, `tests/server-keys.test.ts`

**Interfaces:**
- Produces:
  - `AuthKeyInfo.kind?: "secret" | "url"` (absent means secret).
  - `AUTH_KEYS` gains, in this order after `BRAVE_API_KEY`: `SEARXNG_URL` (label "SearXNG", kind url, docs `https://docs.searxng.org/`), `FIRECRAWL_URL` (label "Firecrawl", kind url, docs `https://docs.firecrawl.dev/contributing/self-host`), `FIRECRAWL_API_KEY` (label "Firecrawl API key", docs `https://docs.firecrawl.dev/`).
  - `normalizeBaseUrl(raw: string): { ok: true; value: string } | { ok: false; error: string }` in `src/core/auth-keys.ts`: trims, requires `http:` or `https:`, strips one trailing slash, rejects any path, query or hash.
  - `CUSTOM_PROVIDER_KEYS: readonly AuthProviderInfo[] = [{ id: "ollama-cloud", envVar: "OLLAMA_API_KEY", label: "Ollama Cloud" }]`, `CUSTOM_PROVIDER_ENV_VARS: ReadonlySet<string>`, and `isCustomProviderEnvVar(envVar: string): boolean`.
  - `saveKey` stores the normalized value for url-kind keys.
  - Status rows for url-kind keys carry the full value in `masked` (URLs are not secret), formatted `"<url> (<n> chars)"` so `keyStatusLine` keeps working.
  - `providerKeyPresent("ollama-cloud")` is true when `OLLAMA_API_KEY` resolves through `keyValue`.

- [ ] **Step 1: Update the two pinned tests and write the new failing tests**

`tests/auth-keys.test.ts`: the catalog test expects `["DEEPGRAM_API_KEY","TAVILY_API_KEY","BRAVE_API_KEY","SEARXNG_URL","FIRECRAWL_URL","FIRECRAWL_API_KEY"]`. Add:

```ts
it("normalizeBaseUrl strips one trailing slash", () => {
	assert.deepEqual(normalizeBaseUrl(" https://searxng.home.alidbouk.com/ "), { ok: true, value: "https://searxng.home.alidbouk.com" });
});
it("normalizeBaseUrl rejects a path, naming the base URL", () => {
	const r = normalizeBaseUrl("https://searxng.home.alidbouk.com/search");
	assert.equal(r.ok, false);
	assert.match((r as { error: string }).error, /base URL/);
});
it("normalizeBaseUrl rejects non-http schemes", () => {
	assert.equal(normalizeBaseUrl("ftp://x.y").ok, false);
});
it("validateKeyShape accepts SEARXNG_URL / FIRECRAWL_URL via normalizeBaseUrl and FIRECRAWL_API_KEY via the 12-char guard", () => {
	assert.equal(validateKeyShape("SEARXNG_URL", "http://10.0.0.5:8080").ok, true);
	assert.equal(validateKeyShape("FIRECRAWL_URL", "not a url").ok, false);
	assert.equal(validateKeyShape("FIRECRAWL_API_KEY", "short").ok, false);
});
it("CUSTOM_PROVIDER_KEYS holds exactly ollama-cloud and is disjoint from AUTH_PROVIDER_KEYS", () => {
	assert.deepEqual(CUSTOM_PROVIDER_KEYS.map((p) => [p.id, p.envVar]), [["ollama-cloud", "OLLAMA_API_KEY"]]);
	assert.ok(!AUTH_PROVIDER_KEYS.some((p) => p.id === "ollama-cloud" || p.envVar === "OLLAMA_API_KEY"));
});
```

`tests/settings-pure.test.ts:252–256`: expected tool row ids become the six ids above.

`tests/server-keys.test.ts`: add
- `resolveKeyStatuses` with file `{ SEARXNG_URL: "https://s.example" }` yields a row whose `masked` is `"https://s.example (17 chars)"`.
- With `OLLAMA_API_KEY` in the file and `CUSTOM_PROVIDER_ENV_VARS` passed as provider vars, a status row for `OLLAMA_API_KEY` is present.
- `isWritableAuthKey("OLLAMA_API_KEY")`, `isWritableAuthKey("SEARXNG_URL")` are true; `isWritableAuthKey("OLLAMA_BASE_URL")` is false.

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- --test-name-pattern="catalog|normalizeBaseUrl|CUSTOM_PROVIDER|curated tool ids|SEARXNG|OLLAMA"`
Expected: FAIL (missing exports, old catalog length).

- [ ] **Step 3: Implement in `src/core/auth-keys.ts`**

Add the entries, `kind`, `normalizeBaseUrl`, `CUSTOM_PROVIDER_KEYS`, `CUSTOM_PROVIDER_ENV_VARS: ReadonlySet<string>`, `isCustomProviderEnvVar`. `validateKeyShape` cases: the two URL ids return `normalizeBaseUrl(value)` mapped to `KeyShapeResult`; `FIRECRAWL_API_KEY` returns `genericProviderKeyGuard`.

- [ ] **Step 4: Implement in `src/server/keys.ts`**

`isWritableAuthKey` adds `isCustomProviderEnvVar`. `initAuthEnv` managed set adds `CUSTOM_PROVIDER_KEYS` env vars. `saveKey` uses `genericProviderKeyGuard` for custom provider vars and stores `normalizeBaseUrl(value).value` for url-kind ids. `resolveKeyStatuses` writes the full value into `masked` for url-kind info. `keyStatuses` passes the union of `AUTH_PROVIDER_ENV_VARS` and `CUSTOM_PROVIDER_ENV_VARS`. `providerKeyPresent` checks `CUSTOM_PROVIDER_KEYS` before `AUTH_PROVIDER_KEYS`.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS, including `tests/auth-provider-keys.test.ts` untouched.

- [ ] **Step 6: Commit**

```bash
git add src/core/auth-keys.ts src/server/keys.ts tests/auth-keys.test.ts tests/settings-pure.test.ts tests/server-keys.test.ts
git commit -m "feat(keys): add SearXNG, Firecrawl and Ollama Cloud auth entries"
```

---

### Task 2: SearXNG search engine

**Files:**
- Modify: `src/core/search.ts` (`SearchEngineId`)
- Modify: `src/server/search.ts` (adapter, `ENGINE_ORDER`, `resolveSearchEngineFor`, `searchStatus`, `searchProvider`)
- Modify: `src/core/settings.ts:521` (read side accepts `"searxng"`)
- Modify: `src/server/settings-body.ts:180` (write side accepts `"searxng"`)
- Modify: `components/settings/agent-section.tsx:86` (`SEARCH_ENGINES` gains `"searxng"`, label "SearXNG")
- Test: `tests/search.test.ts`, `tests/settings-body.test.ts`

**Interfaces:**
- Consumes: `keyValue("SEARXNG_URL")` from Task 1 (already normalized, no trailing slash).
- Produces:
  - `SearchEngineId = "searxng" | "tavily" | "brave"`.
  - `searxngProvider(baseUrl: string, fetchFn?: FetchLike): SearchProvider`.
  - `resolveSearchEngineFor(pinned, keys: Partial<Record<SearchEngineId, string | undefined>>)` unchanged in shape; for searxng the "key" is the URL.

- [ ] **Step 1: Write the failing tests in `tests/search.test.ts`**

```ts
it("SearXNG alone auto-activates", () => {
	const out = resolveSearchEngineFor(undefined, { searxng: "https://s.example" });
	assert.equal(out.engine, "searxng");
});
it("with all three configured and no pin, SearXNG wins", () => {
	const out = resolveSearchEngineFor(undefined, { searxng: "https://s.example", tavily: "tvly-throwaway-key-00001", brave: "brave-throwaway-key-00001" });
	assert.equal(out.engine, "searxng");
});
it("pinned searxng without a URL is honestly unavailable and names SEARXNG_URL", () => {
	const out = resolveSearchEngineFor("searxng", { tavily: "tvly-throwaway-key-00001" });
	assert.equal(out.available, false);
	assert.match(out.reason, /SEARXNG_URL/);
});
```

Adapter tests with a stub fetch that records the URL:
- calls `https://s.example/search?q=a+b&format=json` (assert `new URL(seen).searchParams.get("format") === "json"`).
- maps `{results:[{title:"T",url:"https://x/",content:"line1\nline2"}]}` to `[{title:"T",url:"https://x/",snippet:"line1 line2"}]`.
- slices to `count` (stub returns 8 results, `search(q, 3)` returns 3).
- drops results without `url`.
- HTTP 403 rejects with an Error whose message matches `/search\.formats/`.
- a stub that throws `new TypeError("fetch failed")` rejects with an Error whose message matches `/SearXNG/` and `/fetch failed/`.

`tests/settings-body.test.ts`: `agent.search.engine = "searxng"` is accepted; `"google"` still rejected and the error lists all three ids.

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- --test-name-pattern="SearXNG|searxng"`
Expected: FAIL.

- [ ] **Step 3: Implement `searxngProvider` and the order change in `src/server/search.ts`**

`GET ${baseUrl}/search` with `q`, `format=json`, header `accept: application/json`, `AbortSignal.timeout(30_000)`. Wrap network errors as `SearXNG request failed: <message>`. 403 message: `SearXNG returned 403 — enable "json" under search.formats in settings.yml`. Other non-2xx: `SearXNG search ${status}: <first 200 chars>`. `ENGINE_ORDER` becomes `[{searxng, "SEARXNG_URL"}, {tavily, …}, {brave, …}]`; the pinned-missing reason names the engine's env var from `ENGINE_ORDER` instead of the current Tavily/Brave ternary. `searchStatus` and `searchProvider` pass `searxng: engineKey("searxng")` and construct `searxngProvider` for that engine.

- [ ] **Step 4: Accept `"searxng"` in `src/core/settings.ts`, `src/server/settings-body.ts`, `components/settings/agent-section.tsx`**

Write-side error text: `search.engine must be "searxng", "tavily" or "brave"`.

- [ ] **Step 5: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/search.ts src/server/search.ts src/core/settings.ts src/server/settings-body.ts components/settings/agent-section.tsx tests/search.test.ts tests/settings-body.test.ts
git commit -m "feat(search): add SearXNG engine, preferred over Tavily and Brave"
```

---

### Task 3: Firecrawl page fetcher

**Files:**
- Create: `src/core/page-fetch.ts` (port types; export from `src/core/index.ts`)
- Create: `src/server/firecrawl.ts` (adapter + live resolution; export from `src/server/index.ts`)
- Modify: `src/agent/tools/web.ts` (`createWebTools` signature, fetch flow, timeout parameter)
- Modify: `src/agent/subagents/researcher.ts` (`ResearcherRunOptions.fetcher`)
- Modify: `src/agent/subagents/runner.ts` (`JobRunnerDeps.pageFetcher`, pass to researcher at :365)
- Modify: `src/server/chat-handler.ts:101` (wire `pageFetcher`)
- Test: `tests/firecrawl.test.ts` (new), `tests/web-search.test.ts` (new cases only)

**Interfaces:**
- Consumes: `keyValue("FIRECRAWL_URL")`, `keyValue("FIRECRAWL_API_KEY")` from Task 1.
- Produces:
  - `src/core/page-fetch.ts`:
    ```ts
    export interface FetchedPage { title: string; markdown: string; finalUrl: string; status: number; contentType: string | null }
    export interface PageFetcher { id: "firecrawl"; fetch(url: string): Promise<FetchedPage> }
    ```
  - `firecrawlFetcher(baseUrl: string, apiKey?: string, fetchFn?: FetchLike): PageFetcher` and `pageFetcher(): PageFetcher | null` in `src/server/firecrawl.ts`.
  - `createWebTools(search: () => SearchProvider | null, fetcher: () => PageFetcher | null = () => null)`.
  - `ResearcherRunOptions.fetcher?: () => PageFetcher | null`; `JobRunnerDeps.pageFetcher?: () => PageFetcher | null`.

- [ ] **Step 1: Write the failing adapter tests in `tests/firecrawl.test.ts`**

With a stub fetch:
- POSTs to `https://f.example/v2/scrape` with JSON body `{url, formats:["markdown"], onlyMainContent:true}`; sends `authorization: Bearer k-123456789012` only when an API key is given.
- maps `{success:true,data:{markdown:"…",metadata:{title:"T",sourceURL:"https://x/",url:"https://x/final",statusCode:200,contentType:"text/html"}}}` to `{title:"T", markdown:"…", finalUrl:"https://x/final", status:200, contentType:"text/html"}` (`finalUrl` prefers `metadata.url`, then `sourceURL`, then the requested URL).
- rejects on non-2xx, on `success:false`, and on a network `TypeError`, each with a message starting `Firecrawl`.

- [ ] **Step 2: Write the failing tool tests in `tests/web-search.test.ts`**

Use `createWebTools(() => null, () => stubFetcher)` and a `globalThis.fetch` stub installed for the test (restore after) that records every requested URL:
- Firecrawl success with 500 characters of markdown: output starts with `# T`, contains `Source: https://x/final (HTTP 200) via Firecrawl`, and `globalThis.fetch` was never called.
- `https://x/paper.pdf`: output contains `call web_fetch_pdf`, and the fetcher was not called.
- Fetcher returns `contentType: "application/pdf"`: output contains `call web_fetch_pdf`.
- Fetcher rejects with `Firecrawl request failed: fetch failed`: the local reader runs (stubbed global fetch returns an HTML article over 200 characters); output contains `via local reader` and `Firecrawl request failed: fetch failed`; no requested URL starts with `https://r.jina.ai/`.
- Fetcher resolves with 50 characters of markdown: treated as failure; output contains `via local reader`.
- Fetcher rejects and local Readability fails (stub returns `<html><body></body></html>`): output is a `web_fetch failed for` string and no URL starts with `https://r.jina.ai/`.

- [ ] **Step 3: Run to verify failure**

Run: `npm test -- --test-name-pattern="Firecrawl|firecrawl|local reader"`
Expected: FAIL.

- [ ] **Step 4: Implement the port and adapter**

Adapter timeout `AbortSignal.timeout(15_000)`. Error prefixes: `Firecrawl request failed: <message>`, `Firecrawl ${status}: <first 200 chars>`, `Firecrawl reported failure: <error field>`. `pageFetcher()` returns null when `FIRECRAWL_URL` is unset.

- [ ] **Step 5: Implement the `web_fetch` flow in `src/agent/tools/web.ts`**

`fetchAndExtract(url, opts: { timeoutMs: number; allowJina: boolean })`; the existing call keeps `{ timeoutMs: 30_000, allowJina: true }`. With a fetcher present:
1. PDF by path (`/\.pdf$/i` on `new URL(url).pathname`) returns the existing PDF pointer string.
2. `fetcher.fetch(url)`; content type containing `application/pdf` returns the pointer; markdown trimmed length `>= MIN_USEFUL_CONTENT` (200) is success, formatted per the spec and truncated with the existing `truncate`.
3. Otherwise run `fetchAndExtract(url, { timeoutMs: 12_000, allowJina: false })`, replace its `Source: … (HTTP n)` line's end with `(HTTP n) via local reader`, and append `\n\n(Firecrawl unavailable: <reason>)`.

- [ ] **Step 6: Wire the fetcher**

`researcher.ts` passes `opts.fetcher ?? (() => null)` to `createWebTools`; `runner.ts` passes `fetcher: deps.pageFetcher`; `chat-handler.ts` adds `pageFetcher` (imported from `./firecrawl.ts`) next to `searchProvider`.

- [ ] **Step 7: Run the full suite**

Run: `npm test && npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/core/page-fetch.ts src/core/index.ts src/server/firecrawl.ts src/server/index.ts src/agent/tools/web.ts src/agent/subagents/researcher.ts src/agent/subagents/runner.ts src/server/chat-handler.ts tests/firecrawl.test.ts tests/web-search.test.ts
git commit -m "feat(web): fetch pages through self-hosted Firecrawl with local fallback"
```

---

### Task 4: Ollama Cloud model projection and provider install

**Files:**
- Create: `src/agent/ollama-cloud.ts`
- Modify: `src/agent/models.ts` (export nothing new; `piModels()` unchanged)
- Test: `tests/ollama-cloud.test.ts` (new)

**Interfaces:**
- Produces (all in `src/agent/ollama-cloud.ts`):
  ```ts
  export const OLLAMA_PROVIDER_ID = "ollama-cloud";
  export const OLLAMA_DEFAULT_BASE_URL = "https://ollama.com";
  export interface OllamaCatalogEntry { id: string; capabilities: string[]; contextLength: number | null; thinkingValues: (string | boolean)[] | null }
  export function thinkingLevelMapFor(values: (string | boolean)[] | null): Model<"openai-completions">["thinkingLevelMap"] | undefined;
  export function projectOllamaModel(entry: OllamaCatalogEntry, baseUrl: string): Model<"openai-completions"> | null;
  export function installOllamaCatalog(entries: readonly OllamaCatalogEntry[], baseUrl: string): void; // setProvider on piModels()
  export function ollamaModels(): Model<"openai-completions">[];
  ```

- [ ] **Step 1: Write the failing tests**

```ts
it("gpt-oss values map named levels, no off", () => {
	assert.deepEqual(thinkingLevelMapFor(["low", "medium", "high"]), {
		off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "high", max: "high",
	});
});
it("kimi-k3 values: off → none, medium falls to low, max kept", () => {
	assert.deepEqual(thinkingLevelMapFor([false, "low", "high", "max"]), {
		off: "none", minimal: null, low: "low", medium: "low", high: "high", xhigh: "high", max: "max",
	});
});
it("boolean-only models: off → none, medium → medium, others null", () => {
	assert.deepEqual(thinkingLevelMapFor([false, true]), {
		off: "none", minimal: null, low: null, medium: "medium", high: null, xhigh: null, max: null,
	});
});
it("no thinking values → undefined", () => {
	assert.equal(thinkingLevelMapFor(null), undefined);
});
```

Projection:
- `{id:"gemma4:31b", capabilities:["completion","tools","thinking","vision"], contextLength:131072, thinkingValues:[false,true]}` projects to `provider "ollama-cloud"`, `api "openai-completions"`, `baseUrl "https://ollama.com/v1"`, `input ["text","image"]`, `reasoning true`, `contextWindow 131072`, `maxTokens 32768`, zero cost, `compat.supportsDeveloperRole false`, `compat.supportsReasoningEffort true`.
- `capabilities` without `tools` returns null.
- `contextLength: null` gives `contextWindow 131072`; `contextLength: 16000` gives `maxTokens 16000`.
- After `installOllamaCatalog([gemmaEntry], "https://ollama.com")`, `piModels().getModel("ollama-cloud", "gemma4:31b")` is defined; a second install with `[]` makes it undefined (replacement, not merge).

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- --test-name-pattern="ollama|Ollama|thinkingLevelMapFor"`
Expected: FAIL.

- [ ] **Step 3: Implement `src/agent/ollama-cloud.ts`**

Level ladder order: `minimal, low, medium, high, xhigh, max`. For each level: the same string if listed; else the nearest listed string below it on the ladder; else `null` (so `minimal` is `null` unless the model lists it). `off` is `"none"` when `false` is listed, else `null`. Boolean-only lists use the fixed map from the test. Provider: `createProvider({ id: OLLAMA_PROVIDER_ID, name: "Ollama Cloud", baseUrl: \`${base}/v1\`, auth: { apiKey: envApiKeyAuth("Ollama Cloud", ["OLLAMA_API_KEY"]) }, models, api: openAICompletionsApi() })` with `openAICompletionsApi` from `@earendil-works/pi-ai/api/openai-completions.lazy`. Confirm in pi-ai's `Models.setProvider` that a same-id provider replaces the old one; the replacement test pins it.

- [ ] **Step 4: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/ollama-cloud.ts tests/ollama-cloud.test.ts
git commit -m "feat(models): project Ollama Cloud catalog into a pi-ai provider"
```

---

### Task 5: Ollama Cloud catalog lifecycle

**Files:**
- Create: `src/store/ollama-catalog.ts` (read/write the JSON file)
- Create: `src/server/ollama-cloud.ts` (fetch, refresh, persist, status; export from `src/server/index.ts`)
- Modify: `config.ts` (`PATHS.catalogs = path.join(DATA_ROOT, "catalogs")`)
- Modify: `src/server/model-catalog.ts` (`catalogProviders`, `refreshConnectionCatalog`)
- Modify: `src/server/keys.ts` (`saveKey`/`deleteKey` trigger a forced refresh for `OLLAMA_API_KEY`)
- Test: `tests/ollama-catalog.test.ts` (new)

**Interfaces:**
- Consumes: Task 4's `OllamaCatalogEntry`, `installOllamaCatalog`, `OLLAMA_DEFAULT_BASE_URL`, `OLLAMA_PROVIDER_ID`; Task 1's `providerKeyPresent`.
- Produces:
  ```ts
  // src/store/ollama-catalog.ts
  export interface StoredOllamaCatalog { version: 1; baseUrl: string; fetchedAt: number; entries: OllamaCatalogEntry[] }
  export function readOllamaCatalog(file?: string): StoredOllamaCatalog | null; // null on missing or invalid
  export function writeOllamaCatalog(catalog: StoredOllamaCatalog, file?: string): void; // atomic temp + rename
  // src/server/ollama-cloud.ts
  export function ollamaBaseUrl(): string; // OLLAMA_BASE_URL env, normalized, else default
  export function fetchOllamaCatalog(baseUrl: string, fetchFn?: FetchLike): Promise<OllamaCatalogEntry[]>;
  export function ensureOllamaCatalog(): void; // sync, once per process: load file → install
  export function refreshOllamaCatalog(opts?: { force?: boolean; fetchFn?: FetchLike; now?: () => number }): Promise<void>;
  export interface OllamaCatalogStatus { models: number; refreshedAt: number | null; error: string | null }
  export function ollamaCatalogStatus(): OllamaCatalogStatus;
  ```
  `src/store/ollama-catalog.ts` imports the entry type with `import type` from `src/agent/ollama-cloud.ts` (type-only imports are allowed by the store layer; confirm with `npm run lint`).

- [ ] **Step 1: Write the failing tests**

With a temp data dir (`LH_DATA_DIR` set before import, as other store tests do) and stub fetch:
- `fetchOllamaCatalog` reads `/api/tags` (`models[].name`, `models[].capabilities`) then POSTs `/api/show` `{model}` per model, taking `contextLength` from the first `model_info` key ending in `.context_length` and `thinkingValues` from `thinking.values`; a failed `/api/show` for one model keeps that model with `contextLength: null, thinkingValues: null`.
- `refreshOllamaCatalog({force:true})` with no key present does nothing and leaves status error `null`.
- With `OLLAMA_API_KEY` set: a successful refresh writes the file, installs the models, and sets `refreshedAt`.
- A non-forced refresh within 10 minutes does not call fetch; after 10 minutes (`now` stub) it does.
- A failed refresh after a good one keeps the models installed, keeps the file, and sets `error` to a message starting `Ollama catalog refresh failed`.
- First start, no file, fetch throws `TypeError("fetch failed")`: `ensureOllamaCatalog()` does not throw, `piModels().getModels("ollama-cloud")` is empty, and after the refresh `ollamaCatalogStatus().error` is set.
- `ensureOllamaCatalog()` with a valid file installs its models without any fetch.
- After install, `validateModelsSettings({ strong: { model: { provider: "ollama-cloud", id: "gemma4:31b" } } })` returns `{ ok: true }`.
- `catalogProviders()` includes `{ id: "ollama-cloud", envVar: "OLLAMA_API_KEY", keyPresent: true }` when the key is set.

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- --test-name-pattern="Ollama catalog|ollama catalog|ensureOllamaCatalog"`
Expected: FAIL.

- [ ] **Step 3: Implement the store, the server module, and `PATHS.catalogs`**

`ensureOllamaCatalog()` runs at module load of `src/server/ollama-cloud.ts` (same pattern as `initAuthEnv()` in `keys.ts`), guarded by a `globalThis` symbol so HMR does not re-run it. `refreshOllamaCatalog` is single-flight (concurrent calls share one promise). Fetch timeout 15 s per request; `/api/show` calls run at most 4 at a time.

- [ ] **Step 4: Hook into the catalog and keys**

`model-catalog.ts`: import `./ollama-cloud.ts`; `catalogProviders()` concatenates `CUSTOM_PROVIDER_KEYS` rows with `keyPresent: keyValue(envVar) !== undefined`; `refreshConnectionCatalog()` also awaits `refreshOllamaCatalog()` (non-forced) so `GET /api/models` refreshes when stale. `keys.ts`: after saving or deleting `OLLAMA_API_KEY`, call `void refreshOllamaCatalog({ force: true })`. `keys.ts` must not import `model-catalog.ts`; import `./ollama-cloud.ts` directly.

- [ ] **Step 5: Run the full suite**

Run: `npm test && npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add config.ts src/store/ollama-catalog.ts src/server/ollama-cloud.ts src/server/index.ts src/server/model-catalog.ts src/server/keys.ts tests/ollama-catalog.test.ts
git commit -m "feat(models): live, persisted Ollama Cloud catalog"
```

---

### Task 6: Settings UI

**Files:**
- Modify: `app/api/keys/route.ts` (adds `ollama: ollamaCatalogStatus()` to the GET payload)
- Modify: `components/settings/keys-section.tsx` (`classifyKeys`, Subscriptions group, Web group)
- Create: `components/settings/ollama-connection.tsx`
- Test: `tests/settings-pure.test.ts`, `tests/render-settings.test.tsx`

**Interfaces:**
- Consumes: `CUSTOM_PROVIDER_KEYS` (via `@/src/core`), `OllamaCatalogStatus` shape from Task 5 (redeclare the three-field type in `src/core/contracts/models.ts` as `OllamaCatalogStatusDto` so `components/` can import it from `@/src/core`; Task 5's server type must satisfy it).
- Produces: `classifyKeys(...)` return gains `subscriptionRows: AuthKeyStatus[]` (custom provider rows, synthesized when absent) and these rows never appear in `providerRows` or `unknownRows`.

- [ ] **Step 1: Write the failing tests**

`tests/settings-pure.test.ts`:
- `classifyKeys([status("OLLAMA_API_KEY", true)], providers)` puts it in `subscriptionRows` only.
- With no statuses, `subscriptionRows` holds one synthesized `OLLAMA_API_KEY` row with `present: false`.

`tests/render-settings.test.tsx` (follow the file's existing render harness):
- The Subscriptions group (`data-testid="group-subscriptions"`) contains `data-testid="key-ollama_api_key"` and the text `Ollama Cloud`.
- With `ollama: { models: 21, refreshedAt: <ts>, error: null }` it shows `21 models`.
- With `error: "Ollama catalog refresh failed: fetch failed"` it shows that text.
- The group formerly labelled Search is labelled `Web` and contains `key-searxng_url`, `key-firecrawl_url`, `key-firecrawl_api_key`, `key-tavily_api_key`, `key-brave_api_key`; its testid stays `group-search`.

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- --test-name-pattern="subscriptionRows|Ollama Cloud|Web group"`
Expected: FAIL.

- [ ] **Step 3: Implement**

Export `KeyTableRow` from `keys-section.tsx`. `OllamaConnection` renders a `KeyTableRow` for `OLLAMA_API_KEY` (docs `https://ollama.com/settings/keys`) plus one muted status line: `"<n> models · refreshed <relative time>"`, or the error text, or nothing when no key. Place it under the ChatGPT connection inside Subscriptions. Relabel the Search group `Web`, keep its testid.

- [ ] **Step 4: Run the full suite**

Run: `npm test && npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/keys/route.ts components/settings/keys-section.tsx components/settings/ollama-connection.tsx src/core/contracts/models.ts tests/settings-pure.test.ts tests/render-settings.test.tsx
git commit -m "feat(settings): Ollama Cloud subscription row and Web group"
```

---

### Task 7: Documentation and live verification

**Files:**
- Create: `docs/home-stack.md`

- [ ] **Step 1: Write `docs/home-stack.md`**

Sections: what each of the three settings does; env equivalents (`OLLAMA_API_KEY`, `OLLAMA_BASE_URL`, `SEARXNG_URL`, `FIRECRAWL_URL`, `FIRECRAWL_API_KEY`); the three `curl` checks (SearXNG JSON search, Firecrawl `/v2/scrape`, Ollama `/api/tags`); the note that the cost meter shows Ollama calls as unpriced.

- [ ] **Step 2: Full automated gate**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all PASS with zero failures.

- [ ] **Step 3: Live checks with the owner's key** (needs the owner to paste `OLLAMA_API_KEY` in Settings; run `npm run dev`)

1. Settings shows the Ollama row with a model count; pick an Ollama model with vision for strong, cheap and vision slots.
2. Start a lesson; a teacher turn with tool calls completes.
3. A turn that triggers the visual maker completes.
4. Set a slot to kimi-k3 with thinking off and confirm the request succeeds (`reasoning_effort: "none"`); repeat on gemma4:31b with off and medium. If Ollama rejects `"none"` or `"medium"`, change `thinkingLevelMapFor` per the spec and its tests, and commit.
5. Restart the dev server; the first turn on the Ollama model works before any refresh.
6. A research job returns a brief; the activity feed shows SearXNG searches and Firecrawl fetches.
7. Set `FIRECRAWL_URL` to `http://127.0.0.1:9` and run research; fetches say `via local reader`; no request to `r.jina.ai` appears in the server log.

- [ ] **Step 4: Commit**

```bash
git add docs/home-stack.md
git commit -m "docs: home stack setup and verification"
```
