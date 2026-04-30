import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import {
	convertToLlm,
	serializeConversation,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionCommandContext,
	type SessionEntry,
} from "@mariozechner/pi-coding-agent";

import { loadSettings, resolveWikiPaths, type WikiKeeperSettings } from "./lib/settings.js";
import {
	applyOps,
	ensureWikiTree,
	formatLintReport,
	lintWiki,
	readFileIfExists,
	type WikiOp,
} from "./lib/wiki-fs.js";
import { qmdAvailable, qmdEmbed, qmdEnsureCollection, qmdQuery, qmdStatus } from "./lib/qmd.js";
import { callModelText, extractJson, resolveTranslationModel } from "./lib/translate.js";
import { peekProject, renderPeek } from "./lib/scaffold.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROMPT_INGEST = readFileSync(join(__dirname, "prompts", "ingest.md"), "utf8");
const PROMPT_SCAFFOLD = readFileSync(join(__dirname, "prompts", "scaffold.md"), "utf8");
const PROMPT_SEED = readFileSync(join(__dirname, "prompts", "seed.md"), "utf8");

const STATUS_KEY = "wiki-keeper";

interface SessionState {
	settings: WikiKeeperSettings;
	cycleInProgress: boolean;
	lastCycleAt: number;
	armed: boolean; // hysteresis: only fire once per crossing of the threshold
	pendingRotateMarker: boolean; // set when an auto-trigger compaction is in flight
}

export default function (pi: ExtensionAPI) {
	const state: SessionState = {
		settings: loadSettings(process.cwd()),
		cycleInProgress: false,
		lastCycleAt: 0,
		armed: true,
		pendingRotateMarker: false,
	};

	// ─── helpers ──────────────────────────────────────────────────────

	const setStatus = (ctx: ExtensionContext, text: string | undefined) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, text);
	};
	const notify = (ctx: ExtensionContext, msg: string, kind: "info" | "warning" | "error" = "info") => {
		if (ctx.hasUI) ctx.ui.notify(msg, kind);
	};

	const refreshSettings = () => {
		state.settings = loadSettings(process.cwd());
	};

	const computeFillRatio = (ctx: ExtensionContext): number | null => {
		const usage = ctx.getContextUsage();
		if (!usage) return null;
		const window = (usage as any).contextWindow ?? ctx.model?.contextWindow;
		const tokens = (usage as any).tokens;
		if (!window || !tokens || window <= 0) return null;
		return tokens / window;
	};

	const ensureSetup = async (ctx: ExtensionContext) => {
		const paths = resolveWikiPaths(process.cwd(), state.settings);
		ensureWikiTree(paths);
		// qmd availability is best-effort — warn once
		if (!(await qmdAvailable())) {
			notify(ctx, "qmd not found on PATH. Run: npm install -g @tobilu/qmd (or pi-plug install.sh)", "warning");
		} else {
			await qmdEnsureCollection(state.settings.qmdCollection, paths.root);
		}
		return paths;
	};

	const isWikiBootstrapped = (paths: ReturnType<typeof resolveWikiPaths>) => {
		return readFileIfExists(paths.indexMd) !== null && readFileIfExists(paths.schemaMd) !== null;
	};

	// ─── scaffold ─────────────────────────────────────────────────────

	const scaffoldWiki = async (ctx: ExtensionContext) => {
		const paths = await ensureSetup(ctx);
		if (isWikiBootstrapped(paths)) return { paths, scaffolded: false };

		setStatus(ctx, "scaffolding wiki…");
		const peek = peekProject(process.cwd());
		const peekText = renderPeek(peek);

		const resolved = resolveTranslationModel(ctx, state.settings);
		if (!resolved.model) {
			// Minimal fallback scaffold without LLM.
			const fallbackOps: WikiOp[] = [
				{
					op: "overwrite",
					path: "schema.md",
					content: defaultSchema(),
				},
				{ op: "overwrite", path: "index.md", content: defaultIndex() },
				{ op: "overwrite", path: "log.md", content: defaultLog() },
			];
			applyOps(paths, fallbackOps);
			notify(ctx, `Scaffolded wiki (no model — used defaults). ${resolved.error}`, "warning");
			setStatus(ctx, undefined);
			return { paths, scaffolded: true };
		}

		const result = await callModelText(
			ctx,
			resolved.model,
			PROMPT_SCAFFOLD,
			peekText,
			ctx.signal,
			6000,
		);
		if (!result.ok) {
			notify(ctx, `Wiki scaffold model call failed: ${result.error}. Using defaults.`, "warning");
			applyOps(paths, [
				{ op: "overwrite", path: "schema.md", content: defaultSchema() },
				{ op: "overwrite", path: "index.md", content: defaultIndex() },
				{ op: "overwrite", path: "log.md", content: defaultLog() },
			]);
			setStatus(ctx, undefined);
			return { paths, scaffolded: true };
		}
		const parsed = extractJson(result.text) as { ops?: WikiOp[] } | undefined;
		const ops = (parsed?.ops ?? []) as WikiOp[];
		if (ops.length === 0) {
			applyOps(paths, [
				{ op: "overwrite", path: "schema.md", content: defaultSchema() },
				{ op: "overwrite", path: "index.md", content: defaultIndex() },
				{ op: "overwrite", path: "log.md", content: defaultLog() },
			]);
		} else {
			applyOps(paths, ops);
		}
		applyOps(paths, [
			{ op: "log", entry: `## [${nowStamp()}] scaffold | initial wiki bootstrap` },
		]);

		// reindex
		try {
			await qmdEmbed(state.settings.qmdCollection, process.cwd());
		} catch {}
		notify(ctx, `Wiki scaffolded at ${relative(process.cwd(), paths.root) || paths.root}.`, "info");
		setStatus(ctx, undefined);
		return { paths, scaffolded: true };
	};

	// ─── the cycle ────────────────────────────────────────────────────

	type CycleArgs = {
		ctx: ExtensionContext;
		// when called from session_before_compact we receive the prepared messages
		preparedTranscript?: string;
		reason: "auto" | "manual-flush" | "manual-rotate";
	};
	type CycleResult = {
		ok: boolean;
		summary: string;
		opsApplied: number;
		lintReport?: string;
		error?: string;
	};

	const runWikiCycle = async (args: CycleArgs): Promise<CycleResult> => {
		const { ctx, reason } = args;
		if (state.cycleInProgress) return { ok: false, summary: "", opsApplied: 0, error: "cycle already running" };
		state.cycleInProgress = true;
		setStatus(ctx, "wiki: snapshot");
		try {
			const { paths } = await scaffoldWiki(ctx);

			// Phase A — snapshot
			let transcript = args.preparedTranscript;
			if (!transcript) {
				const branch = ctx.sessionManager.getBranch();
				const messages = branch
					.filter((e): e is SessionEntry & { type: "message" } => e.type === "message")
					.map((e) => e.message);
				transcript = serializeConversation(convertToLlm(messages));
			}
			if (!transcript || transcript.trim().length < 200) {
				return { ok: true, summary: "transcript too short — skipped", opsApplied: 0 };
			}

			// Phase B — translate
			setStatus(ctx, "wiki: translating");
			const resolved = resolveTranslationModel(ctx, state.settings);
			if (!resolved.model) {
				return { ok: false, summary: "", opsApplied: 0, error: resolved.error };
			}

			const schema = readFileIfExists(paths.schemaMd) ?? "";
			const index = readFileIfExists(paths.indexMd) ?? "";

			// Pre-fetch related pages via qmd to ground the translation.
			let relatedPages = "";
			try {
				const probe = transcript.slice(-2000);
				const hits = await qmdQuery(probe, state.settings.qmdCollection, 6);
				if (hits.length) {
					const blocks: string[] = [];
					for (const h of hits) {
						const p = (h.path as string) || "";
						if (!p) continue;
						const abs = p.startsWith("/") ? p : join(paths.root, p);
						const content = readFileIfExists(abs);
						if (content) blocks.push(`### ${relative(paths.root, abs)}\n\n${content.slice(0, 4000)}`);
					}
					relatedPages = blocks.join("\n\n---\n\n");
				}
			} catch {}

			const userText = [
				`# wiki/schema.md\n\n${schema}`,
				`# wiki/index.md\n\n${index}`,
				relatedPages ? `# Pre-fetched related wiki pages (qmd top hits)\n\n${relatedPages}` : "",
				`# Session transcript\n\n${transcript}`,
			]
				.filter(Boolean)
				.join("\n\n---\n\n");

			const llm = await callModelText(ctx, resolved.model, PROMPT_INGEST, userText, ctx.signal, 8192);
			if (!llm.ok) return { ok: false, summary: "", opsApplied: 0, error: `translate failed: ${llm.error}` };

			const parsed = extractJson(llm.text) as { summary?: string; ops?: WikiOp[] } | undefined;
			if (!parsed) return { ok: false, summary: "", opsApplied: 0, error: "translation produced unparseable JSON" };
			const ops: WikiOp[] = Array.isArray(parsed.ops) ? parsed.ops : [];

			// Always make sure there's at least one log entry.
			const hasLog = ops.some((o) => o.op === "log");
			if (!hasLog) {
				ops.push({
					op: "log",
					entry: `## [${nowStamp()}] ${reason} | ${(parsed.summary ?? "wiki update").replace(/\n/g, " ").slice(0, 200)}`,
				});
			}

			// Phase C — apply
			setStatus(ctx, `wiki: applying ${ops.length} ops`);
			const report = applyOps(paths, ops);

			// Phase D — lint + reindex
			let lintText = "";
			if (state.settings.lint) {
				setStatus(ctx, "wiki: linting");
				const lint = lintWiki(paths);
				lintText = formatLintReport(lint, paths.root);
				applyOps(paths, [{ op: "overwrite", path: "lint-report.md", content: lintText }]);
				if (lint.deadLinks.length) {
					notify(ctx, `Wiki lint: ${lint.deadLinks.length} dead link(s). See wiki/lint-report.md.`, "warning");
				}
			}

			setStatus(ctx, "wiki: reindexing");
			try {
				await qmdEmbed(state.settings.qmdCollection, process.cwd());
			} catch (err) {
				notify(ctx, `qmd embed failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
			}

			state.lastCycleAt = Date.now();
			notify(
				ctx,
				`Wiki updated: ${report.created.length} created, ${report.updated.length} updated, ${report.skipped.length} skipped.`,
				"info",
			);
			return {
				ok: true,
				summary: parsed.summary ?? "wiki updated",
				opsApplied: ops.length,
				lintReport: lintText,
			};
		} finally {
			state.cycleInProgress = false;
			setStatus(ctx, undefined);
		}
	};

	// ─── seed prompt for new session ──────────────────────────────────

	const buildSeed = (ctx: ExtensionContext, nextTask: string): string => {
		const paths = resolveWikiPaths(process.cwd(), state.settings);
		const log = readFileIfExists(paths.logMd) ?? "";
		const tail = log.split("\n").filter((l) => l.startsWith("## [")).slice(-3).join("\n") || "(no prior wiki entries)";
		return PROMPT_SEED
			.replace(/\{\{WIKI_DIR\}\}/g, state.settings.wikiDir)
			.replace(/\{\{QMD_COLLECTION\}\}/g, state.settings.qmdCollection)
			.replace(/\{\{LAST_LOG_TAIL\}\}/g, tail)
			.replace(/\{\{NEXT_TASK\}\}/g, nextTask || "(continue from where we left off — query the wiki to orient yourself)");
	};

	// ─── auto-trigger on context fill ─────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		refreshSettings();
		await ensureSetup(ctx);
		const paths = resolveWikiPaths(process.cwd(), state.settings);
		if (state.settings.autoScaffold && !isWikiBootstrapped(paths)) {
			// Don't block startup — kick scaffold off async.
			scaffoldWiki(ctx).catch((err) =>
				notify(ctx, `wiki scaffold failed: ${err instanceof Error ? err.message : String(err)}`, "error"),
			);
		}
	});

	pi.on("turn_end", (_event, ctx) => {
		if (state.cycleInProgress) return;
		const ratio = computeFillRatio(ctx);
		if (ratio === null) return;
		// Hysteresis: re-arm when we drop back under threshold.
		if (ratio < state.settings.triggerFillRatio * 0.8) state.armed = true;
		if (!state.armed) return;
		if (ratio < state.settings.triggerFillRatio) return;
		if (Date.now() - state.lastCycleAt < state.settings.cooldownMs) return;
		state.armed = false;
		notify(
			ctx,
			`Context at ${(ratio * 100).toFixed(0)}% — triggering wiki rotation (threshold ${(state.settings.triggerFillRatio * 100).toFixed(0)}%).`,
			"info",
		);
		state.pendingRotateMarker = true;
		// Use ctx.compact to swap context after the wiki update completes via session_before_compact.
		ctx.compact({
			customInstructions: "WIKI_KEEPER_ROTATE",
			onComplete: () => {
				state.pendingRotateMarker = false;
			},
			onError: (err) => {
				state.pendingRotateMarker = false;
				notify(ctx, `wiki rotation compaction failed: ${err.message}`, "error");
			},
		});
	});

	// Replace pi's default compaction with our wiki cycle when WE triggered it.
	pi.on("session_before_compact", async (event, ctx) => {
		if (!state.pendingRotateMarker && event.customInstructions !== "WIKI_KEEPER_ROTATE") {
			return; // let pi do its normal compaction
		}
		const { preparation } = event;
		const all = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
		const transcript = serializeConversation(convertToLlm(all));
		const result = await runWikiCycle({ ctx, preparedTranscript: transcript, reason: "auto" });
		const seed = buildSeed(ctx, "");
		const summary = [
			`# Wiki rotation summary`,
			"",
			result.ok ? result.summary : `(wiki update failed: ${result.error})`,
			"",
			"---",
			"",
			seed,
		].join("\n");
		return {
			compaction: {
				summary,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: { source: "wiki-keeper", opsApplied: result.opsApplied },
			},
		};
	});

	// ─── tools ────────────────────────────────────────────────────────

	pi.registerTool({
		name: "wiki_query",
		label: "Wiki Query",
		description:
			"Query the project wiki (authoritative knowledge base). ALWAYS call this BEFORE reading project files. Returns hybrid BM25+vector hits with paths and snippets. Use the returned paths with `read` to get full content.",
		promptSnippet:
			"wiki_query — query the project wiki first; only fall back to direct file reads when the wiki has no relevant hits",
		parameters: Type.Object({
			query: Type.String({ description: "Natural-language or keyword query." }),
			topK: Type.Optional(Type.Number({ description: "Max results (default 5)." })),
		}),
		async execute(_id, params) {
			const top = typeof params.topK === "number" ? params.topK : 5;
			const hits = await qmdQuery(params.query, state.settings.qmdCollection, top);
			if (!hits.length) {
				return {
					content: [
						{
							type: "text",
							text: `No wiki hits for "${params.query}". The wiki may not yet cover this; fall back to direct project reads, and your findings will be folded into the wiki at the next rotation.`,
						},
					],
					details: { hits: 0 },
				};
			}
			const lines = [`# wiki_query: ${hits.length} hit(s) for "${params.query}"`, ""];
			for (const h of hits) {
				lines.push(`- **${h.path ?? h.docid ?? "(unknown)"}**${typeof h.score === "number" ? ` _(score ${h.score.toFixed(3)})_` : ""}`);
				if (h.snippet) lines.push(`  > ${String(h.snippet).replace(/\n/g, " ").slice(0, 300)}`);
			}
			lines.push("", `Use \`read\` on these paths for full content.`);
			return { content: [{ type: "text", text: lines.join("\n") }], details: { hits: hits.length } };
		},
	});

	// ─── commands ─────────────────────────────────────────────────────

	pi.registerCommand("wiki:flush", {
		description: "Update the wiki from the current session (no session reset).",
		handler: async (_args, ctx) => {
			refreshSettings();
			const result = await runWikiCycle({ ctx, reason: "manual-flush" });
			if (result.ok) notify(ctx, `wiki flushed: ${result.summary}`, "info");
			else notify(ctx, `wiki flush failed: ${result.error}`, "error");
		},
	});

	pi.registerCommand("wiki:rotate", {
		description: "Update the wiki and start a fresh session seeded from the wiki.",
		handler: async (args, ctx) => {
			refreshSettings();
			const cmdCtx = ctx as ExtensionCommandContext;
			const result = await runWikiCycle({ ctx, reason: "manual-rotate" });
			if (!result.ok) {
				notify(ctx, `wiki rotate aborted: ${result.error}`, "error");
				return;
			}
			const seed = buildSeed(ctx, args.trim());
			const parentSession = ctx.sessionManager.getSessionFile();
			await cmdCtx.newSession({
				parentSession,
				withSession: async (rep) => {
					rep.ui.setEditorText(seed);
					rep.ui.notify("Wiki rotated. Submit when ready.", "info");
				},
			});
		},
	});

	pi.registerCommand("wiki:lint", {
		description: "Run lint on the wiki (dead links, orphans, contradictions). Writes wiki/lint-report.md.",
		handler: async (_args, ctx) => {
			const paths = await ensureSetup(ctx);
			const lint = lintWiki(paths);
			const text = formatLintReport(lint, paths.root);
			applyOps(paths, [{ op: "overwrite", path: "lint-report.md", content: text }]);
			notify(
				ctx,
				`lint: ${lint.deadLinks.length} dead, ${lint.orphans.length} orphans, ${lint.contradictions.length} contradictions.`,
				lint.deadLinks.length ? "warning" : "info",
			);
		},
	});

	pi.registerCommand("wiki:status", {
		description: "Show wiki + qmd status.",
		handler: async (_args, ctx) => {
			const paths = resolveWikiPaths(process.cwd(), state.settings);
			const ratio = computeFillRatio(ctx);
			const qmdHas = await qmdAvailable();
			const qmdSt = qmdHas ? await qmdStatus(state.settings.qmdCollection) : null;
			const lines = [
				`wiki dir:        ${relative(process.cwd(), paths.root) || paths.root}`,
				`bootstrapped:    ${isWikiBootstrapped(paths) ? "yes" : "no"}`,
				`context fill:    ${ratio === null ? "unknown" : (ratio * 100).toFixed(1) + "%"} (trigger ${(state.settings.triggerFillRatio * 100).toFixed(0)}%)`,
				`armed:           ${state.armed ? "yes" : "no (will re-arm under " + Math.round(state.settings.triggerFillRatio * 80) + "%)"}`,
				`qmd installed:   ${qmdHas ? "yes" : "no — install with: npm i -g @tobilu/qmd"}`,
				`qmd collection:  ${state.settings.qmdCollection}`,
				`translation:     ${state.settings.translationModelId && state.settings.translationModelProvider ? `${state.settings.translationModelProvider}/${state.settings.translationModelId}` : ctx.model ? `${ctx.model.provider}/${ctx.model.id} (current)` : "(no model)"}`,
				`lint enabled:    ${state.settings.lint}`,
				`auto-scaffold:   ${state.settings.autoScaffold}`,
			];
			if (qmdSt && qmdSt.stdout) lines.push("", "qmd status:", qmdSt.stdout.trim());
			notify(ctx, lines.join("\n"), "info");
		},
	});

	pi.registerCommand("wiki:model", {
		description: "Set translation model: /wiki:model <provider> <id>  (no args = clear override).",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (parts.length === 0) {
				state.settings.translationModelId = "";
				state.settings.translationModelProvider = "";
				notify(ctx, `wiki: translation model override cleared (will use current ctx.model).`, "info");
				return;
			}
			if (parts.length !== 2) {
				notify(ctx, `usage: /wiki:model <provider> <id>   (e.g. /wiki:model anthropic claude-haiku-4-5)`, "warning");
				return;
			}
			const [provider, id] = parts;
			const m = ctx.modelRegistry.find(provider, id);
			if (!m) {
				notify(ctx, `wiki: model "${provider}/${id}" not found in registry.`, "error");
				return;
			}
			state.settings.translationModelProvider = provider;
			state.settings.translationModelId = id;
			notify(ctx, `wiki: translation model set to ${provider}/${id} (session-only; persist via .pi/settings.json wikiKeeper.translationModel*).`, "info");
		},
	});

	pi.registerCommand("wiki:query", {
		description: "Query the wiki manually (mirrors wiki_query tool).",
		handler: async (args, ctx) => {
			const q = args.trim();
			if (!q) {
				notify(ctx, `usage: /wiki:query <query>`, "warning");
				return;
			}
			const hits = await qmdQuery(q, state.settings.qmdCollection, 8);
			if (!hits.length) {
				notify(ctx, `no hits for "${q}".`, "info");
				return;
			}
			const lines = hits.map(
				(h) => `- ${h.path ?? h.docid}${typeof h.score === "number" ? ` (${h.score.toFixed(3)})` : ""}`,
			);
			notify(ctx, lines.join("\n"), "info");
		},
	});
}

// ─── small helpers ────────────────────────────────────────────────────

function nowStamp(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function defaultSchema(): string {
	return `# Wiki Schema

This wiki is maintained by the **pi-plug wiki-keeper** extension. Pages are written by an LLM and consumed by both humans and LLMs.

## Layout

\`\`\`
wiki/
├── index.md          # catalog of all pages (kept current on every ingest)
├── log.md            # chronological log of ingests / lints / rotations
├── schema.md         # this file
├── lint-report.md    # output of the most recent lint (auto-generated)
├── entities/         # one page per concrete thing (file, module, function, person, system…)
├── concepts/         # one page per idea, pattern, decision, hypothesis
├── sources/          # one page per ingested document (PDF, article, conversation slice)
└── raw/              # immutable source files; the LLM reads but never modifies
\`\`\`

## Page format

Each page starts with optional YAML frontmatter:

\`\`\`yaml
---
tags: [tag1, tag2]
sources: ["sources/2026-04-30-session.md"]
last-updated: 2026-04-30
---
\`\`\`

Then markdown. Use \`[[PageName]]\` for cross-references, and standard \`[text](relative.md)\` for links to sources.

## Contradictions

When new information conflicts with existing claims, flag it inline:

> [!contradiction]
> Old: <verbatim or paraphrased prior claim>
> New: <new claim>
> Source: <session id or source page>

When a claim is fully superseded, ~~strike through~~ the old text and append \`see [[NewPage]]\`.

## Log entry format

\`## [YYYY-MM-DD HH:MM] <kind> | <session-or-task-id> | <one-line summary>\`

Kinds: \`ingest\`, \`scaffold\`, \`lint\`, \`manual-flush\`, \`manual-rotate\`, \`auto\`.
`;
}

function defaultIndex(): string {
	return `# Wiki Index

## Entities

- _none yet_

## Concepts

- _none yet_

## Sources

- _none yet_
`;
}

function defaultLog(): string {
	return `# Wiki Log

## [${nowStamp()}] scaffold | initial wiki bootstrap (defaults)
`;
}
