# Home stack: Ollama Cloud, SearXNG, Firecrawl

This fork can run on an Ollama Cloud subscription for models, a self-hosted SearXNG for search, and a self-hosted Firecrawl for page fetching. All three are optional and independent.

## Settings

Set them on **Settings -> Providers** (Ollama Cloud under Subscriptions; the rest in the Web group), or in `.env.local`. Real environment variables win over saved values.

| Setting | What it does |
|---|---|
| `OLLAMA_API_KEY` | Ollama Cloud key. Create one at https://ollama.com/settings/keys. |
| `OLLAMA_BASE_URL` | Optional, env only. Defaults to `https://ollama.com`. |
| `SEARXNG_URL` | Base URL of your SearXNG. Enables `web_search` through it. |
| `FIRECRAWL_URL` | Base URL of your Firecrawl. Enables page fetching through it. |
| `FIRECRAWL_API_KEY` | Optional. Only if your Firecrawl requires a key. |

Example `.env.local`:

```bash
OLLAMA_API_KEY=...
SEARXNG_URL=https://searxng.home.alidbouk.com
FIRECRAWL_URL=https://firecrawl.home.alidbouk.com
```

Those two hostnames resolve only on the owner's Tailscale network.

## Behavior

- **Models.** Ollama Cloud models appear in the picker under provider `ollama-cloud`. The list is fetched live and saved to `data/catalogs/ollama-cloud.json`. It is refreshed at start, when the model picker or Providers page is opened and the list is over 10 minutes old, and when the key is saved.
- **Cost meter.** Ollama Cloud calls show as unpriced ("-") with token counts, because the subscription is the bill.
- **Concurrency.** Ollama Pro allows 3 concurrent requests and queues the rest.
- **Search.** Preference order is SearXNG, then Tavily, then Brave.
- **Fetching.** With `FIRECRAWL_URL` set, every `web_fetch` goes through Firecrawl first and falls back to the local reader if Firecrawl fails. Jina Reader is never called. Without it, fetching is unchanged from upstream.
- **SearXNG setup.** `json` must be listed under `search.formats` in SearXNG's `settings.yml`, or JSON requests get HTTP 403.

## Check the services

```bash
curl -fsS --get --data-urlencode 'q=test' --data-urlencode 'format=json' "$SEARXNG_URL/search" | head -c 300
```

```bash
curl -fsS -H 'Content-Type: application/json' -d '{"url":"https://example.com","formats":["markdown"]}' "$FIRECRAWL_URL/v2/scrape" | head -c 300
```

```bash
curl -fsS https://ollama.com/api/tags | head -c 300
```

Each should print JSON. A 403 from the first means `json` is missing from `search.formats`.

## Live checks after setup

With the key saved and `npm run dev` running:

1. Settings shows the Ollama row with a model count; pick an Ollama model with vision for the strong, cheap and vision slots.
2. Start a lesson; a teacher turn with tool calls completes.
3. A turn that triggers the visual maker completes.
4. Set a slot to kimi-k3 with thinking off and confirm the request succeeds (`reasoning_effort: "none"`); repeat on gemma4:31b with off and medium. If Ollama rejects `"none"` or `"medium"`, change `thinkingLevelMapFor` per the spec and its tests, and commit.
5. Restart the dev server; the first turn on the Ollama model works before any refresh.
6. A research job returns a brief; the activity feed shows SearXNG searches and Firecrawl fetches.
7. Set `FIRECRAWL_URL` to `http://127.0.0.1:9` and run research; fetches say `via local reader`; no request to `r.jina.ai` appears in the server log.
