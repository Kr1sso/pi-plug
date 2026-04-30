import { basename, dirname, join, relative, resolve as resolvePath } from "node:path";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

import { loadSettings, resolveCollectionName, resolveWikiPaths, type WikiKeeperSettings } from "./lib/settings.js";
import {
	applyOps,
	archiveLog,
	countLogEntries,
	ensureWikiTree,
	formatLintReport,
	lintWiki,
	listMarkdownFiles,
	readFileIfExists,
	type WikiOp,
} from "./lib/wiki-fs.js";
import { qmdAvailable, qmdCollectionIsEmpty, qmdEmbed, qmdEnsureCollection, qmdQuery, qmdStatus } from "./lib/qmd.js";
import { callModelText, callModelTextJson, extractJson, resolveTranslationModel } from "./lib/translate.js";

// Shared JSON-shape reminder used when retrying a flush after the first response is unparseable.
const OPS_JSON_SHAPE_REMINDER = `{
  "summary": "one-paragraph description",
  "ops": [
    { "op": "create"|"overwrite"|"append", "path": "...", "content": "..." },
    { "op": "replace_section", "path": "...", "heading": "## Heading", "content": "..." },
    { "op": "log", "entry": "## [YYYY-MM-DD HH:MM] kind | <session-id> | one-line summary" }
  ]
}

If there is nothing to record, output exactly: {"summary":"no changes","ops":[]}`;
import { peekProject, renderPeek } from "./lib/scaffold.js";
import { acquireWikiLock, listSnapshots, restoreLatestSnapshot, snapshotWiki } from "./lib/lock.js";
import { detectDrift, isGitRepo, listSourceTrackingPages, suggestSyncTargets, summarizeDrift, writeLastSync } from "./lib/sync.js";
import { gitBlobShaOfFile, parseDoc, serializeDoc, fileMtime } from "./lib/frontmatter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROMPT_INGEST = readFileSync(join(__dirname, "prompts", "ingest.md"), "utf8");
const PROMPT_SCAFFOLD = readFileSync(join(__dirname, "prompts", "scaffold.md"), "utf8");
const PROMPT_SEED = readFileSync(join(__dirname, "prompts", "seed.md"), "utf8");
const PROMPT_KEYPHRASES = readFileSync(join(__dirname, "prompts", "keyphrases.md"), "utf8");
const PROMPT_SYNC = readFileSync(join(__dirname, "prompts", "sync.md"), "utf8");
const PROMPT_FIX = readFileSync(join(__dirname, "prompts", "fix.md"), "utf8");

const WIKI_GITIGNORE = `# pi-plug wiki transient state
.lock
.snapshots/
lint-report.md
`;

const WIKI_GITATTRIBUTES = `# pi-plug wiki merge driver hints
log.md merge=union
log-archive-*.md merge=union
`;

const SCAFFOLD_QUALITY_FILE = ".scaffold-quality";
interface ScaffoldQuality {
	quality: "default" | "llm";
	at: number;
	model?: string;
}

/** Cap the synthesized post-rotation summary so it doesn't bleed tokens into the next session. */
const MAX_ROTATION_SUMMARY_CHARS = 600;
/** Hard cap on lock wait — single session shouldn't block another for more than this. */
const LOCK_TIMEOUT_MS = 45_000;

const STATUS_KEY = "wiki-keeper";
const WIDGET_KEY = "wiki-keeper";

interface CycleIndicator {
	startedAt: number;
	phase: string;
	kind: string; // "rotation" | "sync" | "undo" | "scaffold" | "flush" | "lint"
	timer?: NodeJS.Timeout;
}

interface SessionState {
	settings: WikiKeeperSettings;
	cycleInProgress: boolean;
	lastCycleAt: number;
	armed: boolean; // hysteresis: only fire once per crossing of the threshold
	disciplineNudgeApplied: boolean; // ensure we only inject systemPrompt addendum once per session
}

export default function (pi: ExtensionAPI) {
	const state: SessionState = {
		settings: loadSettings(process.cwd()),
		cycleInProgress: false,
		lastCycleAt: 0,
		armed: true,
		disciplineNudgeApplied: false,
	};

	const sessionIdOf = (ctx: ExtensionContext) => {
		try {
			return basename(ctx.sessionManager.getSessionFile() || "").replace(/\.json$/, "") || `pid-${process.pid}`;
		} catch {
			return `pid-${process.pid}`;
		}
	};

	const getCollection = () => resolveCollectionName(state.settings, process.cwd());

	const readScaffoldQuality = (paths: ReturnType<typeof resolveWikiPaths>): ScaffoldQuality | undefined => {
		const raw = readFileIfExists(join(paths.root, SCAFFOLD_QUALITY_FILE));
		if (!raw) return undefined;
		try {
			return JSON.parse(raw) as ScaffoldQuality;
		} catch {
			return undefined;
		}
	};

	const writeScaffoldQuality = (paths: ReturnType<typeof resolveWikiPaths>, quality: ScaffoldQuality) => {
		try {
			writeFileSync(join(paths.root, SCAFFOLD_QUALITY_FILE), JSON.stringify(quality, null, 2) + "\n");
		} catch {}
	};

	// ─── helpers ──────────────────────────────────────────────────────

	const setStatus = (ctx: ExtensionContext, text: string | undefined) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, text);
	};
	const notify = (ctx: ExtensionContext, msg: string, kind: "info" | "warning" | "error" = "info") => {
		if (ctx.hasUI) ctx.ui.notify(msg, kind);
	};

	// ─── visible cycle indicator (widget + footer + ticking timer) ──────────────────────

	let activeIndicator: CycleIndicator | null = null;

	const renderWidget = (ind: CycleIndicator): string[] => {
		const elapsedSec = Math.floor((Date.now() - ind.startedAt) / 1000);
		return [
			`● wiki ${ind.kind} in progress — do not /exit`,
			`  phase: ${ind.phase}`,
			`  elapsed: ${elapsedSec}s`,
		];
	};

	const startIndicator = (ctx: ExtensionContext, kind: string, initialPhase: string) => {
		stopIndicator(ctx); // safety: replace any prior
		if (!ctx.hasUI) {
			activeIndicator = { startedAt: Date.now(), phase: initialPhase, kind };
			return;
		}
		activeIndicator = { startedAt: Date.now(), phase: initialPhase, kind };
		ctx.ui.setWidget(WIDGET_KEY, renderWidget(activeIndicator), { placement: "aboveEditor" });
		ctx.ui.setStatus(STATUS_KEY, `wiki ${kind} ▶ ${initialPhase}`);
		activeIndicator.timer = setInterval(() => {
			if (!activeIndicator || !ctx.hasUI) return;
			ctx.ui.setWidget(WIDGET_KEY, renderWidget(activeIndicator), { placement: "aboveEditor" });
			const sec = Math.floor((Date.now() - activeIndicator.startedAt) / 1000);
			ctx.ui.setStatus(STATUS_KEY, `wiki ${activeIndicator.kind} ▶ ${activeIndicator.phase} (${sec}s)`);
		}, 1000);
	};

	const updatePhase = (ctx: ExtensionContext, phase: string) => {
		if (!activeIndicator) {
			setStatus(ctx, phase);
			return;
		}
		activeIndicator.phase = phase;
		if (ctx.hasUI) {
			ctx.ui.setWidget(WIDGET_KEY, renderWidget(activeIndicator), { placement: "aboveEditor" });
			const sec = Math.floor((Date.now() - activeIndicator.startedAt) / 1000);
			ctx.ui.setStatus(STATUS_KEY, `wiki ${activeIndicator.kind} ▶ ${phase} (${sec}s)`);
		}
	};

	const stopIndicator = (ctx: ExtensionContext) => {
		if (activeIndicator?.timer) clearInterval(activeIndicator.timer);
		activeIndicator = null;
		if (ctx.hasUI) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
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
		// Ensure wiki/.gitignore so users committing wiki/ don't accidentally commit transient state.
		const gi = join(paths.root, ".gitignore");
		if (!existsSync(gi)) {
			try { writeFileSync(gi, WIKI_GITIGNORE); } catch {}
		}
		// Ensure wiki/.gitattributes so log.md merges cleanly across branches.
		const ga = join(paths.root, ".gitattributes");
		if (!existsSync(ga)) {
			try { writeFileSync(ga, WIKI_GITATTRIBUTES); } catch {}
		}
		// qmd availability is best-effort — warn once per process via state.
		const collection = resolveCollectionName(state.settings, process.cwd());
		if (!(await qmdAvailable())) {
			notify(ctx, "qmd not found on PATH. Run: npm install -g @tobilu/qmd (or pi-plug install.sh)", "warning");
		} else {
			await qmdEnsureCollection(collection, paths.root);
		}
		return paths;
	};

	const isWikiBootstrapped = (paths: ReturnType<typeof resolveWikiPaths>) => {
		return readFileIfExists(paths.indexMd) !== null && readFileIfExists(paths.schemaMd) !== null;
	};

	// ─── scaffold ─────────────────────────────────────────────────────

	const scaffoldWiki = async (ctx: ExtensionContext, force = false) => {
		const paths = await ensureSetup(ctx);
		if (!force && isWikiBootstrapped(paths)) return { paths, scaffolded: false };

		const sessionId = sessionIdOf(ctx);
		const lock = await acquireWikiLock(join(paths.root, ".lock"), sessionId, { timeoutMs: LOCK_TIMEOUT_MS });
		if (!lock) {
			if (isWikiBootstrapped(paths)) return { paths, scaffolded: false };
			notify(ctx, "wiki: another session holds the lock during scaffold; try again shortly.", "warning");
			return { paths, scaffolded: false };
		}

		startIndicator(ctx, "scaffold", "peeking project");
		try {
			if (!force && isWikiBootstrapped(paths)) return { paths, scaffolded: false };

			const peek = peekProject(process.cwd());
			const peekText = renderPeek(peek);

			const writeDefaults = () => {
				applyOps(paths, [
					{ op: "overwrite", path: "schema.md", content: defaultSchema() },
					{ op: "overwrite", path: "index.md", content: defaultIndex() },
					{ op: "overwrite", path: "log.md", content: defaultLog() },
				]);
				writeScaffoldQuality(paths, { quality: "default", at: Date.now() });
			};

			const resolved = resolveTranslationModel(ctx, state.settings);
			if (!resolved.model) {
				writeDefaults();
				notify(ctx, `Scaffolded wiki (no model — used defaults). ${resolved.error}`, "warning");
				return { paths, scaffolded: true };
			}

			updatePhase(ctx, "calling scaffold model");
			const result = await callModelText(ctx, resolved.model, PROMPT_SCAFFOLD, peekText, ctx.signal, 6000);
			if (!result.ok) {
				writeDefaults();
				notify(ctx, `Wiki scaffold model call failed: ${result.error}. Using defaults.`, "warning");
				return { paths, scaffolded: true };
			}
			updatePhase(ctx, "applying scaffold ops");
			const parsed = extractJson(result.text) as { ops?: WikiOp[] } | undefined;
			const ops = (parsed?.ops ?? []) as WikiOp[];
			if (ops.length === 0) {
				writeDefaults();
			} else {
				applyOps(paths, ops);
				writeScaffoldQuality(paths, { quality: "llm", at: Date.now(), model: `${resolved.model.provider}/${resolved.model.id}` });
			}
			applyOps(paths, [
				{ op: "log", entry: `## [${nowStamp()}] scaffold | ${sessionId} | initial wiki bootstrap${ops.length === 0 ? " (defaults)" : ""}` },
			]);

			updatePhase(ctx, "qmd reindex");
			try {
				await qmdEmbed(getCollection(), process.cwd());
			} catch {}
			notify(ctx, `Wiki scaffolded at ${relative(process.cwd(), paths.root) || paths.root}.`, "info");
			return { paths, scaffolded: true };
		} finally {
			lock.release();
			stopIndicator(ctx);
		}
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
		const sessionId = sessionIdOf(ctx);
		const kindLabel = reason === "auto" ? "rotation" : reason === "manual-rotate" ? "rotation" : "flush";
		startIndicator(ctx, kindLabel, "acquiring lock");
		const { paths } = await scaffoldWiki(ctx);
		// scaffoldWiki may have stopped the indicator; re-arm.
		if (!activeIndicator) startIndicator(ctx, kindLabel, "acquiring lock");
		const lock = await acquireWikiLock(join(paths.root, ".lock"), sessionId, { timeoutMs: LOCK_TIMEOUT_MS });
		if (!lock) {
			state.cycleInProgress = false;
			stopIndicator(ctx);
			return {
				ok: false,
				summary: "",
				opsApplied: 0,
				error: `another session holds the wiki lock for >${Math.round(LOCK_TIMEOUT_MS / 1000)}s; skipping cycle (will retry on next trigger)`,
			};
		}
		updatePhase(ctx, "snapshot");
		try {
			snapshotWiki(paths.root, state.settings.keepSnapshots); // pre-cycle snapshot for /wiki:undo

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
			updatePhase(ctx, "extracting keyphrases");
			const resolved = resolveTranslationModel(ctx, state.settings);
			if (!resolved.model) {
				return { ok: false, summary: "", opsApplied: 0, error: resolved.error };
			}

			const schema = readFileIfExists(paths.schemaMd) ?? "";
			const index = readFileIfExists(paths.indexMd) ?? "";

			// Pre-fetch related pages via qmd, grounded by LLM-extracted keyphrases (better hits than raw tail).
			let relatedPages = "";
			try {
				const keyphrases = await extractKeyphrases(ctx, resolved.model, transcript, paths.root);
				const hitMap = new Map<string, { path: string; score: number; snippet?: string }>();
				for (const phrase of keyphrases) {
					const hits = await qmdQuery(phrase, getCollection(), 4);
					for (const h of hits) {
						const p = (h.path as string) || "";
						if (!p) continue;
						const score = typeof h.score === "number" ? h.score : 0;
						const prev = hitMap.get(p);
						if (!prev || prev.score < score) hitMap.set(p, { path: p, score, snippet: h.snippet as string | undefined });
					}
				}
				const top = [...hitMap.values()].sort((a, b) => b.score - a.score).slice(0, 6);
				const blocks: string[] = [];
				for (const h of top) {
					const abs = h.path.startsWith("/") ? h.path : join(paths.root, h.path);
					const content = readFileIfExists(abs);
					if (content) blocks.push(`### ${relative(paths.root, abs)}\n\n${content.slice(0, 4000)}`);
				}
				relatedPages = blocks.join("\n\n---\n\n");
			} catch {}

			updatePhase(ctx, "calling translation model");
			const userText = [
				`# wiki/schema.md\n\n${schema}`,
				`# wiki/index.md\n\n${index}`,
				relatedPages ? `# Pre-fetched related wiki pages (qmd top hits)\n\n${relatedPages}` : "",
				`# Session transcript\n\n${transcript}`,
			]
				.filter(Boolean)
				.join("\n\n---\n\n");

			const llm = await callModelTextJson(ctx, resolved.model, PROMPT_INGEST, userText, ctx.signal, 8192, { jsonShapeReminder: OPS_JSON_SHAPE_REMINDER });
			if (!llm.ok) {
				const suffix = llm.attempts > 1 ? ` (after ${llm.attempts} attempt(s))` : "";
				return { ok: false, summary: "", opsApplied: 0, error: `translate failed${suffix}: ${llm.error}` };
			}
			if (llm.attempts > 1) updatePhase(ctx, `recovered JSON on attempt ${llm.attempts}`);
			const parsed = llm.parsed as { summary?: string; ops?: WikiOp[] } | undefined;
			if (!parsed) return { ok: false, summary: "", opsApplied: 0, error: "translation produced unparseable JSON" };
			const ops: WikiOp[] = Array.isArray(parsed.ops) ? parsed.ops : [];

			// Always make sure there's at least one log entry, tagged with this session id
			// so concurrent multi-session activity is traceable.
			const hasLog = ops.some((o) => o.op === "log");
			if (!hasLog) {
				ops.push({
					op: "log",
					entry: `## [${nowStamp()}] ${reason} | ${sessionId} | ${(parsed.summary ?? "wiki update").replace(/\n/g, " ").slice(0, 200)}`,
				});
			} else {
				// Tag any log ops the model produced that are missing the session id.
				for (const op of ops) {
					if (op.op === "log" && !op.entry.includes(sessionId)) {
						op.entry = op.entry.replace(/^(##\s+\[[^\]]+\]\s+\S+\s+\|\s+)/, `$1${sessionId} | `);
					}
				}
			}

			// Phase C — apply
			updatePhase(ctx, `applying ${ops.length} ops`);
			const report = applyOps(paths, ops);

			// Phase D — lint + reindex
			let lintText = "";
			if (state.settings.lint) {
				updatePhase(ctx, "linting");
				const lint = lintWiki(paths);
				lintText = formatLintReport(lint, paths.root);
				applyOps(paths, [{ op: "overwrite", path: "lint-report.md", content: lintText }]);
				if (lint.deadLinks.length || lint.orphans.length) {
					notify(
						ctx,
						`Wiki lint: ${lint.deadLinks.length} dead link(s), ${lint.orphans.length} orphan(s). Run /wiki:fix to repair.`,
						"warning",
					);
				}
			}

			updatePhase(ctx, "qmd reindex");
			try {
				await qmdEmbed(getCollection(), process.cwd());
			} catch (err) {
				notify(ctx, `qmd embed failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
			}

			state.lastCycleAt = Date.now();
			// Re-stamp every page's frontmatter source-sha after applying ops.
			restampAllSourceTrackedPages(paths);
			writeLastSync(paths, process.cwd());
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
			lock.release();
			state.cycleInProgress = false;
			state.lastCycleAt = Date.now(); // C7: stamp on every cycle outcome (success OR failure) to gate cooldown
			stopIndicator(ctx);
		}
	};

	const extractKeyphrases = async (
		ctx: ExtensionContext,
		model: NonNullable<ExtensionContext["model"]>,
		transcript: string,
		wikiRoot: string,
	): Promise<string[]> => {
		// R5: skip the LLM call entirely when the wiki is too sparse for useful pre-fetch grounding.
		const pageCount = listMarkdownFiles(wikiRoot).length;
		if (pageCount < state.settings.prefetchMinPages) return [];
		const tail = transcript.slice(-6000);
		// Pass the prompt as the system prompt rather than concatenating into the user message;
		// avoids passing an empty system prompt (which some providers handle oddly).
		const result = await callModelText(ctx, model, PROMPT_KEYPHRASES.trim(), tail, ctx.signal, 400);
		if (!result.ok) return [];
		const parsed = extractJson(result.text);
		if (Array.isArray(parsed)) return (parsed as unknown[]).filter((s): s is string => typeof s === "string" && s.length > 0).slice(0, 5);
		return [];
	};

	// ─── sync (filesystem-driven ingest) ──────────────────────────────

	const runWikiSync = async (
		ctx: ExtensionContext,
		explicitTargets: string[] | undefined,
	): Promise<{ ok: boolean; summary: string; targets: number; opsApplied: number; error?: string }> => {
		if (state.cycleInProgress) return { ok: false, summary: "", targets: 0, opsApplied: 0, error: "cycle already running" };
		state.cycleInProgress = true;
		const sessionId = sessionIdOf(ctx);
		startIndicator(ctx, "sync", "acquiring lock");
		const { paths } = await scaffoldWiki(ctx);
		if (!activeIndicator) startIndicator(ctx, "sync", "acquiring lock");
		const lock = await acquireWikiLock(join(paths.root, ".lock"), sessionId, { timeoutMs: LOCK_TIMEOUT_MS });
		if (!lock) {
			state.cycleInProgress = false;
			stopIndicator(ctx);
			return { ok: false, summary: "", targets: 0, opsApplied: 0, error: `another session holds the wiki lock; try again shortly` };
		}
		try {
			updatePhase(ctx, "detecting drift");
			const drift = detectDrift(paths, process.cwd(), state.settings.wikiDir);
			let targets = explicitTargets && explicitTargets.length > 0
				? [...new Set(explicitTargets)].sort()
				: suggestSyncTargets(drift, process.cwd(), state.settings.wikiDir);
			if (drift.mode === "branch-switch" && (!explicitTargets || explicitTargets.length === 0)) {
				notify(
					ctx,
					`wiki sync: branch switched (${drift.sinceBranch} → ${drift.currentBranch}); refusing to auto-detect cross-branch targets. Pass explicit paths.`,
					"warning",
				);
				writeLastSync(paths, process.cwd(), 0);
				return { ok: true, summary: "branch switched; auto-target detection skipped", targets: 0, opsApplied: 0 };
			}
			// Cap to avoid runaway syncs on huge merges.
			const MAX_TARGETS = 30;
			let capped = false;
			if (targets.length > MAX_TARGETS) {
				targets = targets.slice(0, MAX_TARGETS);
				capped = true;
			}
			if (targets.length === 0) {
				writeLastSync(paths, process.cwd(), 0);
				return { ok: true, summary: "no drift detected — wiki is up to date", targets: 0, opsApplied: 0 };
			}

			updatePhase(ctx, `reading ${targets.length} file(s)`);
			const fileBlocks: string[] = [];
			for (const rel of targets) {
				const abs = resolvePath(process.cwd(), rel);
				if (!existsSync(abs)) {
					fileBlocks.push(`### ${rel}\n\n> [!removed] file no longer exists on disk`);
					continue;
				}
				try {
					const st = statSync(abs);
					if (st.size > 200_000) {
						fileBlocks.push(`### ${rel}\n\n_(file too large to inline — ${st.size} bytes)_`);
						continue;
					}
					const content = readFileSync(abs, "utf8");
					const trimmed = content.length > 8000 ? content.slice(0, 8000) + `\n\n…(truncated, ${content.length} bytes total)` : content;
					fileBlocks.push(`### ${rel}\n\n\`\`\`\n${trimmed}\n\`\`\``);
				} catch (err) {
					fileBlocks.push(`### ${rel}\n\n_(read error: ${String(err).slice(0, 200)})_`);
				}
			}

			updatePhase(ctx, "fetching related pages");
			const resolved = resolveTranslationModel(ctx, state.settings);
			if (!resolved.model) return { ok: false, summary: "", targets: targets.length, opsApplied: 0, error: resolved.error };

			// Pre-fetch related wiki pages keyed off the file paths themselves.
			const hitMap = new Map<string, string>();
			for (const rel of targets.slice(0, 10)) {
				const hits = await qmdQuery(rel, getCollection(), 3);
				for (const h of hits) {
					const p = (h.path as string) || "";
					if (!p || hitMap.has(p)) continue;
					const abs = p.startsWith("/") ? p : join(paths.root, p);
					const content = readFileIfExists(abs);
					if (content) hitMap.set(p, `### ${relative(paths.root, abs)}\n\n${content.slice(0, 4000)}`);
				}
			}
			const relatedPages = [...hitMap.values()].slice(0, 8).join("\n\n---\n\n");

			const schema = readFileIfExists(paths.schemaMd) ?? "";
			const userText = [
				`# wiki/schema.md\n\n${schema}`,
				relatedPages ? `# Pre-existing related wiki pages\n\n${relatedPages}` : "",
				`# Changed source files (current content)\n\n${fileBlocks.join("\n\n---\n\n")}`,
			].filter(Boolean).join("\n\n---\n\n");

			updatePhase(ctx, "calling translation model");
			const llm = await callModelTextJson(ctx, resolved.model, PROMPT_SYNC, userText, ctx.signal, 8192, { jsonShapeReminder: OPS_JSON_SHAPE_REMINDER });
			if (!llm.ok) {
				const suffix = llm.attempts > 1 ? ` (after ${llm.attempts} attempt(s))` : "";
				return { ok: false, summary: "", targets: targets.length, opsApplied: 0, error: `sync translate failed${suffix}: ${llm.error}` };
			}
			if (llm.attempts > 1) updatePhase(ctx, `recovered JSON on attempt ${llm.attempts}`);
			const parsed = llm.parsed as { summary?: string; ops?: WikiOp[] } | undefined;
			if (!parsed) return { ok: false, summary: "", targets: targets.length, opsApplied: 0, error: "sync produced unparseable JSON" };
			const ops: WikiOp[] = Array.isArray(parsed.ops) ? parsed.ops : [];

			// Inject session id + sync kind into log entries.
			const hasLog = ops.some((o) => o.op === "log");
			if (!hasLog) {
				ops.push({
					op: "log",
					entry: `## [${nowStamp()}] sync | ${sessionId} | ${(parsed.summary ?? `synced ${targets.length} file(s)`).replace(/\n/g, " ").slice(0, 200)}${capped ? " (capped)" : ""}`,
				});
			} else {
				for (const op of ops) {
					if (op.op === "log" && !op.entry.includes(sessionId)) {
						op.entry = op.entry.replace(/^(##\s+\[[^\]]+\]\s+\S+\s+\|\s+)/, `$1${sessionId} | `);
					}
				}
			}

			updatePhase(ctx, `applying ${ops.length} ops`);
			snapshotWiki(paths.root, state.settings.keepSnapshots);
			const report = applyOps(paths, ops);

			if (state.settings.lint) {
				updatePhase(ctx, "linting");
				const lint = lintWiki(paths);
				applyOps(paths, [{ op: "overwrite", path: "lint-report.md", content: formatLintReport(lint, paths.root) }]);
			}

			updatePhase(ctx, "restamping + reindexing");
			restampAllSourceTrackedPages(paths);
			writeLastSync(paths, process.cwd(), targets.length);
			try {
				await qmdEmbed(getCollection(), process.cwd());
			} catch {}

			return {
				ok: true,
				summary: `${parsed.summary ?? "sync complete"} (created ${report.created.length}, updated ${report.updated.length}${capped ? ", capped" : ""})`,
				targets: targets.length,
				opsApplied: ops.length,
			};
		} finally {
			lock.release();
			state.cycleInProgress = false;
			state.lastCycleAt = Date.now();
			stopIndicator(ctx);
		}
	};

	/** LLM-driven repair pass for lint issues. */
	const runWikiFix = async (
		ctx: ExtensionContext,
	): Promise<{
		ok: boolean;
		summary: string;
		opsApplied: number;
		remainingDead: number;
		remainingOrphans: number;
		error?: string;
	}> => {
		if (state.cycleInProgress) {
			return { ok: false, summary: "", opsApplied: 0, remainingDead: 0, remainingOrphans: 0, error: "cycle already running" };
		}
		state.cycleInProgress = true;
		const sessionId = sessionIdOf(ctx);
		startIndicator(ctx, "fix", "acquiring lock");
		const { paths } = await scaffoldWiki(ctx);
		if (!activeIndicator) startIndicator(ctx, "fix", "acquiring lock");
		const lock = await acquireWikiLock(join(paths.root, ".lock"), sessionId, { timeoutMs: LOCK_TIMEOUT_MS });
		if (!lock) {
			state.cycleInProgress = false;
			stopIndicator(ctx);
			return { ok: false, summary: "", opsApplied: 0, remainingDead: 0, remainingOrphans: 0, error: "another session holds the wiki lock; try again shortly" };
		}
		try {
			updatePhase(ctx, "linting");
			const lintBefore = lintWiki(paths);
			const issueCount = lintBefore.deadLinks.length + lintBefore.orphans.length;
			const sourceMissingPages = listSourceTrackingPages(paths, process.cwd())
				.filter((r) => {
					try {
						const fm = parseDoc(readFileSync(r.wikiFile, "utf8")).frontmatter;
						return fm["source-status"] === "missing";
					} catch {
						return false;
					}
				});
			if (issueCount === 0 && sourceMissingPages.length === 0) {
				return { ok: true, summary: "no issues to fix", opsApplied: 0, remainingDead: 0, remainingOrphans: 0 };
			}

			updatePhase(ctx, "gathering implicated pages");
			// Collect every page implicated in an issue, plus a list of all wiki paths.
			const allPages = listMarkdownFiles(paths.root);
			const implicated = new Set<string>();
			for (const d of lintBefore.deadLinks) implicated.add(d.file);
			for (const o of lintBefore.orphans) implicated.add(o);
			for (const c of lintBefore.contradictions) implicated.add(c.file);
			for (const m of sourceMissingPages) implicated.add(m.wikiFile);
			// Cap at ~25 pages of context to keep the prompt bounded.
			const implicatedList = [...implicated].slice(0, 25);
			const pageBlocks: string[] = [];
			for (const f of implicatedList) {
				const content = readFileIfExists(f);
				if (content) pageBlocks.push(`### ${relative(paths.root, f)}\n\n${content.slice(0, 4000)}`);
			}

			const lintReport = formatLintReport(lintBefore, paths.root);
			const pathList = allPages.map((p) => relative(paths.root, p)).sort().join("\n");
			const schema = readFileIfExists(paths.schemaMd) ?? "";
			const userText = [
				`# wiki/schema.md\n\n${schema}`,
				`# Lint report\n\n${lintReport}`,
				sourceMissingPages.length
					? `# Source-missing pages\n\n${sourceMissingPages.map((m) => `- ${relative(paths.root, m.wikiFile)} → ${relative(process.cwd(), m.sourceFile)}`).join("\n")}`
					: "",
				`# All wiki paths (for picking valid link targets)\n\n\`\`\`\n${pathList}\n\`\`\``,
				`# Implicated pages (full content)\n\n${pageBlocks.join("\n\n---\n\n")}`,
			]
				.filter(Boolean)
				.join("\n\n---\n\n");

			updatePhase(ctx, "calling repair model");
			const resolved = resolveTranslationModel(ctx, state.settings);
			if (!resolved.model) {
				return { ok: false, summary: "", opsApplied: 0, remainingDead: lintBefore.deadLinks.length, remainingOrphans: lintBefore.orphans.length, error: resolved.error };
			}
			const llm = await callModelTextJson(ctx, resolved.model, PROMPT_FIX, userText, ctx.signal, 8192, { jsonShapeReminder: OPS_JSON_SHAPE_REMINDER });
			if (!llm.ok) {
				const suffix = llm.attempts > 1 ? ` (after ${llm.attempts} attempt(s))` : "";
				return { ok: false, summary: "", opsApplied: 0, remainingDead: lintBefore.deadLinks.length, remainingOrphans: lintBefore.orphans.length, error: `repair translate failed${suffix}: ${llm.error}` };
			}
			if (llm.attempts > 1) updatePhase(ctx, `recovered JSON on attempt ${llm.attempts}`);
			const parsed = llm.parsed as { summary?: string; ops?: WikiOp[] } | undefined;
			if (!parsed) {
				return { ok: false, summary: "", opsApplied: 0, remainingDead: lintBefore.deadLinks.length, remainingOrphans: lintBefore.orphans.length, error: "repair produced unparseable JSON" };
			}
			const ops: WikiOp[] = Array.isArray(parsed.ops) ? parsed.ops : [];

			// Tag log entries with session id.
			const hasLog = ops.some((o) => o.op === "log");
			if (!hasLog) {
				ops.push({
					op: "log",
					entry: `## [${nowStamp()}] fix | ${sessionId} | ${(parsed.summary ?? `repaired lint issues`).replace(/\n/g, " ").slice(0, 200)}`,
				});
			} else {
				for (const op of ops) {
					if (op.op === "log" && !op.entry.includes(sessionId)) {
						op.entry = op.entry.replace(/^(##\s+\[[^\]]+\]\s+\S+\s+\|\s+)/, `$1${sessionId} | `);
					}
				}
			}

			updatePhase(ctx, `applying ${ops.length} ops`);
			snapshotWiki(paths.root, state.settings.keepSnapshots);
			applyOps(paths, ops);

			updatePhase(ctx, "re-linting");
			const lintAfter = lintWiki(paths);
			applyOps(paths, [{ op: "overwrite", path: "lint-report.md", content: formatLintReport(lintAfter, paths.root) }]);

			updatePhase(ctx, "restamping + reindexing");
			restampAllSourceTrackedPages(paths);
			writeLastSync(paths, process.cwd());
			try {
				await qmdEmbed(getCollection(), process.cwd());
			} catch {}

			return {
				ok: true,
				summary: parsed.summary ?? "repair complete",
				opsApplied: ops.length,
				remainingDead: lintAfter.deadLinks.length,
				remainingOrphans: lintAfter.orphans.length,
			};
		} finally {
			lock.release();
			state.cycleInProgress = false;
			state.lastCycleAt = Date.now();
			stopIndicator(ctx);
		}
	};

	/** Walk all source-tracked pages, restamp source-sha + source-mtime + last-synced. */
	const restampAllSourceTrackedPages = (paths: ReturnType<typeof resolveWikiPaths>) => {
		for (const wikiFile of listMarkdownFiles(paths.root)) {
			let text: string;
			try {
				text = readFileSync(wikiFile, "utf8");
			} catch {
				continue;
			}
			const parsed = parseDoc(text);
			const sourceFile = parsed.frontmatter["source-file"];
			if (typeof sourceFile !== "string" || !sourceFile) continue;
			const sourceAbs = resolvePath(process.cwd(), sourceFile);
			const sha = gitBlobShaOfFile(sourceAbs);
			if (!sha) {
				parsed.frontmatter["source-sha"] = null;
				parsed.frontmatter["source-status"] = "missing";
			} else {
				parsed.frontmatter["source-sha"] = sha;
				delete parsed.frontmatter["source-status"];
				const mtime = fileMtime(sourceAbs);
				if (mtime !== undefined) parsed.frontmatter["source-mtime"] = mtime;
			}
			parsed.frontmatter["last-synced"] = new Date().toISOString().slice(0, 10);
			try {
				writeFileSync(wikiFile, serializeDoc(parsed.frontmatter, parsed.body));
			} catch {}
		}
	};

	// ─── seed prompt for new session ──────────────────────────────────

	const buildSeed = (ctx: ExtensionContext, nextTask: string): string => {
		const paths = resolveWikiPaths(process.cwd(), state.settings);
		const log = readFileIfExists(paths.logMd) ?? "";
		const tail = log.split("\n").filter((l) => l.startsWith("## [")).slice(-3).join("\n") || "(no prior wiki entries)";
		return PROMPT_SEED
			.replace(/\{\{WIKI_DIR\}\}/g, state.settings.wikiDir)
			.replace(/\{\{QMD_COLLECTION\}\}/g, getCollection())
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
		} else if (isWikiBootstrapped(paths)) {
			// C3: if we previously scaffolded with defaults (no model was available) AND a model is
			// available now AND the wiki has had no real activity yet (only the scaffold log entry),
			// re-scaffold with the LLM in the background.
			try {
				const quality = readScaffoldQuality(paths);
				const logEntries = countLogEntries(paths.logMd);
				if (
					quality?.quality === "default" &&
					logEntries <= 1 &&
					resolveTranslationModel(ctx, state.settings).model
				) {
					notify(ctx, "wiki: re-scaffolding with LLM (previous bootstrap used defaults).", "info");
					scaffoldWiki(ctx, true).catch((err) =>
						notify(ctx, `wiki re-scaffold failed: ${err instanceof Error ? err.message : String(err)}`, "error"),
					);
				}
			} catch {}

			// C5: if qmd index is empty for this collection but the wiki has content, embed.
			if (state.settings.qmdAutoEmbedOnStart) {
				(async () => {
					try {
						if (!(await qmdAvailable())) return;
						const empty = await qmdCollectionIsEmpty(getCollection());
						if (empty && listMarkdownFiles(paths.root).length > 0) {
							notify(ctx, "wiki: qmd index empty for this collection — embedding now (one-time cost).", "info");
							await qmdEmbed(getCollection(), process.cwd());
						}
					} catch {}
				})();
			}

			// Drift notification (cheap; never auto-syncs).
			try {
				const drift = detectDrift(paths, process.cwd(), state.settings.wikiDir);
				if (drift.mode === "branch-switch") {
					notify(
						ctx,
						`Wiki: branch switched (${drift.sinceBranch} → ${drift.currentBranch}); wiki may not match current branch. Use /wiki:sync <paths> for targeted updates.`,
						"warning",
					);
				} else {
					const total = drift.changedFiles.length + drift.staleWikiPages.length;
					if (total >= 3) {
						const bits: string[] = [];
						if (drift.changedFiles.length) bits.push(`${drift.changedFiles.length} file(s) changed since last sync`);
						if (drift.staleWikiPages.length) bits.push(`${drift.staleWikiPages.length} wiki page(s) drifted`);
						notify(ctx, `Wiki may be stale: ${bits.join(", ")}. Run /wiki:sync (or /wiki:status for detail).`, "warning");
					}
				}
			} catch {}

			// Log archive suggestion.
			try {
				const entries = countLogEntries(paths.logMd);
				if (entries > state.settings.logArchiveSuggestEntries) {
					notify(
						ctx,
						`Wiki log has ${entries} entries (>${state.settings.logArchiveSuggestEntries}). Run /wiki:archive to roll older entries into log-archive-YYYY-MM.md.`,
						"info",
					);
				}
			} catch {}
		}
	});

	pi.on("turn_end", (_event, ctx) => {
		refreshSettings(); // hot-reload settings each turn check
		if (state.cycleInProgress) return;
		const ratio = computeFillRatio(ctx);
		if (ratio === null) return;
		// Hysteresis: re-arm when we drop back under threshold.
		if (ratio < state.settings.triggerFillRatio * 0.8) state.armed = true;
		if (!state.armed) return;
		if (ratio < state.settings.triggerFillRatio) return;
		if (Date.now() - state.lastCycleAt < state.settings.cooldownMs) return;
		state.armed = false;
		if (!state.settings.autoCompactOnTrigger) {
			notify(
				ctx,
				`Context at ${(ratio * 100).toFixed(0)}% — wiki rotation suggested. Run /wiki:rotate (autoCompactOnTrigger=false).`,
				"warning",
			);
			return;
		}
		notify(
			ctx,
			`Context at ${(ratio * 100).toFixed(0)}% — triggering wiki rotation (threshold ${(state.settings.triggerFillRatio * 100).toFixed(0)}%).`,
			"info",
		);
		// Use ctx.compact to swap context after the wiki update completes via session_before_compact.
		ctx.compact({
			customInstructions: "WIKI_KEEPER_ROTATE",
			onError: (err) => {
				state.armed = true; // re-arm so we can retry
				notify(ctx, `wiki rotation compaction failed: ${err.message}`, "error");
			},
		});
	});

	// Replace pi's default compaction with our wiki cycle ONLY when we explicitly triggered it.
	// Manual /compact (or any other extension's compaction) flows through unmodified.
	// On failure, return { cancel: true } so the user's context is NOT swapped — they keep their
	// conversation and the next turn_end can re-attempt (we re-arm armed=true here too).
	pi.on("session_before_compact", async (event, ctx) => {
		if (event.customInstructions !== "WIKI_KEEPER_ROTATE") return;
		const { preparation } = event;
		const all = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
		const transcript = serializeConversation(convertToLlm(all));
		const result = await runWikiCycle({ ctx, preparedTranscript: transcript, reason: "auto" });
		if (!result.ok) {
			state.armed = true;
			notify(ctx, `Wiki rotation skipped: ${result.error ?? "unknown error"}. Context preserved; will retry.`, "warning");
			return { cancel: true };
		}
		const seed = buildSeed(ctx, "");
		const rawSummary = result.summary;
		const capped =
			rawSummary.length > MAX_ROTATION_SUMMARY_CHARS
				? rawSummary.slice(0, MAX_ROTATION_SUMMARY_CHARS - 1).trimEnd() + "…"
				: rawSummary;
		const summary = [`# Wiki rotation`, "", capped, "", "---", "", seed].join("\n");
		return {
			compaction: {
				summary,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: { source: "wiki-keeper", opsApplied: result.opsApplied },
			},
		};
	});

	// One-shot system prompt addendum: enforce "wiki first" discipline when the wiki has content.
	pi.on("before_agent_start", async (event, ctx) => {
		if (state.disciplineNudgeApplied) return;
		const paths = resolveWikiPaths(process.cwd(), state.settings);
		const log = readFileIfExists(paths.logMd);
		if (!log) return;
		const hasIngest = /^## \[[^\]]+\] (ingest|manual-flush|manual-rotate|auto)/m.test(log);
		if (!hasIngest) return;
		state.disciplineNudgeApplied = true;
		const addendum = `\n\n## Wiki discipline (pi-plug)\n\nThis project has a knowledge wiki at \`./${state.settings.wikiDir}/\` (qmd collection: \`${getCollection()}\`).\nBefore reading any project source file, call the \`wiki_query\` tool. Only fall back to direct \`read\` when the wiki has no relevant hit.\nThe wiki is the authoritative, accumulated knowledge — your prior sessions have already condensed findings there.`;
		return { systemPrompt: event.systemPrompt + addendum };
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
			const hits = await qmdQuery(params.query, getCollection(), top);
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
			const hasIssues = lint.deadLinks.length + lint.orphans.length > 0;
			notify(
				ctx,
				`lint: ${lint.deadLinks.length} dead, ${lint.orphans.length} orphans, ${lint.contradictions.length} contradictions.${hasIssues ? " Run /wiki:fix to repair." : ""}`,
				hasIssues ? "warning" : "info",
			);
		},
	});

	pi.registerCommand("wiki:fix", {
		description: "LLM-driven repair of lint issues (dead links, orphans, source-missing). Lock-protected, snapshot-backed.",
		handler: async (_args, ctx) => {
			refreshSettings();
			if (state.cycleInProgress) {
				notify(ctx, "wiki: cycle already running; try again in a moment.", "warning");
				return;
			}
			const result = await runWikiFix(ctx);
			if (result.ok) {
				const remaining = result.remainingDead + result.remainingOrphans;
				const label = remaining > 0 ? "wiki partial fix" : "wiki fixed";
				notify(
					ctx,
					`${label}: ${result.summary} [${result.opsApplied} ops; remaining: ${result.remainingDead} dead, ${result.remainingOrphans} orphans]`,
					remaining > 0 ? "warning" : "info",
				);
			} else {
				notify(ctx, `wiki fix failed: ${result.error}`, "error");
			}
		},
	});

	pi.registerCommand("wiki:undo", {
		description: "Restore the wiki to its state before the last cycle (uses the most recent snapshot).",
		handler: async (_args, ctx) => {
			const paths = resolveWikiPaths(process.cwd(), state.settings);
			const snapshots = listSnapshots(paths.root);
			if (snapshots.length === 0) {
				notify(ctx, "wiki: no snapshots to restore from.", "warning");
				return;
			}
			startIndicator(ctx, "undo", "acquiring lock");
			const lock = await acquireWikiLock(join(paths.root, ".lock"), sessionIdOf(ctx), { timeoutMs: LOCK_TIMEOUT_MS });
			if (!lock) {
				stopIndicator(ctx);
				notify(ctx, "wiki: another session holds the lock; try again shortly.", "warning");
				return;
			}
			try {
				updatePhase(ctx, "restoring snapshot");
				const restored = restoreLatestSnapshot(paths.root);
				if (!restored) {
					notify(ctx, "wiki: snapshot restore failed.", "error");
					return;
				}
				updatePhase(ctx, "qmd reindex");
				try {
					await qmdEmbed(getCollection(), process.cwd());
				} catch {}
				notify(ctx, `wiki: restored snapshot ${restored.stamp}. ${snapshots.length - 1} snapshot(s) remain.`, "info");
			} finally {
				lock.release();
				stopIndicator(ctx);
			}
		},
	});

	pi.registerCommand("wiki:sync", {
		description: "Sync the wiki with on-disk changes (git diff since last sync, or explicit paths).",
		handler: async (args, ctx) => {
			refreshSettings();
			const targets = args.trim().length ? args.trim().split(/\s+/) : undefined;
			const result = await runWikiSync(ctx, targets);
			if (result.ok) notify(ctx, `wiki sync: ${result.summary} [${result.targets} target(s), ${result.opsApplied} ops]`, "info");
			else notify(ctx, `wiki sync failed: ${result.error}`, "error");
		},
	});

	pi.registerCommand("wiki:archive", {
		description: "Roll older log.md entries into log-archive-YYYY-MM.md files. Default keeps the most recent 100 entries; pass an integer to override (e.g. /wiki:archive 30).",
		handler: async (args, ctx) => {
			refreshSettings();
			const keep = (() => {
				const n = parseInt(args.trim(), 10);
				return Number.isFinite(n) && n > 0 ? n : 100;
			})();
			const paths = await ensureSetup(ctx);
			const lock = await acquireWikiLock(join(paths.root, ".lock"), sessionIdOf(ctx), { timeoutMs: LOCK_TIMEOUT_MS });
			if (!lock) {
				notify(ctx, "wiki: another session holds the lock; try again shortly.", "warning");
				return;
			}
			try {
				snapshotWiki(paths.root, state.settings.keepSnapshots);
				const result = archiveLog(paths.logMd, keep);
				if (result.archivedEntries === 0) {
					notify(ctx, `wiki archive: nothing to archive (log has ${result.keptEntries} entries, threshold ${keep}).`, "info");
					return;
				}
				// Append a meta log entry recording the archive operation.
				applyOps(paths, [
					{
						op: "log",
						entry: `## [${nowStamp()}] archive | ${sessionIdOf(ctx)} | rolled ${result.archivedEntries} entries into ${result.archiveFiles.length} archive file(s); kept ${result.keptEntries}`,
					},
				]);
				try {
					await qmdEmbed(getCollection(), process.cwd());
				} catch {}
				notify(
					ctx,
					`wiki archive: rolled ${result.archivedEntries} entries into ${result.archiveFiles.length} file(s) (${result.archiveFiles.map((f) => f.split("/").pop()).join(", ")}); kept ${result.keptEntries}.`,
					"info",
				);
			} finally {
				lock.release();
			}
		},
	});

	pi.registerCommand("wiki:status", {
		description: "Show wiki + qmd status.",
		handler: async (_args, ctx) => {
			const paths = resolveWikiPaths(process.cwd(), state.settings);
			const ratio = computeFillRatio(ctx);
			const qmdHas = await qmdAvailable();
			const qmdSt = qmdHas ? await qmdStatus(getCollection()) : null;
			const snapshots = listSnapshots(paths.root);
			const lockMeta = readFileIfExists(join(paths.root, ".lock"));
			const gitOn = isGitRepo(process.cwd());
			const quality = readScaffoldQuality(paths);
			const logEntries = countLogEntries(paths.logMd);
			let driftLine = "drift:           (skipped)";
			if (isWikiBootstrapped(paths)) {
				try {
					const d = detectDrift(paths, process.cwd(), state.settings.wikiDir);
					if (d.mode === "branch-switch") {
						driftLine = `drift:           branch switched (${d.sinceBranch} → ${d.currentBranch}); cross-branch diff suppressed`;
					} else {
						driftLine = `drift:           ${d.changedFiles.length} file(s) changed${d.staleWikiPages.length ? `, ${d.staleWikiPages.length} wiki page(s) drifted` : ""} (mode: ${d.mode})`;
					}
				} catch {}
			}
			const lines = [
				`wiki dir:        ${relative(process.cwd(), paths.root) || paths.root}`,
				`bootstrapped:    ${isWikiBootstrapped(paths) ? "yes" : "no"}${quality ? ` (scaffold: ${quality.quality}${quality.model ? ` via ${quality.model}` : ""})` : ""}`,
				`session id:      ${sessionIdOf(ctx)}`,
				`lock:            ${lockMeta ? lockMeta.replace(/\s+/g, " ").slice(0, 120) : "free"}`,
				`snapshots:       ${snapshots.length} (keep ${state.settings.keepSnapshots}; latest: ${snapshots[0]?.stamp ?? "none"})`,
				`log entries:     ${logEntries}${logEntries > state.settings.logArchiveSuggestEntries ? " — consider /wiki:archive" : ""}`,
				`git repo:        ${gitOn ? "yes" : "no (using mtime fallback)"}`,
				driftLine,
				`context fill:    ${ratio === null ? "unknown" : (ratio * 100).toFixed(1) + "%"} (trigger ${(state.settings.triggerFillRatio * 100).toFixed(0)}%)`,
				`armed:           ${state.armed ? "yes" : "no (will re-arm under " + Math.round(state.settings.triggerFillRatio * 80) + "%)"}`,
				`auto-rotate:     ${state.settings.autoCompactOnTrigger ? "on" : "off (manual /wiki:rotate only)"}`,
				`qmd installed:   ${qmdHas ? "yes" : "no — install with: npm i -g @tobilu/qmd"}`,
				`qmd collection:  ${getCollection()}`,
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
			const hits = await qmdQuery(q, getCollection(), 8);
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

For pages tracking a specific project source file, include:

\`\`\`yaml
---
source-file: src/path/to/file.ts   # project-relative; REQUIRED for drift tracking
source-sha: <git blob sha>          # auto-stamped by the keeper
source-mtime: <unix ms>             # auto-stamped by the keeper
last-synced: 2026-04-30             # auto-stamped by the keeper
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

## File-change callouts

When a sync detects on-disk changes, the keeper uses these callouts:

> [!updated]
> Behavior changed at <date>: <what>

> [!renamed]
> From: old/path.ts → new/path.ts

> [!removed]
> File removed at <date>. Last known content: see snapshot or git history.

## Log entry format

\`## [YYYY-MM-DD HH:MM] <kind> | <session-id> | <one-line summary>\`

Kinds: \`ingest\`, \`scaffold\`, \`lint\`, \`manual-flush\`, \`manual-rotate\`, \`auto\`, \`sync\`.
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
