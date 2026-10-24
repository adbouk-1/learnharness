import { test, after } from "node:test";
import assert from "node:assert/strict";
import { piModels } from "../src/agent/models.ts";
import {
	installOllamaCatalog,
	ollamaModels,
	projectOllamaModel,
	thinkingLevelMapFor,
	OLLAMA_PROVIDER_ID,
	type OllamaCatalogEntry,
} from "../src/agent/ollama-cloud.ts";

const gemma: OllamaCatalogEntry = {
	id: "gemma4:31b",
	capabilities: ["completion", "tools", "thinking", "vision"],
	contextLength: 131072,
	thinkingValues: [false, true],
};

// The provider lives in the process-wide piModels() collection; leave it empty.
after(() => installOllamaCatalog([], "https://ollama.com"));

test("gpt-oss values map named levels, no off", () => {
	assert.deepEqual(thinkingLevelMapFor(["low", "medium", "high"]), {
		off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "high", max: "high",
	});
});

test("kimi-k3 values: off → none, medium falls to low, max kept", () => {
	assert.deepEqual(thinkingLevelMapFor([false, "low", "high", "max"]), {
		off: "none", minimal: null, low: "low", medium: "low", high: "high", xhigh: "high", max: "max",
	});
});

test("boolean-only models: off → none, medium → medium, others null", () => {
	assert.deepEqual(thinkingLevelMapFor([false, true]), {
		off: "none", minimal: null, low: null, medium: "medium", high: null, xhigh: null, max: null,
	});
});

test("no thinking values → undefined", () => {
	assert.equal(thinkingLevelMapFor(null), undefined);
});

test("projectOllamaModel projects a tool-capable vision thinking model", () => {
	const model = projectOllamaModel(gemma, "https://ollama.com")!;
	assert.equal(model.id, "gemma4:31b");
	assert.equal(model.provider, "ollama-cloud");
	assert.equal(model.api, "openai-completions");
	assert.equal(model.baseUrl, "https://ollama.com/v1");
	assert.deepEqual(model.input, ["text", "image"]);
	assert.equal(model.reasoning, true);
	assert.equal(model.contextWindow, 131072);
	assert.equal(model.maxTokens, 32768);
	assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	assert.equal(model.compat?.supportsDeveloperRole, false);
	assert.equal(model.compat?.supportsReasoningEffort, true);
	assert.deepEqual(model.thinkingLevelMap, thinkingLevelMapFor([false, true]));
});

test("a trailing slash on the base URL does not double up", () => {
	assert.equal(projectOllamaModel(gemma, "https://ollama.com/")!.baseUrl, "https://ollama.com/v1");
});

test("models without the tools capability are excluded", () => {
	assert.equal(projectOllamaModel({ ...gemma, capabilities: ["completion", "thinking"] }, "https://ollama.com"), null);
});

test("context falls back to 131072 and caps maxTokens at the context", () => {
	assert.equal(projectOllamaModel({ ...gemma, contextLength: null }, "https://ollama.com")!.contextWindow, 131072);
	const small = projectOllamaModel({ ...gemma, contextLength: 16000 }, "https://ollama.com")!;
	assert.equal(small.contextWindow, 16000);
	assert.equal(small.maxTokens, 16000);
});

test("non-thinking text-only models project without reasoning, image input or level map", () => {
	const model = projectOllamaModel({ id: "plain", capabilities: ["completion", "tools"], contextLength: 8192, thinkingValues: null }, "https://ollama.com")!;
	assert.equal(model.reasoning, false);
	assert.deepEqual(model.input, ["text"]);
	assert.equal(model.thinkingLevelMap, undefined);
});

test("installOllamaCatalog replaces the provider's catalog rather than merging", () => {
	installOllamaCatalog([gemma], "https://ollama.com");
	assert.ok(piModels().getModel(OLLAMA_PROVIDER_ID, "gemma4:31b"));
	assert.deepEqual(ollamaModels().map((m) => m.id), ["gemma4:31b"]);
	installOllamaCatalog([], "https://ollama.com");
	assert.equal(piModels().getModel(OLLAMA_PROVIDER_ID, "gemma4:31b"), undefined);
	assert.deepEqual(ollamaModels(), []);
});

test("installOllamaCatalog skips entries that cannot call tools", () => {
	installOllamaCatalog([gemma, { ...gemma, id: "no-tools", capabilities: ["completion"] }], "https://ollama.com");
	assert.deepEqual(ollamaModels().map((m) => m.id), ["gemma4:31b"]);
});
