import { createProvider, envApiKeyAuth, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { piModels } from "./models.ts";

/** Ollama Cloud as a pi-ai provider (home stack integration). The server
 *  layer fetches and persists the catalog and hands entries here; this
 *  module is pure projection + install, so the agent layer never touches
 *  IO. Ollama speaks OpenAI chat-completions at `${base}/v1`. */
export const OLLAMA_PROVIDER_ID = "ollama-cloud";
export const OLLAMA_DEFAULT_BASE_URL = "https://ollama.com";

/** The slice of Ollama's `/api/tags` + `/api/show` the projection needs.
 *  `thinkingValues` is `/api/show`'s `thinking.values` (strings are named
 *  effort levels, `false` is "off", `true` is plain on) or null when the
 *  model reports no thinking support. */
export interface OllamaCatalogEntry {
	id: string;
	capabilities: string[];
	contextLength: number | null;
	thinkingValues: (string | boolean)[] | null;
}

type LevelMap = NonNullable<Model<"openai-completions">["thinkingLevelMap"]>;

const CONTEXT_FALLBACK = 131072;
const MAX_OUTPUT_TOKENS = 32768;
/** Pi's levels above "off", lowest first; a level a model does not list
 *  falls to the nearest listed one below it. */
const LADDER = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Pi's `thinkingLevelMap` for a model's `thinking.values`: pi sends the
 *  mapped string as `reasoning_effort`, and a `null` marks a level the
 *  model does not support. Boolean-only models (`[false, true]`) have no
 *  named levels, so only "medium" is offered. */
export function thinkingLevelMapFor(values: (string | boolean)[] | null): Model<"openai-completions">["thinkingLevelMap"] | undefined {
	if (!values) return undefined;
	const named = values.filter((v): v is string => typeof v === "string");
	const off = values.includes(false) ? "none" : null;
	if (named.length === 0) {
		const on = values.includes(true) ? "medium" : null;
		return { off, minimal: null, low: null, medium: on, high: null, xhigh: null, max: null };
	}
	const map: LevelMap = { off };
	let below: string | null = null;
	for (const level of LADDER) {
		if (named.includes(level)) below = level;
		map[level] = below;
	}
	return map;
}

/** One catalog entry as a pi model, or null when it cannot drive the agent
 *  loop (no `tools` capability). Cost is zero: Ollama Cloud bills by plan,
 *  not per token. */
export function projectOllamaModel(entry: OllamaCatalogEntry, baseUrl: string): Model<"openai-completions"> | null {
	if (!entry.capabilities.includes("tools")) return null;
	const contextWindow = entry.contextLength ?? CONTEXT_FALLBACK;
	const thinkingLevelMap = thinkingLevelMapFor(entry.thinkingValues);
	return {
		id: entry.id,
		name: entry.id,
		api: "openai-completions",
		provider: OLLAMA_PROVIDER_ID,
		baseUrl: `${baseUrl.replace(/\/+$/, "")}/v1`,
		reasoning: entry.capabilities.includes("thinking"),
		input: entry.capabilities.includes("vision") ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: Math.min(contextWindow, MAX_OUTPUT_TOKENS),
		compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
	};
}

/** Install the catalog as the `ollama-cloud` provider on the shared
 *  collection. Same-id `setProvider` replaces, so a refresh that drops a
 *  model drops it from the picker. The key resolves per request from
 *  OLLAMA_API_KEY (the keys seam reflects a saved key into env). */
export function installOllamaCatalog(entries: readonly OllamaCatalogEntry[], baseUrl: string): void {
	const models = entries.flatMap((entry) => projectOllamaModel(entry, baseUrl) ?? []);
	piModels().setProvider(createProvider({
		id: OLLAMA_PROVIDER_ID,
		name: "Ollama Cloud",
		baseUrl: `${baseUrl.replace(/\/+$/, "")}/v1`,
		auth: { apiKey: envApiKeyAuth("Ollama Cloud", ["OLLAMA_API_KEY"]) },
		models,
		api: openAICompletionsApi(),
	}));
}

/** The currently installed Ollama Cloud models (empty before the first
 *  install). */
export function ollamaModels(): Model<"openai-completions">[] {
	return piModels().getModels(OLLAMA_PROVIDER_ID) as Model<"openai-completions">[];
}
