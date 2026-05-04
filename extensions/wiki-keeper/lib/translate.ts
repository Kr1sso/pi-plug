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
		const stopReason = (response as { stopReason?: string }).stopReason;
		const apiErrorMessage = (response as { errorMessage?: string }).errorMessage;
		if (stopReason === "error" || stopReason === "aborted") {
			return { ok: false, text: "", error: `model ${stopReason}${apiErrorMessage ? `: ${apiErrorMessage}` : " (no errorMessage from provider)"}` };
		}
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
 * On `stopReason === "length"` we tell the model its previous reply was truncated and
 * ask for a smaller / more concise payload — retrying with the same prompt would just
 * truncate again at the same byte.
 *
 * `opts.debugDumpPath`: if set, the last bad raw response is written here for inspection.
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
	opts: {
		jsonShapeReminder?: string;
		retries?: number;
		debugDumpPath?: string;
		/** Called every ~500ms with current streamed character count. Use to update UI phase widget. */
		onProgress?: (chars: number, elapsedMs: number) => void;
		/** Hard cap on a single attempt; abort if exceeded. Default 6 minutes (large 32k-token outputs at slow tokens/sec). */
		perAttemptTimeoutMs?: number;
		/** Idle timeout: abort if no chars received for this long. Default 90s (provider stalled). */
		idleTimeoutMs?: number;
	} = {},
): Promise<{ ok: true; text: string; parsed: unknown; attempts: number } | { ok: false; text: string; error: string; attempts: number; stopReason?: string }> {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return { ok: false, text: "", error: `auth failed: ${auth.error}`, attempts: 0 };
	if (!auth.apiKey) return { ok: false, text: "", error: `no API key for ${model.provider}`, attempts: 0 };

	const maxRetries = Math.max(0, opts.retries ?? 1);
	const perAttemptTimeoutMs = opts.perAttemptTimeoutMs ?? 6 * 60_000;
	const idleTimeoutMs = opts.idleTimeoutMs ?? 90_000;
	const messages: Message[] = [
		{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() },
	];

	// Lazy-load runtime dep — see callModelText for rationale (test-env loadability).
	const { stream } = await import("@mariozechner/pi-ai");

	let lastText = "";
	let lastError = "";
	let lastStopReason: string | undefined;
	for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
		// Compose attempt-scoped abort: caller signal | per-attempt timeout | idle watchdog.
		const attemptCtl = new AbortController();
		const onCallerAbort = () => attemptCtl.abort(new Error("caller aborted"));
		signal?.addEventListener("abort", onCallerAbort, { once: true });
		const hardTimeout = setTimeout(() => attemptCtl.abort(new Error(`per-attempt timeout (${Math.round(perAttemptTimeoutMs / 1000)}s)`)), perAttemptTimeoutMs);
		let idleTimer: NodeJS.Timeout | undefined;
		const armIdleTimer = () => {
			if (idleTimer) clearTimeout(idleTimer);
			idleTimer = setTimeout(() => attemptCtl.abort(new Error(`idle timeout (no chars for ${Math.round(idleTimeoutMs / 1000)}s)`)), idleTimeoutMs);
		};
		armIdleTimer();
		const startedAt = Date.now();
		let text = "";
		let response: any = undefined;
		let streamError: Error | undefined;
		try {
			const evStream = stream(
				model,
				{ systemPrompt, messages },
				{ apiKey: auth.apiKey, headers: auth.headers, maxTokens, signal: attemptCtl.signal },
			);
			let lastProgressTick = 0;
			for await (const ev of evStream) {
				if ((ev as any).type === "text_delta") {
					const delta = (ev as any).delta as string;
					text += delta;
					armIdleTimer();
					if (opts.onProgress && Date.now() - lastProgressTick >= 500) {
						lastProgressTick = Date.now();
						try { opts.onProgress(text.length, Date.now() - startedAt); } catch {}
					}
				}
			}
			response = await evStream.result();
		} catch (err) {
			streamError = err instanceof Error ? err : new Error(String(err));
		} finally {
			clearTimeout(hardTimeout);
			if (idleTimer) clearTimeout(idleTimer);
			signal?.removeEventListener("abort", onCallerAbort);
		}

		try {
			// If stream() yielded a result message, prefer its joined text content (handles models that emit text_block sentinel events).
			if (response && Array.isArray(response.content)) {
				const joined = response.content
					.filter((c: any): c is { type: "text"; text: string } => c.type === "text")
					.map((c: any) => c.text)
					.join("\n");
				if (joined.length > text.length) text = joined;
			}
			lastText = text;
			lastStopReason = response?.stopReason;
			const apiErrorMessage = (response?.errorMessage as string | undefined) ?? streamError?.message;

			// Stream errored out (timeout, network drop, abort). Treat as transient if matches.
			if (streamError && lastStopReason !== "length") {
				const transient = /\b(terminated|fetch failed|ECONNRESET|socket hang up|network error|EAI_AGAIN|ETIMEDOUT|idle timeout|per-attempt timeout)\b/i.test(streamError.message);
				if (transient && attempt <= maxRetries && !signal?.aborted) {
					await new Promise((r) => setTimeout(r, 1500));
					continue;
				}
				return { ok: false, text: lastText, error: `model stream error: ${streamError.message}`, attempts: attempt, stopReason: lastStopReason };
			}
			// Hard API failure (rate limit, 5xx, context-too-large, auth, etc.) — most are not
			// retryable. But "transient" network errors (undici 'terminated', socket resets,
			// fetch failures) are usually safe to retry once with backoff.
			if (lastStopReason === "error" || lastStopReason === "aborted") {
				const transient = apiErrorMessage && /\b(terminated|fetch failed|ECONNRESET|socket hang up|network error|EAI_AGAIN|ETIMEDOUT)\b/i.test(apiErrorMessage);
				if (transient && attempt <= maxRetries && !signal?.aborted) {
					// Backoff briefly and retry the SAME prompt (don't add a corrective turn).
					await new Promise((r) => setTimeout(r, 1500));
					continue;
				}
				return {
					ok: false,
					text: lastText,
					error: `model ${lastStopReason}${apiErrorMessage ? `: ${apiErrorMessage}` : " (no errorMessage from provider)"}`,
					attempts: attempt,
					stopReason: lastStopReason,
				};
			}

			const parsed = extractJson(text);
			if (parsed !== undefined) return { ok: true, text, parsed, attempts: attempt };

			const truncated = lastStopReason === "length";
			lastError = truncated ? "response truncated at token limit" : "unparseable JSON";
			if (attempt > maxRetries) break;

			// Corrective turn: feed back the bad output and remind the model what we expect.
			messages.push({ role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() });
			const reminder = opts.jsonShapeReminder?.trim();
			const correctiveText = truncated
				? [
						"Your previous response was cut off at the model's token limit, so it is not parseable JSON.",
						"Reply again with a SMALLER payload that fits in the budget:",
						"• Drop low-value ops; keep only the most important changes.",
						"• Prefer `append` / `replace_section` over full-file `overwrite`.",
						"• Trim verbose `content` strings — wiki pages should be terse reference, not narrative.",
						reminder ? `Expected shape:\n${reminder}` : "",
						"Output ONLY a single valid JSON object. No prose. No fences. Begin with `{` and end with `}`.",
					]
						.filter(Boolean)
						.join("\n\n")
				: [
						"Your previous response could not be parsed as JSON.",
						"Re-read `wiki/schema.md` (provided above) and the system prompt's JSON shape specification, then reply again.",
						reminder ? `Expected shape:\n${reminder}` : "",
						"Output ONLY a single valid JSON object. No prose. No markdown fences. No commentary before or after. Begin your reply with `{` and end it with `}`.",
					]
						.filter(Boolean)
						.join("\n\n");
			messages.push({ role: "user", content: [{ type: "text", text: correctiveText }], timestamp: Date.now() });
		} catch (err) {
			return { ok: false, text: lastText, error: err instanceof Error ? err.message : String(err), attempts: attempt, stopReason: lastStopReason };
		}
	}

	// Persist the last bad payload for offline inspection.
	if (opts.debugDumpPath && lastText) {
		try {
			const { mkdirSync, writeFileSync } = await import("node:fs");
			const { dirname } = await import("node:path");
			mkdirSync(dirname(opts.debugDumpPath), { recursive: true });
			const header = `// Captured ${new Date().toISOString()} | stopReason=${lastStopReason ?? "unknown"} | error=${lastError}\n// length=${lastText.length} chars\n\n`;
			writeFileSync(opts.debugDumpPath, header + lastText);
		} catch {}
	}

	const snippet = lastText
		? ` | head: ${JSON.stringify(lastText.slice(0, 160))}${lastText.length > 160 ? "…" : ""} | tail: ${JSON.stringify(lastText.slice(-120))}`
		: "";
	const dumpHint = opts.debugDumpPath && lastText ? ` | dumped to ${opts.debugDumpPath}` : "";
	return {
		ok: false,
		text: lastText,
		error: `${lastError} after ${maxRetries + 1} attempt(s) (stopReason=${lastStopReason ?? "unknown"}, ${lastText.length} chars)${snippet}${dumpHint}`,
		attempts: maxRetries + 1,
		stopReason: lastStopReason,
	};
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
