"use client";

import { CUSTOM_PROVIDER_KEYS, type AuthKeyStatus, type OllamaCatalogStatusDto } from "@/src/core";
import { KeyTableRow } from "./keys-section.tsx";

const OLLAMA = CUSTOM_PROVIDER_KEYS.find((p) => p.envVar === "OLLAMA_API_KEY")!;

/** "just now" / "3 min ago" / "2 h ago" / "4 d ago". Pure — exported for tests. */
export function relativeTime(ts: number, now: number): string {
	const s = Math.max(0, Math.round((now - ts) / 1000));
	if (s < 60) return "just now";
	const m = Math.floor(s / 60);
	if (m < 60) return `${m} min ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h} h ago`;
	return `${Math.floor(h / 24)} d ago`;
}

/** The muted catalog line under the Ollama Cloud key row: the last refresh
 *  failure wins, else "<n> models · refreshed <when>"; null without a key
 *  (nothing to refresh) or before the first status arrives. Pure. */
export function ollamaCatalogLine(
	present: boolean,
	catalog: OllamaCatalogStatusDto | undefined,
	now: number,
): string | null {
	if (!present || !catalog) return null;
	if (catalog.error) return catalog.error;
	const count = `${catalog.models} ${catalog.models === 1 ? "model" : "models"}`;
	return `${count} · ${catalog.refreshedAt === null ? "not refreshed yet" : `refreshed ${relativeTime(catalog.refreshedAt, now)}`}`;
}

/** The Ollama Cloud subscription row: the shared key row plus the catalog
 *  status line (model count + freshness, or why the last refresh failed). */
export function OllamaConnection({
	status,
	catalog,
	expanded,
	onToggle,
	onSave,
	onDelete,
	onCancel,
}: {
	status: AuthKeyStatus;
	catalog: OllamaCatalogStatusDto | undefined;
	expanded: boolean;
	onToggle: () => void;
	onSave: (value: string) => Promise<string | null>;
	onDelete: () => Promise<void>;
	onCancel: () => void;
}) {
	const line = ollamaCatalogLine(status.present, catalog, Date.now());
	return (
		<>
			<KeyTableRow
				label={OLLAMA.label}
				docsUrl="https://ollama.com/settings/keys"
				status={status}
				expanded={expanded}
				onToggle={onToggle}
				onSave={onSave}
				onDelete={onDelete}
				onCancel={onCancel}
				testid={`key-${status.id.toLowerCase()}`}
			/>
			{line && (
				<p data-testid="ollama-catalog-status" className="px-1 pb-1 text-[11px] text-muted-foreground">
					{line}
				</p>
			)}
		</>
	);
}
