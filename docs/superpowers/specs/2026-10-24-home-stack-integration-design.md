# Home stack integration: Ollama Cloud, SearXNG, Firecrawl

Date: 2026-10-24 · Branch: `feat/home-stack-integration` · Fork: `adbouk-1/learnharness`

## Intent

The owner of this fork wants to learn with LearnHarness using services they
already pay for or run themselves, instead of per-token API keys and paid
search SaaS:

- **Models** from their **Ollama Cloud Pro** subscription (flat $20/month with
  included usage credits).
- **Web search** from their self-hosted **SearXNG**.
- **Page fetching** from their self-hosted **Firecrawl**.

Both self-hosted services run on a Kubernetes cluster at home and are
reachable from the owner's Mac over Tailscale with split DNS. They are defined
in the owner's `~/alistudio-config` repository.

The Claude Pro/Max subscription was ruled out: Anthropic's terms restrict
subscription OAuth to Claude Code and Anthropic's own apps. That route is not
part of this work.

## Goals

1. Ollama Cloud is a model provider. Its live catalog appears in the model
   picker, and its models can fill all three slots (strong, cheap, vision).
2. SearXNG is a search engine behind the existing search port, alongside
   Tavily and Brave.
3. Firecrawl serves the researcher's `web_fetch` tool.
4. All three are configured from the existing Settings → Providers page, and
   also from environment variables (`.env.local`), following the app's
   existing "env wins" rule.
5. The fork stays easy to keep in sync with upstream: changes are additive and
   sit on the existing seams, with minimal edits to busy files.

## Non-goals

- Any use of the Claude subscription.
- Running models on the owner's home GPU (local Ollama, vLLM) or through
  their LiteLLM gateway. The design leaves a door open (configurable base URL)
  but does not build or test it.
- Firecrawl's `/v2/search` endpoint. SearXNG is called directly.
- Desktop release builds, signing, or notarization. The owner runs the app
  with `npm run dev` or `npm run desktop:dev`.
- An upstream pull request.

## Anti-goals

The work fails, even if it technically runs, if any of these happen:

- **Silent third-party calls.** Once Firecrawl is configured, page content must
  never be sent to Jina Reader or any other outside reader service.
- **Breaking upstream's pins.** The `AUTH_PROVIDER_KEYS` no-drift test against
  pi-ai's provider table must keep passing unchanged, as must the rest of
  `npm test`, `npm run lint` and `npm run typecheck`.
- **Hidden fallbacks between search engines.** The app's doctrine is that a
  chosen engine without credentials is honestly unavailable. SearXNG follows
  the same rule.
- **Phantom costs.** The cost meter must not show invented per-token prices
  for Ollama Cloud models.
- **Unexplained test edits.** Existing tests may change only where this design
  says so (see Tests), and each change must keep the test's original intent.

## Environment facts (verified 2026-10-24)

| Service | Endpoint | Auth | Verified |
|---|---|---|---|
| SearXNG | `https://searxng.home.alidbouk.com/search?format=json` | None (tailnet only) | 200, 20 results, under 1 s |
| Firecrawl | `https://firecrawl.home.alidbouk.com/v2/scrape` | None, `USE_DB_AUTHENTICATION=false` | 200, Wikipedia page to markdown, about 1 s |
| Ollama Cloud chat | `https://ollama.com/v1` (OpenAI-compatible) | `Authorization: Bearer $OLLAMA_API_KEY` | Docs only, no key on hand |
| Ollama Cloud catalog | `https://ollama.com/api/tags`, `https://ollama.com/api/show` | None needed | 200, 23 models with capabilities; `/api/show` returns context length |

Observations that matter for the build:

- SearXNG reports some upstream engines as throttled (Brave "too many
  requests", DuckDuckGo CAPTCHA) yet still returns full result sets.
  `json` is enabled under `search.formats`.
- Firecrawl is v2.11 with Playwright rendering. `onlyMainContent: true` still
  leaves some page chrome (tab links) at the top of the markdown.
- Ollama's OpenAI-compatible API supports streaming, tools, base64 images and
  `reasoning_effort`. It does not support `tool_choice`, image URLs, or
  setting context size per request. Reasoning-effort values are model-defined;
  unknown names fall back to the model default.
- Ollama Pro allows 3 concurrent requests and queues the rest. The app's
  background semaphore also allows 3, plus the live teacher turn, so
  occasional queueing is expected and acceptable.
- The two `home.alidbouk.com` hostnames resolve only on the tailnet. Off the
  tailnet they fail with a DNS error.

## The how: decided by the owner

- Ollama Cloud on the Pro plan supplies the models.
- SearXNG and Firecrawl from the home cluster, at the URLs above.
- Work happens in the fork, on this branch, with upstream tracked as
  `upstream`.

## The how: builder's calls (made by the assistant, open to the owner)

### 1. Ollama Cloud provider

- **Identity.** Provider id `ollama-cloud`, label "Ollama Cloud". Key in
  `OLLAMA_API_KEY`. Optional `OLLAMA_BASE_URL`, default `https://ollama.com`;
  chat goes to `${base}/v1`, catalog to `${base}/api/*`.
- **Registration.** Built with pi-ai's `createProvider` and
  `openAICompletionsApi`, registered into the same `piModels()` collection as
  the builtins. Auth via pi's `envApiKeyAuth("Ollama Cloud", ["OLLAMA_API_KEY"])`,
  so the existing "file key reflected into env" seam works unchanged.
- **Catalog.** Fetched live: `/api/tags` for the list and capabilities, then
  `/api/show` per model for context length and reasoning options. Refreshed
  when the key is saved, when the Providers or model picker data is requested
  and the cache is older than ten minutes, and at server start.
- **Persistence.** The last good catalog is written to
  `${PATHS.data}/catalogs/ollama-cloud.json` after every successful refresh and
  loaded synchronously at first use. This keeps saved slots and sessions that
  name an Ollama model working right after a restart, without making the
  synchronous engine-resolution call sites async. A model that later
  disappears from the live catalog fails the way any unknown model does today
  ("catalog has no model").
- **Failed refresh.** Keeps the last good catalog. This deliberately differs
  from the ChatGPT catalog, which clears on failure. The error is logged and
  shown as a one-line status under the Ollama Cloud row in Subscriptions, via
  a new optional field on that row's own payload. The shared `CatalogProvider`
  contract is not changed.
- **Model projection.**
  - `input`: `["text","image"]` when capabilities include `vision`, else `["text"]`.
  - `reasoning`: true when capabilities include `thinking`.
  - `contextWindow`: from `/api/show` (`*.context_length`); fall back to 131072 when absent.
  - `maxTokens`: `min(contextWindow, 32768)`.
  - `cost`: all zeros. The subscription is the bill.
  - Models without the `tools` capability are excluded, since every LearnHarness agent uses tools.
  - `compat`: `supportsDeveloperRole: false`. `supportsReasoningEffort: true` for thinking models.
  - `thinkingLevelMap`: built per model from `/api/show`'s `thinking.values`
    (verified examples: gpt-oss:120b `["low","medium","high"]`; kimi-k3
    `[false,"low","high","max"]`; gemma4:31b `[false,true]`).
    - `off`: `"none"` when `false` is among the values, otherwise `null`
      (unsupported, so the picker hides it). pi sends the `off` entry as
      `reasoning_effort` when present (pi-ai `openai-completions.js:722`).
    - Each named level (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`)
      maps to the same string when the model lists it, otherwise to the
      nearest listed string below it, otherwise `null`.
    - Boolean-only models (`[false,true]`): `off → "none"`, `medium → "medium"`, all others `null`.
    - `"none"` and the boolean mapping are unverified against the live API.
      The verification step checks them; if Ollama rejects them, `off`
      becomes `null` for those models.
- **Key surfaces.** A small new table of "custom providers" sits beside
  `AUTH_PROVIDER_KEYS` (never inside it, to keep the no-drift test intact).
  `catalogProviders()`, `providerKeyPresent()`, `keyStatuses()` and the keys
  routes read both tables. Shape check: the generic 12-character,
  no-whitespace guard.
- **Settings UI.** An "Ollama Cloud" row in the existing **Subscriptions**
  group, with a paste field for the key and a link to
  `https://ollama.com/settings/keys`.
- **Cost meter.** No change. The meter prices calls from a generated static
  table (`src/core/prices.ts`), guarded by `tests/prices-sync.test.ts`, so
  Ollama Cloud calls show as unpriced ("—") with their token counts. This is
  honest and touches no busy files. A ChatGPT-style "Ollama plan" label
  (generalising `isChatGPTPlan` across prices, cost summary, stats bar and
  graph view) is a possible follow-up, not part of this work.

### 2. SearXNG search engine

- **Configuration.** `SEARXNG_URL` (for this owner,
  `https://searxng.home.alidbouk.com`) added to the curated `AUTH_KEYS`
  catalog, stored in the same auth store as the search keys, and validated as an `http:` or `https:` URL with no path beyond
  an optional trailing slash. "URL set" means "engine live".
- **Adapter.** `GET ${url}/search?q=…&format=json`, 30 s timeout. Map
  `results[]` to `{title, url, snippet}` (`content` becomes `snippet`, newlines
  flattened, 500-character cap) and slice to `count`. A 403 response produces
  an error that says JSON output must be enabled in `search.formats`.
- **Engine order.** `SearchEngineId` gains `"searxng"`. Preference order
  becomes SearXNG, Tavily, Brave. The explicit pin in `agent.search.engine`
  accepts `"searxng"`. The settings read side accepts it too.
- **Settings UI.** A "SearXNG" row in the existing **Search** group (URL field
  instead of a key field), and SearXNG added to the engine preference menu.

### 3. Firecrawl page fetching

- **Configuration.** `FIRECRAWL_URL` (for this owner,
  `https://firecrawl.home.alidbouk.com`), added to `AUTH_KEYS` and validated
  like `SEARXNG_URL`. Optional `FIRECRAWL_API_KEY`, also in `AUTH_KEYS`, sent
  as a bearer token when present, for deployments that turn auth on.
- **Timeout budget.** Every server-executed tool is capped at 30 s
  (`src/agent/tool-execute.ts:46`). The Firecrawl call gets 15 s and the local
  fallback fetch 12 s, so a failed Firecrawl call still leaves room for the
  fallback inside the cap. The shared cap is not changed.
- **Port.** A new core port, `PageFetcher`, injected into `createWebTools`
  next to the search provider, following the search port pattern (the agent
  layer never imports server code).
- **Behavior of `web_fetch` when Firecrawl is configured:**
  1. `POST ${url}/v2/scrape` with `{url, formats: ["markdown"], onlyMainContent: true}`, 15 s timeout.
  2. On success, return a `# title` line, then a `Source: <final URL> (HTTP <status>) via Firecrawl` line, then the markdown, truncated at the existing 40,000-character cap.
  3. When the target is a PDF (the URL path ends in `.pdf`, or Firecrawl's metadata reports a PDF content type), return the existing pointer to `web_fetch_pdf` instead, so PDFs keep using the app's own page-level PDF tools.
  4. When Firecrawl fails (network error, non-2xx, `success: false`, empty markdown), fall back to the local fetch with Readability. The source line then says `via local reader`, and the failure reason is appended in one line.
  5. Jina Reader is never called on this path.
- **When Firecrawl is not configured**, `web_fetch` behaves exactly as
  upstream does today, including the Jina fallback.
- **Settings UI.** A "Firecrawl" row in the **Search** group, which is
  relabelled "Web" (search plus fetching).

### 4. Tests

All deterministic, with stubbed fetch, in the style of `tests/search.test.ts`
and `tests/web-search.test.ts`:

- SearXNG adapter: result mapping, `count` slicing, 403 hint, non-JSON body.
- Engine resolution: SearXNG auto-activates on URL; pin respected; no silent fallback.
- Firecrawl fetcher: success shape, PDF pointer, failure falls back to local reader, Jina never called when configured.
- Ollama catalog: tags plus show projection (vision, thinking, tools filter, context fallback, zero cost); key presence; failed refresh keeps the last catalog.
- URL shape validation for `SEARXNG_URL` and `FIRECRAWL_URL`.
- Keys section: the new rows land in the right groups.
- Ollama thinking map: per-model mapping from `thinking.values`, including `off` handling.
- Catalog persistence: load at first use, write after refresh, keep on failure.

Existing tests that change, and why:

- `tests/auth-keys.test.ts:15–19` and `tests/settings-pure.test.ts:252–256`
  pin `AUTH_KEYS` to exactly three ids. They are updated to the new list
  (adding `SEARXNG_URL`, `FIRECRAWL_URL`, `FIRECRAWL_API_KEY`), keeping their
  intent of pinning the curated catalog exactly.
- No other existing test changes. In particular the `AUTH_PROVIDER_KEYS`
  no-drift test and `tests/prices-sync.test.ts` stay as they are.

### 5. Documentation

A short `docs/home-stack.md` explaining the three settings, the env-variable
equivalents, and how to verify each service with `curl`.

## Left to the builder

- File layout and internal names, within the repository's import law.
- Exact UI copy and row layout, matching the existing Keys section style.
- How the catalog refresh is triggered internally, within the rules above.
- Whether to read Next.js docs in `node_modules/next/dist/docs/` before
  touching any route (AGENTS.md requires it for Next.js code).

## Verification before calling it done

1. `npm test`, `npm run lint`, `npm run typecheck` all pass.
2. With the owner's Ollama key: a teacher turn completes on an Ollama Cloud
   model with tool calls, and a vision-slot job (visual maker) completes on a
   vision-capable model.
3. With the owner's Ollama key: `reasoning_effort: "none"` is accepted by a
   model whose values include `false`, and the boolean-only mapping works on
   gemma4:31b. Adjust the map as described if not.
4. Restart the server with an Ollama model in a slot: the first turn works
   before any catalog refresh completes.
5. A research job runs end to end: SearXNG results, Firecrawl fetches, a brief
   delivered back to the lesson.
6. With Firecrawl's URL pointing nowhere, `web_fetch` falls back to the local
   reader and never contacts `r.jina.ai`.
