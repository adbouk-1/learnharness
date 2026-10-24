/**
 * The Ollama Cloud catalog's lifecycle (home stack integration,
 * 2026-10-24): fetch it from Ollama's public `/api/tags` + `/api/show`,
 * persist the last good copy (src/store/ollama-catalog.ts), install it into
 * the app's pi-ai collection (src/agent/ollama-cloud.ts does the pure
 * projection), refresh it when stale or when the key changes, and surface
 * its status for the settings page.
 *
 * Boot is network-free: at first import the stored copy is installed
 * synchronously, so a start offline still has the model list. A refresh
 * never throws and never degrades what is installed — a failure keeps the
 * last good catalog and records the error in the status instead.
 *
 * Both endpoints answer without a key, but the refresh runs only while an
 * OLLAMA_API_KEY is present: the provider is federated into the picker by
 * its key, so a keyless catalog would be unreachable anyway.
 */

import { normalizeBaseUrl } from "../core/auth-keys.ts";
import {
	OLLAMA_DEFAULT_BASE_URL,
	OLLAMA_PROVIDER_ID,
	installOllamaCatalog,
	ollamaModels,
	type OllamaCatalogEntry,
} from "../agent/ollama-cloud.ts";
import { readOllamaCatalog, writeOllamaCatalog } from "../store/ollama-catalog.ts";
import { onAuthKeyChange, providerKeyPresent } from "./keys.ts";

/** The wire-callable shape the adapter closes over (tests inject a stub). */
type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** A catalog older than this is refreshed by the next non-forced refresh. */
const STALE_MS = 10 * 60_000;
/** After a failed non-forced refresh, the next one waits this long — the
 *  catalog route calls the refresh on every GET, and an unreachable host
 *  must not cost a request timeout each time. */
const RETRY_AFTER_FAILURE_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
/** One whole refresh (tags + every show) is abandoned after this — the
 *  per-request timeouts alone would allow minutes on a hung host. */
const REFRESH_DEADLINE_MS = 20_000;
const SHOW_CONCURRENCY = 4;

/** The configured Ollama host: OLLAMA_BASE_URL (env-only, normalized — an
 *  invalid value falls back rather than breaking the catalog), else
 *  ollama.com. */
export function ollamaBaseUrl(): string {
	const raw = process.env.OLLAMA_BASE_URL;
	if (!raw) return OLLAMA_DEFAULT_BASE_URL;
	const normalized = normalizeBaseUrl(raw);
	return normalized.ok ? normalized.value : OLLAMA_DEFAULT_BASE_URL;
}

async function getJson(fetchFn: FetchLike, url: string, init: RequestInit, deadline?: AbortSignal): Promise<unknown> {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const resp = await fetchFn(url, { ...init, signal: deadline ? AbortSignal.any([timeout, deadline]) : timeout });
	if (!resp.ok) throw new Error(`${url} answered ${resp.status}`);
	return resp.json();
}

/** `model_info`'s context length lives under an architecture-specific key
 *  (`gptoss.context_length`, `gemma4.context_length`, …) — the first key
 *  ending `.context_length` wins. */
function contextLengthOf(show: Record<string, unknown>): number | null {
	const info = show.model_info;
	if (!info || typeof info !== "object") return null;
	for (const [key, value] of Object.entries(info)) {
		if (key.endsWith(".context_length") && typeof value === "number") return value;
	}
	return null;
}

function thinkingValuesOf(show: Record<string, unknown>): (string | boolean)[] | null {
	const thinking = show.thinking;
	if (!thinking || typeof thinking !== "object") return null;
	const values = (thinking as Record<string, unknown>).values;
	if (!Array.isArray(values)) return null;
	return values.filter((v): v is string | boolean => typeof v === "string" || typeof v === "boolean");
}

function capabilitiesOf(raw: unknown): string[] {
	return Array.isArray(raw) ? raw.filter((c): c is string => typeof c === "string") : [];
}

/** The live catalog: `/api/tags` lists the models, then `/api/show` per
 *  model (4 at a time) adds the context length and thinking values. A
 *  failed `/api/show` keeps that model with null details (the projection
 *  falls back to its defaults); a failed `/api/tags` rejects. `deadline`
 *  aborts every request still in flight and rejects the whole fetch (a
 *  half-fetched catalog is never returned). */
export async function fetchOllamaCatalog(
	baseUrl: string,
	fetchFn: FetchLike = fetch,
	deadline?: AbortSignal,
): Promise<OllamaCatalogEntry[]> {
	const tags = (await getJson(fetchFn, `${baseUrl}/api/tags`, { method: "GET" }, deadline)) as { models?: unknown };
	const listed = (Array.isArray(tags.models) ? tags.models : []).flatMap((m): { id: string; capabilities: string[] }[] => {
		const model = m as { name?: unknown; capabilities?: unknown } | null;
		return typeof model?.name === "string" ? [{ id: model.name, capabilities: capabilitiesOf(model.capabilities) }] : [];
	});
	const entries: OllamaCatalogEntry[] = new Array(listed.length);
	let next = 0;
	async function worker(): Promise<void> {
		while (next < listed.length) {
			const i = next++;
			const { id, capabilities } = listed[i]!;
			try {
				const show = (await getJson(fetchFn, `${baseUrl}/api/show`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ model: id }),
				}, deadline)) as Record<string, unknown>;
				const shown = capabilitiesOf(show.capabilities);
				entries[i] = {
					id,
					capabilities: shown.length > 0 ? shown : capabilities,
					contextLength: contextLengthOf(show),
					thinkingValues: thinkingValuesOf(show),
				};
			} catch {
				entries[i] = { id, capabilities, contextLength: null, thinkingValues: null };
			}
		}
	}
	await Promise.all(Array.from({ length: Math.min(SHOW_CONCURRENCY, listed.length) }, worker));
	// Past the deadline every remaining /api/show failed by abort, not by the
	// model — those null-detail entries are an artifact, not a catalog.
	deadline?.throwIfAborted();
	return entries;
}

// The once-per-process lifecycle record — globalThis anchor (HMR re-imports
// this module; the boot load and the key subscription must not run twice).
interface CatalogState {
	booted: boolean;
	inflight: Promise<void> | null;
	refreshedAt: number | null;
	failedAt: number | null;
	error: string | null;
}
const STATE_KEY = Symbol.for("lh.ollamaCatalog");

function state(): CatalogState {
	const g = globalThis as Record<symbol, CatalogState | undefined>;
	if (!g[STATE_KEY]) g[STATE_KEY] = { booted: false, inflight: null, refreshedAt: null, failedAt: null, error: null };
	return g[STATE_KEY];
}

/** Install the stored catalog, no network — sync, once per process (module
 *  load runs it). Absent/invalid file, or a copy fetched from a different
 *  host than OLLAMA_BASE_URL now names, installs nothing and the first
 *  refresh fills it. `again` re-runs the load (tests). */
export function ensureOllamaCatalog(opts: { again?: boolean } = {}): void {
	const s = state();
	if (s.booted && !opts.again) return;
	s.booted = true;
	s.refreshedAt = null;
	s.failedAt = null;
	s.error = null;
	const stored = readOllamaCatalog();
	if (!stored || stored.baseUrl !== ollamaBaseUrl()) return;
	installOllamaCatalog(stored.entries, stored.baseUrl);
	s.refreshedAt = stored.fetchedAt;
}

function describeError(err: unknown): string {
	if (!(err instanceof Error)) return String(err);
	const cause = err.cause instanceof Error ? ` (${err.cause.message})` : "";
	return `${err.message}${cause}`;
}

/** Whether process start kicks a refresh: not under the test runner, so
 *  test processes stay network-free. */
export function bootRefreshEnabled(nodeEnv: string | undefined): boolean {
	return nodeEnv !== "test";
}

/** Refresh the catalog: fetch, install, persist. Never throws. Does
 *  nothing without an OLLAMA_API_KEY; without `force`, also nothing while
 *  the catalog is fresh (10 minutes) or a recent attempt just failed.
 *  Single-flight: concurrent callers share one run. A failure keeps the
 *  installed catalog and the file, sets the status error and logs it. The
 *  whole run is bounded by `deadlineMs` (default 20 s). */
export async function refreshOllamaCatalog(
	opts: { force?: boolean; fetchFn?: FetchLike; now?: () => number; deadlineMs?: number } = {},
): Promise<void> {
	if (!providerKeyPresent(OLLAMA_PROVIDER_ID)) return;
	const s = state();
	if (s.inflight) return s.inflight;
	const now = opts.now ?? Date.now;
	if (!opts.force) {
		const t = now();
		if (s.failedAt !== null && t - s.failedAt < RETRY_AFTER_FAILURE_MS) return;
		if (s.refreshedAt !== null && t - s.refreshedAt < STALE_MS) return;
	}
	const baseUrl = ollamaBaseUrl();
	s.inflight = (async () => {
		try {
			const entries = await fetchOllamaCatalog(baseUrl, opts.fetchFn, AbortSignal.timeout(opts.deadlineMs ?? REFRESH_DEADLINE_MS));
			if (entries.length === 0) throw new Error("the host listed no models");
			const fetchedAt = now();
			installOllamaCatalog(entries, baseUrl);
			writeOllamaCatalog({ version: 1, baseUrl, fetchedAt, entries });
			s.refreshedAt = fetchedAt;
			s.failedAt = null;
			s.error = null;
		} catch (err) {
			s.failedAt = now();
			s.error = `Ollama catalog refresh failed: ${describeError(err)}`;
			console.warn(s.error);
		} finally {
			s.inflight = null;
		}
	})();
	return s.inflight;
}

/** What the settings page shows: the installed model count (tool-capable
 *  models only — the picker's truth), when the catalog was last fetched
 *  (null: never), and the last refresh failure (null: none). */
export interface OllamaCatalogStatus {
	models: number;
	refreshedAt: number | null;
	error: string | null;
}

export function ollamaCatalogStatus(): OllamaCatalogStatus {
	const s = state();
	return { models: ollamaModels().length, refreshedAt: s.refreshedAt, error: s.error };
}

// Boot, once per process: install the stored catalog, re-fetch (forced)
// whenever the Ollama key is saved or removed — a new key is the moment the
// catalog becomes reachable — and kick one stale-gated refresh now (covers a
// key that came from the real env, where no save ever runs). All inside the
// same guard so an HMR re-import does not double any of it.
if (!state().booted) {
	ensureOllamaCatalog();
	onAuthKeyChange((id) => {
		if (id === "OLLAMA_API_KEY") void refreshOllamaCatalog({ force: true });
	});
	if (bootRefreshEnabled(process.env.NODE_ENV)) void refreshOllamaCatalog();
}
