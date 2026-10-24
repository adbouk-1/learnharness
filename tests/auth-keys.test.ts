/**
 * The curated auth-key catalog + shape rules (auth-keys wave, 2026-09-19;
 * search wave 2026-09-20: the Google CSE pair retired, Tavily + Brave in)
 * — PURE module, so this file owns no fs. Owner decisions being pinned:
 *  - the catalog is exactly the three known keys, ids = env-var names;
 *  - validation is SHAPE-ONLY (no live pings) and bad pastes are 400s;
 *  - masking is last-4 + length — plaintext never leaves the store.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	AUTH_KEYS,
	AUTH_PROVIDER_KEYS,
	CUSTOM_PROVIDER_KEYS,
	genericProviderKeyGuard,
	isKnownAuthKey,
	maskKey,
	normalizeBaseUrl,
	validateKeyShape,
} from "../src/core/auth-keys.ts";

describe("the catalog", () => {
	it("is exactly the three CURATED app-service keys (provider keys live in the provider table)", () => {
		assert.deepEqual(
			AUTH_KEYS.map((k) => k.id),
			["DEEPGRAM_API_KEY", "TAVILY_API_KEY", "BRAVE_API_KEY", "SEARXNG_URL", "FIRECRAWL_URL", "FIRECRAWL_API_KEY"],
		);
		for (const k of AUTH_KEYS) {
			assert.ok(k.label.length > 0, `${k.id} has a label`);
			assert.ok(k.description.length > 0, `${k.id} has a description`);
			assert.ok(k.docsUrl.startsWith("https://"), `${k.id} has a docs link`);
		}
		// OPENROUTER_API_KEY graduated to the provider table (owner decision,
		// provider-keys interlude) — not curated anymore. The Google CSE
		// pair retired with its engine (search wave, 2026-09-20).
		assert.ok(!isKnownAuthKey("OPENROUTER_API_KEY"));
		assert.ok(!isKnownAuthKey("GOOGLE_SEARCH_API_KEY"), "the CSE pair is retired");
		assert.ok(!isKnownAuthKey("GOOGLE_CSE_ID"));
	});

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

	it("isKnownAuthKey: catalog yes, everything else no", () => {
		assert.ok(isKnownAuthKey("DEEPGRAM_API_KEY"));
		assert.ok(isKnownAuthKey("TAVILY_API_KEY"));
		assert.ok(isKnownAuthKey("BRAVE_API_KEY"));
		assert.ok(!isKnownAuthKey("OPENROUTER_API_KEY"));
		assert.ok(!isKnownAuthKey("OPENAI_API_KEY"), "provider vars are a separate surface");
		assert.ok(!isKnownAuthKey("FUTURE_PLANS_TOKEN"));
		assert.ok(!isKnownAuthKey(""));
	});
});

describe("validateKeyShape (the 400 gate — curated keys)", () => {
	it("Tavily: tvly- prefix required, length floor past it", () => {
		assert.ok(validateKeyShape("TAVILY_API_KEY", "tvly-abc123def456ghi78").ok);
		assert.ok(!validateKeyShape("TAVILY_API_KEY", "sk-or-v1-abcdefghij").ok, "wrong family");
		assert.ok(!validateKeyShape("TAVILY_API_KEY", "tvly-").ok, "prefix alone is a truncation");
		assert.ok(!validateKeyShape("TAVILY_API_KEY", "  ").ok, "empty fails");
	});

	it("Brave: no public format — a ≥20-char truncation guard, no whitespace", () => {
		assert.ok(validateKeyShape("BRAVE_API_KEY", "b".repeat(40)).ok);
		assert.ok(!validateKeyShape("BRAVE_API_KEY", "b".repeat(19)).ok, "truncated paste");
		assert.ok(!validateKeyShape("BRAVE_API_KEY", "has whitespace here").ok);
	});

	it("Deepgram: no public format — a ≥20-char truncation guard, no whitespace", () => {
		assert.ok(validateKeyShape("DEEPGRAM_API_KEY", "a".repeat(40)).ok);
		assert.ok(!validateKeyShape("DEEPGRAM_API_KEY", "a".repeat(19)).ok, "truncated paste");
		assert.ok(!validateKeyShape("DEEPGRAM_API_KEY", "a b c d e f g h i j k l m n o p q r s").ok, "whitespace");
	});

	it("trims surrounding paste whitespace before checking", () => {
		assert.ok(validateKeyShape("DEEPGRAM_API_KEY", `  ${"d".repeat(40)}  `).ok);
	});

	it("unknown ids are rejected with the supported list", () => {
		const r = validateKeyShape("SOMETHING_ELSE", "whatever");
		assert.ok(!r.ok);
		if (!r.ok) assert.match(r.error, /SOMETHING_ELSE.*DEEPGRAM_API_KEY/);
	});
});

describe("genericProviderKeyGuard (model-provider keys — paste hygiene only)", () => {
	it("accepts any ≥12-char whitespace-free value (families vary)", () => {
		assert.deepEqual(genericProviderKeyGuard("OPENROUTER_API_KEY", "sk-or-v1-abc123"), { ok: true });
		assert.deepEqual(genericProviderKeyGuard("OPENAI_API_KEY", "whaterver-value-here"), { ok: true });
		assert.deepEqual(genericProviderKeyGuard("HF_TOKEN", "hf_xxxxxxxx9999"), { ok: true });
	});

	it("rejects truncations and whitespace — the only guards", () => {
		const short = genericProviderKeyGuard("ZAI_API_KEY", "short");
		assert.ok(!short.ok);
		if (!short.ok) assert.match(short.error, /at least 12/);
		assert.ok(!genericProviderKeyGuard("OPENAI_API_KEY", "has whitespace now").ok);
		assert.ok(!genericProviderKeyGuard("OPENAI_API_KEY", "   ").ok);
	});

	it("trims before checking", () => {
		assert.ok(genericProviderKeyGuard("OPENROUTER_API_KEY", "  sk-or-v1-xyz999  ").ok);
	});
});

describe("maskKey (plaintext never leaves)", () => {
	it("shows the last 4 only", () => {
		assert.equal(maskKey("sk-or-v1-abcdefgh1234"), "…1234");
	});

	it("never reveals a degenerate short value in full", () => {
		assert.equal(maskKey("ab"), "…ab");
		assert.equal(maskKey("abcd"), "…abcd");
		assert.equal(maskKey("abcde"), "…bcde");
	});

	it("trims before masking", () => {
		assert.equal(maskKey("  sk-or-v1-xyzw9  "), "…yzw9");
	});
});
