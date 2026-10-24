/**
 * The page-fetcher port (home-stack integration, 2026-10-24).
 *
 * web_fetch can run through a pluggable page-rendering service instead of
 * the local Readability reader — today the self-hosted Firecrawl. The
 * adapter (src/server/firecrawl.ts) arrives as an injected dependency
 * (import law: the agent-layer tool depends on THIS port only, never on
 * server code). A null fetcher means "not configured": web_fetch then
 * behaves exactly as it did before the port existed.
 *
 * Pure types (browser-safe, no node imports).
 */

/** One fetched page — the shape every adapter must produce. */
export interface FetchedPage {
	title: string;
	/** The page's main content as markdown. */
	markdown: string;
	/** The URL after redirects (falls back to the requested URL). */
	finalUrl: string;
	status: number;
	contentType: string | null;
}

export interface PageFetcher {
	id: "firecrawl";
	/** Rejects with a readable Error on any failure (the tool turns it into a
	 *  fallback, never a crash). */
	fetch(url: string): Promise<FetchedPage>;
}
