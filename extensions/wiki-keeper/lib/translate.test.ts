import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractJson, resolveTranslationModel } from "./translate.ts";

describe("translate — extractJson", () => {
	it("parses a direct JSON object", () => {
		assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
	});

	it("parses a direct JSON array", () => {
		assert.deepEqual(extractJson('[1, 2, 3]'), [1, 2, 3]);
	});

	it("parses inside ```json fences", () => {
		const r = extractJson("```json\n{\"x\": true}\n```");
		assert.deepEqual(r, { x: true });
	});

	it("parses inside bare ``` fences", () => {
		const r = extractJson("```\n{\"x\": true}\n```");
		assert.deepEqual(r, { x: true });
	});

	it("falls back to brace-slicing when surrounded by prose", () => {
		const r = extractJson('Sure! Here you go: {"foo": "bar"}\nThanks');
		assert.deepEqual(r, { foo: "bar" });
	});

	it("returns undefined for unparseable garbage", () => {
		assert.equal(extractJson("totally not json"), undefined);
	});

	it("returns undefined for malformed JSON inside fences", () => {
		assert.equal(extractJson("```json\n{broken}\n```"), undefined);
	});

	it("trims surrounding whitespace before parse", () => {
		assert.deepEqual(extractJson("\n\n  {\"k\":1}\n\n"), { k: 1 });
	});

	it("parses nested objects", () => {
		assert.deepEqual(extractJson('{"a":{"b":{"c":[1,2]}}}'), { a: { b: { c: [1, 2] } } });
	});
});

// ─── resolveTranslationModel ─────────────────────────────────────────

interface FakeModel {
	id: string;
	provider: string;
	contextWindow: number;
}

function makeCtx(opts: { model?: FakeModel; registryHas?: FakeModel[] }) {
	const registry = opts.registryHas ?? [];
	return {
		model: opts.model,
		modelRegistry: {
			find: (provider: string, id: string) =>
				registry.find((m) => m.provider === provider && m.id === id),
		},
	} as any;
}

describe("translate — resolveTranslationModel", () => {
	it("uses ctx.model when no override configured", () => {
		const m = { id: "claude-x", provider: "anthropic", contextWindow: 200_000 };
		const ctx = makeCtx({ model: m });
		const r = resolveTranslationModel(ctx, {
			translationModelId: "",
			translationModelProvider: "",
		} as any);
		assert.ok("model" in r && r.model === m);
		assert.equal((r as any).reason, "ctx");
	});

	it("uses override when both id and provider set and registry has it", () => {
		const ctxModel = { id: "claude-x", provider: "anthropic", contextWindow: 200_000 };
		const override = { id: "haiku", provider: "anthropic", contextWindow: 200_000 };
		const ctx = makeCtx({ model: ctxModel, registryHas: [override] });
		const r = resolveTranslationModel(ctx, {
			translationModelId: "haiku",
			translationModelProvider: "anthropic",
		} as any);
		assert.ok("model" in r && r.model === override);
		assert.equal((r as any).reason, "override");
	});

	it("falls back to ctx.model when override not in registry", () => {
		const ctxModel = { id: "claude-x", provider: "anthropic", contextWindow: 200_000 };
		const ctx = makeCtx({ model: ctxModel, registryHas: [] });
		const r = resolveTranslationModel(ctx, {
			translationModelId: "missing",
			translationModelProvider: "missing",
		} as any);
		assert.ok("model" in r && r.model === ctxModel);
		assert.equal((r as any).reason, "ctx");
	});

	it("returns error when no model anywhere", () => {
		const ctx = makeCtx({ model: undefined, registryHas: [] });
		const r = resolveTranslationModel(ctx, {
			translationModelId: "",
			translationModelProvider: "",
		} as any);
		assert.equal((r as any).model, undefined);
		assert.match((r as any).error, /no model/i);
	});
});
