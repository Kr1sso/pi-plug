import { complete, type Message, type Model } from "@mariozechner/pi-ai";
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
