/**
 * The Ollama Cloud catalog's disk copy (home stack integration,
 * 2026-10-24): the last good `/api/tags` + `/api/show` result at
 * data/catalogs/ollama-cloud.json, so a start without network still has
 * the model list (src/server/ollama-cloud.ts installs it at boot). Never
 * throws on read — absent, corrupt or foreign-version = null = "no
 * catalog yet", the documented first-boot state (settings doctrine).
 */

import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import type { OllamaCatalogEntry } from "../agent/ollama-cloud.ts";

export interface StoredOllamaCatalog {
	version: 1;
	/** The host the entries were fetched from — a different OLLAMA_BASE_URL
	 *  invalidates the copy. */
	baseUrl: string;
	/** Epoch ms of the fetch. */
	fetchedAt: number;
	entries: OllamaCatalogEntry[];
}

const DEFAULT_FILE = path.join(PATHS.catalogs, "ollama-cloud.json");

function validEntry(raw: unknown): raw is OllamaCatalogEntry {
	if (!raw || typeof raw !== "object") return false;
	const e = raw as Record<string, unknown>;
	return (
		typeof e.id === "string" &&
		Array.isArray(e.capabilities) &&
		e.capabilities.every((c) => typeof c === "string") &&
		(e.contextLength === null || typeof e.contextLength === "number") &&
		(e.thinkingValues === null ||
			(Array.isArray(e.thinkingValues) && e.thinkingValues.every((v) => typeof v === "string" || typeof v === "boolean")))
	);
}

/** The stored catalog, or null when absent or invalid. */
export function readOllamaCatalog(file: string = DEFAULT_FILE): StoredOllamaCatalog | null {
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown> | null;
		if (!raw || typeof raw !== "object") return null;
		if (raw.version !== 1 || typeof raw.baseUrl !== "string" || typeof raw.fetchedAt !== "number") return null;
		if (!Array.isArray(raw.entries) || !raw.entries.every(validEntry)) return null;
		return { version: 1, baseUrl: raw.baseUrl, fetchedAt: raw.fetchedAt, entries: raw.entries };
	} catch {
		return null;
	}
}

/** Write atomically (tmp in the same dir + rename): a partial write must
 *  never leave a truncated file that reads as "no catalog". */
export function writeOllamaCatalog(catalog: StoredOllamaCatalog, file: string = DEFAULT_FILE): void {
	const dir = path.dirname(file);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}`);
	fs.writeFileSync(tmp, `${JSON.stringify(catalog)}\n`);
	fs.renameSync(tmp, file);
}
