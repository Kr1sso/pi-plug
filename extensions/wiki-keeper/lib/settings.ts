import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface WikiKeeperSettings {
	/** Trigger ratio in [0..1] of context fill that fires the wiki cycle. */
	triggerFillRatio: number;
	/** Project-relative wiki dir. */
	wikiDir: string;
	/** Subdir for raw, immutable sources. */
	rawSubdir: string;
	/** qmd collection name. */
	qmdCollection: string;
	/** Whether the auto-trigger replaces context after wiki update. If false, only notifies and the user must run /wiki:rotate manually. */
	autoCompactOnTrigger: boolean;
	/** Whether the cycle runs lint (dead links, orphans, contradictions). */
	lint: boolean;
	/** Whether to auto-scaffold wiki/ on first run. */
	autoScaffold: boolean;
	/** Override translation model id (e.g. "claude-haiku-4-5"). Empty = use ctx.model. */
	translationModelId: string;
	/** Override translation model provider. Empty = use ctx.model.provider. */
	translationModelProvider: string;
	/** Cooldown after a cycle before another auto-trigger (ms). */
	cooldownMs: number;
	/** How many pre-cycle snapshots to keep in wiki/.snapshots/. */
	keepSnapshots: number;
	/** Auto-embed qmd on session_start if wiki is bootstrapped but local index is empty. */
	qmdAutoEmbedOnStart: boolean;
	/** Skip the keyphrase pre-fetch if wiki has fewer than this many pages (no point grounding against an empty wiki). */
	prefetchMinPages: number;
	/** When log.md exceeds this many entries (lines starting `## [`), suggest /wiki:archive on session_start. */
	logArchiveSuggestEntries: number;
}

export const DEFAULT_SETTINGS: WikiKeeperSettings = {
	triggerFillRatio: 0.5,
	wikiDir: "wiki",
	rawSubdir: "raw",
	qmdCollection: "project-wiki",
	autoCompactOnTrigger: true,
	lint: true,
	autoScaffold: true,
	translationModelId: "",
	translationModelProvider: "",
	cooldownMs: 60_000,
	keepSnapshots: 10,
	qmdAutoEmbedOnStart: true,
	prefetchMinPages: 5,
	logArchiveSuggestEntries: 500,
};

interface SettingsFile {
	wikiKeeper?: Partial<WikiKeeperSettings>;
}

function readJsonSafe(path: string): SettingsFile | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as SettingsFile;
	} catch {
		return undefined;
	}
}

export function loadSettings(cwd: string): WikiKeeperSettings {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	const global = readJsonSafe(join(home, ".pi", "agent", "settings.json"))?.wikiKeeper ?? {};
	const project = readJsonSafe(join(cwd, ".pi", "settings.json"))?.wikiKeeper ?? {};
	return { ...DEFAULT_SETTINGS, ...global, ...project };
}

export interface WikiPaths {
	root: string; // absolute path to wiki/
	raw: string;
	entities: string;
	concepts: string;
	sources: string;
	indexMd: string;
	logMd: string;
	schemaMd: string;
	lintReportMd: string;
}

export function resolveWikiPaths(cwd: string, settings: WikiKeeperSettings): WikiPaths {
	const root = join(cwd, settings.wikiDir);
	return {
		root,
		raw: join(root, settings.rawSubdir),
		entities: join(root, "entities"),
		concepts: join(root, "concepts"),
		sources: join(root, "sources"),
		indexMd: join(root, "index.md"),
		logMd: join(root, "log.md"),
		schemaMd: join(root, "schema.md"),
		lintReportMd: join(root, "lint-report.md"),
	};
}
