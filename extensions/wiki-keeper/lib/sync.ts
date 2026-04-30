import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileMtime, gitBlobShaOfFile, parseDoc } from "./frontmatter.js";
import { listMarkdownFiles } from "./wiki-fs.js";
import type { WikiPaths } from "./settings.js";

// ─── .last-sync.json ──────────────────────────────────────────────────

export interface LastSyncState {
	gitHead?: string;
	gitBranch?: string;
	timestamp: number;
	syncedFiles?: number;
}

export function readLastSync(paths: WikiPaths): LastSyncState | undefined {
	const p = join(paths.root, ".last-sync.json");
	if (!existsSync(p)) return undefined;
	try {
		return JSON.parse(readFileSync(p, "utf8")) as LastSyncState;
	} catch {
		return undefined;
	}
}

export function writeLastSync(paths: WikiPaths, projectCwd: string, syncedFiles?: number): LastSyncState {
	const state: LastSyncState = {
		gitHead: gitHead(projectCwd),
		gitBranch: gitBranch(projectCwd),
		timestamp: Date.now(),
		syncedFiles,
	};
	writeFileSync(join(paths.root, ".last-sync.json"), JSON.stringify(state, null, 2) + "\n");
	return state;
}

// ─── Git helpers ──────────────────────────────────────────────────────

export function isGitRepo(cwd: string): boolean {
	const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, encoding: "utf8" });
	return r.status === 0 && r.stdout.trim() === "true";
}

export function gitHead(cwd: string): string | undefined {
	const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
	if (r.status !== 0) return undefined;
	return r.stdout.trim() || undefined;
}

export function gitBranch(cwd: string): string | undefined {
	const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8" });
	if (r.status !== 0) return undefined;
	const b = r.stdout.trim();
	return b && b !== "HEAD" ? b : undefined;
}

export function gitChangedSince(cwd: string, sinceSha: string, excludePrefix?: string): string[] {
	// Diff (committed) since sinceSha + uncommitted changes.
	const committed = spawnSync("git", ["diff", "--name-only", "-M", `${sinceSha}..HEAD`], { cwd, encoding: "utf8" });
	const dirty = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
	const set = new Set<string>();
	const push = (p: string) => {
		if (!p) return;
		if (excludePrefix && (p === excludePrefix || p.startsWith(excludePrefix + "/"))) return;
		set.add(p);
	};
	if (committed.status === 0) {
		for (const line of committed.stdout.split("\n")) push(line.trim());
	}
	if (dirty.status === 0) {
		for (const rawLine of dirty.stdout.split("\n")) {
			// `git status --porcelain` format: "XY <path>" where X=index, Y=worktree, plus a single space.
			// Do NOT .trim() — a leading space in XY is meaningful (e.g. " M file" = unstaged modify) and
			// trimming corrupts the slice offset, eating the first character of the path.
			if (rawLine.length < 4) continue;
			const path = rawLine.includes(" -> ") ? rawLine.split(" -> ").pop()! : rawLine.slice(3);
			push(path);
		}
	}
	return [...set].sort();
}

// ─── Drift detection ──────────────────────────────────────────────────

export interface DriftReport {
	mode: "git" | "mtime" | "branch-switch" | "none";
	sinceHead?: string;
	currentHead?: string;
	sinceBranch?: string;
	currentBranch?: string;
	changedFiles: string[]; // project-relative paths (excludes wiki dir)
	staleWikiPages: { wikiFile: string; sourceFile: string; reason: "sha-mismatch" | "source-missing" }[];
	totalWikiPagesWithSource: number;
}

const SOURCE_FILE_KEY = "source-file";
const SOURCE_SHA_KEY = "source-sha";

export interface PageRef {
	wikiFile: string; // absolute
	sourceFile: string; // absolute (resolved against projectCwd)
	storedSha?: string;
}

export function listSourceTrackingPages(paths: WikiPaths, projectCwd: string): PageRef[] {
	const out: PageRef[] = [];
	for (const wikiFile of listMarkdownFiles(paths.root)) {
		let text: string;
		try {
			text = readFileSync(wikiFile, "utf8");
		} catch {
			continue;
		}
		const parsed = parseDoc(text);
		const sourceFile = parsed.frontmatter[SOURCE_FILE_KEY];
		if (typeof sourceFile !== "string" || !sourceFile) continue;
		const abs = resolve(projectCwd, sourceFile);
		const storedSha = typeof parsed.frontmatter[SOURCE_SHA_KEY] === "string"
			? (parsed.frontmatter[SOURCE_SHA_KEY] as string)
			: undefined;
		out.push({ wikiFile, sourceFile: abs, storedSha });
	}
	return out;
}

export function detectDrift(paths: WikiPaths, projectCwd: string, wikiDirRelative?: string): DriftReport {
	const last = readLastSync(paths);
	const isGit = isGitRepo(projectCwd);
	const currentHead = isGit ? gitHead(projectCwd) : undefined;
	const currentBranch = isGit ? gitBranch(projectCwd) : undefined;
	const sinceBranch = last?.gitBranch;

	let changedFiles: string[] = [];
	let mode: DriftReport["mode"] = "none";

	const onDifferentBranch = !!(sinceBranch && currentBranch && sinceBranch !== currentBranch);

	if (isGit && last?.gitHead && currentHead) {
		if (onDifferentBranch) {
			// Branch switched: don't try to enumerate cross-branch diffs (would be huge and confusing).
			mode = "branch-switch";
			changedFiles = [];
		} else {
			mode = "git";
			changedFiles = gitChangedSince(projectCwd, last.gitHead, wikiDirRelative);
		}
	} else if (last?.timestamp) {
		mode = "mtime";
	}

	// Per-page SHA / mtime check (works in both modes, and even with no last-sync).
	const refs = listSourceTrackingPages(paths, projectCwd);
	const staleWikiPages: DriftReport["staleWikiPages"] = [];
	for (const ref of refs) {
		if (!existsSync(ref.sourceFile)) {
			staleWikiPages.push({ wikiFile: ref.wikiFile, sourceFile: ref.sourceFile, reason: "source-missing" });
			continue;
		}
		const currentSha = gitBlobShaOfFile(ref.sourceFile);
		if (ref.storedSha && currentSha && ref.storedSha !== currentSha) {
			staleWikiPages.push({ wikiFile: ref.wikiFile, sourceFile: ref.sourceFile, reason: "sha-mismatch" });
		}
	}

	return {
		mode,
		sinceHead: last?.gitHead,
		currentHead,
		sinceBranch,
		currentBranch,
		changedFiles,
		staleWikiPages,
		totalWikiPagesWithSource: refs.length,
	};
}

export function summarizeDrift(report: DriftReport, projectCwd: string, paths: WikiPaths): string {
	const rel = (p: string) => relative(projectCwd, p) || p;
	const wrel = (p: string) => relative(paths.root, p) || p;
	const lines: string[] = [];
	lines.push(`mode:                ${report.mode}`);
	if (report.mode === "branch-switch") {
		lines.push(`branch:              ${report.sinceBranch} → ${report.currentBranch}`);
		lines.push(`note:                cross-branch diff suppressed; use /wiki:sync <paths> explicitly`);
	} else if (report.currentBranch) {
		lines.push(`branch:              ${report.currentBranch}`);
	}
	if (report.sinceHead && report.currentHead) {
		const same = report.sinceHead === report.currentHead;
		lines.push(`HEAD:                ${report.currentHead.slice(0, 8)} ${same ? "(== last sync)" : `(was ${report.sinceHead.slice(0, 8)})`}`);
	} else if (report.currentHead) {
		lines.push(`HEAD:                ${report.currentHead.slice(0, 8)} (no prior sync)`);
	}
	lines.push(`changed since sync:  ${report.changedFiles.length} file(s)`);
	if (report.changedFiles.length > 0 && report.changedFiles.length <= 12) {
		for (const f of report.changedFiles) lines.push(`  - ${f}`);
	} else if (report.changedFiles.length > 12) {
		for (const f of report.changedFiles.slice(0, 8)) lines.push(`  - ${f}`);
		lines.push(`  - … and ${report.changedFiles.length - 8} more`);
	}
	lines.push(`tracked wiki pages:  ${report.totalWikiPagesWithSource}`);
	lines.push(`stale wiki pages:    ${report.staleWikiPages.length}`);
	for (const s of report.staleWikiPages.slice(0, 10)) {
		lines.push(`  - ${wrel(s.wikiFile)} → ${rel(s.sourceFile)} (${s.reason})`);
	}
	if (report.staleWikiPages.length > 10) lines.push(`  - … and ${report.staleWikiPages.length - 10} more`);
	return lines.join("\n");
}

/** Convenience: union of changed source files + sources backing stale wiki pages. Excludes wiki dir. */
export function suggestSyncTargets(report: DriftReport, projectCwd: string, wikiDirRelative?: string): string[] {
	const set = new Set<string>(report.changedFiles);
	for (const s of report.staleWikiPages) {
		const r = relative(projectCwd, s.sourceFile);
		if (r && !r.startsWith("..")) set.add(r);
	}
	if (wikiDirRelative) {
		for (const p of [...set]) {
			if (p === wikiDirRelative || p.startsWith(wikiDirRelative + "/")) set.delete(p);
		}
	}
	return [...set].sort();
}
