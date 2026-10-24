/**
 * The Firecrawl page fetcher's server composition (home-stack integration,
 * 2026-10-24): the adapter behind the core port (core/page-fetch.ts) + the
 * live resolution the chat handler injects into the researcher's web_fetch.
 *
 * Firecrawl is optional and self-hosted: it is live iff FIRECRAWL_URL is
 * set (auth store or env — env wins, keyed via server/keys.ts keyValue);
 * FIRECRAWL_API_KEY is sent only when present (a self-hosted instance
 * without auth needs none). Nothing falls back to a third party here — the
 * tool's own fallback is the local Readability reader.
 */

import type { FetchedPage, PageFetcher } from "../core/page-fetch.ts";
import { baseUrlValue, keyValue } from "./keys.ts";

/** The wire-callable shape the adapter closes over (tests inject a stub). */
type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Firecrawl: POST <baseUrl>/v2/scrape with {url, formats:["markdown"],
 *  onlyMainContent:true}; response {success, data: {markdown, metadata:
 *  {title, sourceURL, url, statusCode, contentType}}} or {success:false,
 *  error}. `baseUrl` is the stored FIRECRAWL_URL, already normalized
 *  (server/keys.ts normalizeBaseUrl: no trailing slash). The 15 s timeout
 *  keeps the scrape inside the tool's 30 s cap with room for the local
 *  fallback. */
export function firecrawlFetcher(baseUrl: string, apiKey?: string, fetchFn: FetchLike = fetch): PageFetcher {
	return {
		id: "firecrawl",
		async fetch(url: string): Promise<FetchedPage> {
			const headers: Record<string, string> = { "content-type": "application/json" };
			if (apiKey) headers.authorization = `Bearer ${apiKey}`;
			let resp: Response;
			try {
				resp = await fetchFn(`${baseUrl}/v2/scrape`, {
					method: "POST",
					headers,
					body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
					signal: AbortSignal.timeout(15_000),
				});
			} catch (err) {
				throw new Error(`Firecrawl request failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			if (!resp.ok) {
				const body = await resp.text();
				throw new Error(`Firecrawl ${resp.status}: ${body.slice(0, 200)}`);
			}
			const data = (await resp.json()) as {
				success?: boolean;
				error?: string;
				data?: {
					markdown?: string;
					metadata?: {
						title?: string;
						sourceURL?: string;
						url?: string;
						statusCode?: number;
						contentType?: string;
					};
				};
			};
			if (data.success === false) {
				throw new Error(`Firecrawl reported failure: ${data.error ?? "unknown error"}`);
			}
			const meta = data.data?.metadata;
			return {
				title: meta?.title ?? "",
				markdown: data.data?.markdown ?? "",
				finalUrl: meta?.url || meta?.sourceURL || url,
				status: meta?.statusCode ?? resp.status,
				contentType: meta?.contentType ?? null,
			};
		},
	};
}

/** The LIVE fetcher, or null when FIRECRAWL_URL is unset. Composed fresh
 *  each call — key/URL rotations take effect on the next fetch. */
export function pageFetcher(): PageFetcher | null {
	const baseUrl = baseUrlValue("FIRECRAWL_URL");
	if (!baseUrl) return null;
	return firecrawlFetcher(baseUrl, keyValue("FIRECRAWL_API_KEY") || undefined);
}
