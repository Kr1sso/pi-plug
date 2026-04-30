import type { Message, Model } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { WikiKeeperSettings } from "./settings.js";
/** Resolve the model to use for translation: explicit override, else current ctx.model. */
export function resolveTranslationModel(
	ctx: ExtensionContext,
	settings: WikiKeeperSettings,
): { model: Model<any>; reason: "override" | "ctx" } | { model: undefined; error: string } {
	if (settings.translationModelId && settings.translationModelProvider) {
		const m = ctx.modelRegistry.find(settings.translationModelProvider, settings.translationModelId);
		if (m) return { model: m, reason: "override" };
	}
	if (ctx.model) return { model: ctx.model, reason: "ctx" };
	return { model: undefined, error: "No model selected and no override configured" };
}

export interface CallResult {
	ok: boolean;
	text: string;
	error?: string;
}

export async function callModelText(
	ctx: ExtensionContext,
	model: Model<any>,
	systemPrompt: string,
	userText: string,
	signal: AbortSignal | undefined,
	maxTokens = 8192,
): Promise<CallResult> {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return { ok: false, text: "", error: `auth failed: ${auth.error}` };
	if (!auth.apiKey) return { ok: false, text: "", error: `no API key for ${model.provider}` };

	const messages: Message[] = [
		{
			role: "user",
			content: [{ type: "text", text: userText }],
			timestamp: Date.now(),
		},
	];
	try {
		// Lazy-load the runtime dependency so this module is loadable in test
		// environments where @mariozechner/pi-ai is not installed (e.g. plain node
		// outside the pi runtime). The import resolves at call time, by which point
		// pi has already injected its node_modules into the resolver path.
		const { complete } = await import("@mariozechner/pi-ai");
		const response = await complete(
			model,
			{ systemPrompt, messages },
			{ apiKey: auth.apiKey, headers: auth.headers, maxTokens, signal },
		);
		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		return { ok: true, text };
	} catch (err) {
		return { ok: false, text: "", error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Call the model and parse its response as JSON. If the first response is not parseable,
 * retry once with a corrective follow-up that quotes the expected shape and reminds the
 * model to consult wiki/schema.md before answering.
 *
 * Returns the parsed JSON plus the raw text and number of attempts (1 or 2).
 */
export async function callModelTextJson(
	ctx: ExtensionContext,
	model: Model<any>,
	systemPrompt: string,
	userText: string,
	signal: AbortSignal | undefined,
	maxTokens = 8192,
	opts: { jsonShapeReminder?: string; retries?: number } = {},
): Promise<{ ok: true; text: string; parsed: unknown; attempts: number } | { ok: false; text: string; error: string; attempts: number }> {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return { ok: false, text: "", error: `auth failed: ${auth.error}`, attempts: 0 };
	if (!auth.apiKey) return { ok: false, text: "", error: `no API key for ${model.provider}`, attempts: 0 };

	const maxRetries = Math.max(0, opts.retries ?? 1);
	const messages: Message[] = [
		{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() },
	];

	// Lazy-load runtime dep — see callModelText for rationale (test-env loadability).
	const { complete } = await import("@mariozechner/pi-ai");

	let lastText = "";
	let lastError = "";
	for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
		try {
			const response = await complete(
				model,
				{ systemPrompt, messages },
				{ apiKey: auth.apiKey, headers: auth.headers, maxTokens, signal },
			);
			const text = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			lastText = text;
			const parsed = extractJson(text);
			if (parsed !== undefined) return { ok: true, text, parsed, attempts: attempt };

			lastError = "unparseable JSON";
			if (attempt > maxRetries) break;

			// Corrective turn: feed back the bad output and remind the model what we expect.
			messages.push({ role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() });
			const reminder = opts.jsonShapeReminder?.trim();
			const correctiveText = [
				"Your previous response could not be parsed as JSON.",
				"Re-read `wiki/schema.md` (provided above) and the system prompt's JSON shape specification, then reply again.",
				reminder ? `Expected shape:\n${reminder}` : "",
				"Output ONLY a single valid JSON object. No prose. No markdown fences. No commentary before or after. Begin your reply with `{` and end it with `}`.",
			]
				.filter(Boolean)
				.join("\n\n");
			messages.push({ role: "user", content: [{ type: "text", text: correctiveText }], timestamp: Date.now() });
		} catch (err) {
			return { ok: false, text: lastText, error: err instanceof Error ? err.message : String(err), attempts: attempt };
		}
	}
	return { ok: false, text: lastText, error: `${lastError} after ${maxRetries + 1} attempt(s)`, attempts: maxRetries + 1 };
}

/** Best-effort JSON extraction: tolerates code fences and surrounding chatter. */
export function extractJson(raw: string): unknown | undefined {
	const trimmed = raw.trim();
	const tryParse = (s: string) => {
		try {
			return JSON.parse(s);
		} catch {
			return undefined;
		}
	};
	const direct = tryParse(trimmed);
	if (direct !== undefined) return direct;
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenced) {
		const f = tryParse(fenced[1].trim());
		if (f !== undefined) return f;
	}
	const firstBrace = trimmed.indexOf("{");
	const lastBrace = trimmed.lastIndexOf("}");
	if (firstBrace >= 0 && lastBrace > firstBrace) {
		return tryParse(trimmed.slice(firstBrace, lastBrace + 1));
	}
	return undefined;
}
