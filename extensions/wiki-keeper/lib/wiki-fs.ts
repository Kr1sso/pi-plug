import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { WikiPaths } from "./settings.js";

export function ensureDir(path: string): void {
	if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

export function ensureWikiTree(paths: WikiPaths): void {
	for (const dir of [paths.root, paths.raw, paths.entities, paths.concepts, paths.sources]) {
		ensureDir(dir);
	}
}

export function listMarkdownFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		if (!existsSync(dir)) return;
		for (const name of readdirSync(dir)) {
			const full = join(dir, name);
			let st;
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) walk(full);
			else if (st.isFile() && name.toLowerCase().endsWith(".md")) out.push(full);
		}
	};
	walk(root);
	return out;
}

/** Operations the translation step produces and we apply atomically. */
export type WikiOp =
	| { op: "create"; path: string; content: string }
	| { op: "overwrite"; path: string; content: string }
	| { op: "append"; path: string; content: string }
	| { op: "replace_section"; path: string; heading: string; content: string }
	| { op: "delete"; path: string }
	| { op: "log"; entry: string };

export interface ApplyReport {
	created: string[];
	updated: string[];
	skipped: { path: string; reason: string }[];
	errors: { path: string; error: string }[];
}

function safePath(root: string, p: string): string | null {
	const abs = resolve(root, p);
	const rel = relative(root, abs);
	if (rel.startsWith("..") || rel.startsWith("/")) return null;
	return abs;
}

export function applyOps(paths: WikiPaths, ops: WikiOp[]): ApplyReport {
	const report: ApplyReport = { created: [], updated: [], skipped: [], errors: [] };
	for (const op of ops) {
		try {
			if (op.op === "log") {
				appendFileSync(paths.logMd, op.entry.endsWith("\n") ? op.entry : op.entry + "\n");
				report.updated.push(paths.logMd);
				continue;
			}
			const abs = safePath(paths.root, op.path);
			if (!abs) {
				report.skipped.push({ path: op.path, reason: "path escapes wiki root" });
				continue;
			}
			ensureDir(dirname(abs));
			if (op.op === "create") {
				if (existsSync(abs)) {
					report.skipped.push({ path: op.path, reason: "exists; use overwrite or replace_section" });
					continue;
				}
				writeFileSync(abs, op.content);
				report.created.push(abs);
			} else if (op.op === "overwrite") {
				const existed = existsSync(abs);
				writeFileSync(abs, op.content);
				if (existed) report.updated.push(abs);
				else report.created.push(abs);
			} else if (op.op === "append") {
				const sep = existsSync(abs) ? (readFileSync(abs, "utf8").endsWith("\n") ? "" : "\n") : "";
				appendFileSync(abs, sep + (op.content.endsWith("\n") ? op.content : op.content + "\n"));
				report.updated.push(abs);
			} else if (op.op === "replace_section") {
				const existing = existsSync(abs) ? readFileSync(abs, "utf8") : "";
				const next = replaceSection(existing, op.heading, op.content);
				writeFileSync(abs, next);
				report.updated.push(abs);
			} else if (op.op === "delete") {
				if (!existsSync(abs)) {
					report.skipped.push({ path: op.path, reason: "already absent" });
					continue;
				}
				rmSync(abs, { force: true });
				report.updated.push(abs);
			}
		} catch (err) {
			report.errors.push({ path: (op as any).path ?? "(log)", error: String(err) });
		}
	}
	return report;
}

/**
 * Replace a markdown section identified by an exact heading line (e.g. "## Goal").
 * Section spans from the heading line to the next heading of equal-or-higher level.
 * If the heading is not found, the new section is appended to the end of the file.
 */
export function replaceSection(content: string, heading: string, body: string): string {
	const headingMatch = heading.match(/^(#+)\s+/);
	if (!headingMatch) {
		// Treat as plain text heading; append to end.
		return content + (content.endsWith("\n") ? "" : "\n") + heading + "\n" + body + "\n";
	}
	const level = headingMatch[1].length;
	const lines = content.split("\n");
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim() === heading.trim()) {
			start = i;
			break;
		}
	}
	const newSection = `${heading}\n${body.replace(/\n$/, "")}\n`;
	if (start === -1) {
		const sep = content.endsWith("\n") || content.length === 0 ? "" : "\n";
		return content + sep + (content.length ? "\n" : "") + newSection;
	}
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		const m = lines[i].match(/^(#+)\s+/);
		if (m && m[1].length <= level) {
			end = i;
			break;
		}
	}
	const before = lines.slice(0, start).join("\n");
	const after = lines.slice(end).join("\n");
	const joined = [before, newSection.replace(/\n$/, ""), after].filter((s) => s.length > 0).join("\n");
	return joined.endsWith("\n") ? joined : joined + "\n";
}

// ─── Linting ─────────────────────────────────────────────────────────

export interface LintReport {
	deadLinks: { file: string; link: string; line: number }[];
	orphans: string[];
	contradictions: { file: string; line: number; snippet: string }[];
	totalPages: number;
	totalLinks: number;
}

const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
const MDLINK_RE = /\[[^\]]*\]\(([^)\s#]+)(?:#[^)]+)?\)/g;
const CONTRADICTION_RE = />\s*\[!contradiction\]/i;

/**
 * Strip YAML frontmatter, fenced code blocks, and inline code spans so the
 * link extractor doesn't pick up example wikilinks (e.g. in schema.md or in
 * lint-report.md from a previous run, where dead links are quoted in
 * backticks).
 *
 * Replaces stripped regions with spaces of the same length so line numbers
 * and column offsets are preserved for diagnostics.
 */
function stripNonProse(text: string): string {
	const blank = (s: string) => s.replace(/[^\n]/g, " ");
	let out = text;
	// Frontmatter: leading --- ... --- block.
	out = out.replace(/^---\n[\s\S]*?\n---\n?/, (m) => blank(m));
	// Fenced code blocks: ``` ... ``` or ~~~ ... ~~~ (greedy-safe via lazy).
	out = out.replace(/(^|\n)(```|~~~)[^\n]*\n[\s\S]*?\n\2[ \t]*(?=\n|$)/g, (m) => blank(m));
	// Inline code spans: `...` (single or multi-backtick), no line breaks.
	out = out.replace(/(`+)[^`\n]+?\1/g, (m) => blank(m));
	return out;
}

/** Normalize a wikilink target for lookup: lowercase, strip ./ ../ leading /, trailing .md, spaces→dashes. */
function normalizeWikilinkTarget(raw: string): string {
	let t = raw.trim().toLowerCase();
	while (t.startsWith("./")) t = t.slice(2);
	while (t.startsWith("../")) t = t.slice(3);
	if (t.startsWith("/")) t = t.slice(1);
	t = t.replace(/\.md$/i, "");
	return t;
}

export function lintWiki(paths: WikiPaths): LintReport {
	const files = listMarkdownFiles(paths.root);
	const fileSet = new Set(files.map((f) => resolve(f)));
	const lintReportAbs = resolve(paths.lintReportMd);

	// Index files for wikilink resolution.
	//   byPath: full relative-to-root path (no .md, lowercase) → absolute path. Unambiguous.
	//   byName: bare basename (no .md, lowercase) → set of absolute paths. Ambiguous if >1.
	const byPath = new Map<string, string>();
	const byName = new Map<string, Set<string>>();
	for (const f of files) {
		const rel = relative(paths.root, f).replace(/\\/g, "/").replace(/\.md$/i, "").toLowerCase();
		byPath.set(rel, f);
		// Also index space- and dash-equivalent variants.
		byPath.set(rel.replace(/-/g, " "), f);
		const name = rel.split("/").pop() ?? rel;
		for (const variant of [name, name.replace(/-/g, " ")]) {
			let set = byName.get(variant);
			if (!set) {
				set = new Set();
				byName.set(variant, set);
			}
			set.add(f);
		}
	}

	const resolveWikilink = (rawTarget: string): string | null => {
		const t = normalizeWikilinkTarget(rawTarget);
		if (!t) return null;
		const hit =
			byPath.get(t) ||
			byPath.get(t.replace(/\s+/g, "-")) ||
			byPath.get(t.replace(/-/g, " "));
		if (hit) return hit;
		// Bare name lookup: only resolve if unambiguous.
		for (const key of [t, t.replace(/\s+/g, "-"), t.replace(/-/g, " ")]) {
			const set = byName.get(key);
			if (set && set.size === 1) return set.values().next().value as string;
		}
		return null;
	};

	const inboundLinks = new Map<string, number>();
	const dead: LintReport["deadLinks"] = [];
	const contradictions: LintReport["contradictions"] = [];
	let totalLinks = 0;

	for (const file of files) {
		// Skip the lint-report itself: its body is generated from prior runs and
		// quotes dead-link strings, which would otherwise feed back into itself.
		if (resolve(file) === lintReportAbs) continue;
		let rawText: string;
		try {
			rawText = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		const rawLines = rawText.split("\n");
		const proseText = stripNonProse(rawText);
		const proseLines = proseText.split("\n");
		for (let lineIdx = 0; lineIdx < proseLines.length; lineIdx++) {
			// Contradiction callout detection runs against the raw line so it still
			// matches if it lives in an unusual context.
			if (CONTRADICTION_RE.test(rawLines[lineIdx] ?? "")) {
				contradictions.push({ file, line: lineIdx + 1, snippet: (rawLines[lineIdx] ?? "").trim().slice(0, 200) });
			}
			const line = proseLines[lineIdx];
			let m: RegExpExecArray | null;
			WIKILINK_RE.lastIndex = 0;
			while ((m = WIKILINK_RE.exec(line))) {
				totalLinks++;
				const hit = resolveWikilink(m[1]);
				if (!hit) dead.push({ file, link: `[[${m[1]}]]`, line: lineIdx + 1 });
				else inboundLinks.set(resolve(hit), (inboundLinks.get(resolve(hit)) ?? 0) + 1);
			}
			MDLINK_RE.lastIndex = 0;
			while ((m = MDLINK_RE.exec(line))) {
				const target = m[1];
				if (/^[a-z]+:\/\//i.test(target) || target.startsWith("#") || target.startsWith("mailto:")) continue;
				totalLinks++;
				const abs = resolve(dirname(file), target);
				if (fileSet.has(abs)) {
					inboundLinks.set(abs, (inboundLinks.get(abs) ?? 0) + 1);
				} else {
					dead.push({ file, link: target, line: lineIdx + 1 });
				}
			}
		}
	}
	const orphans: string[] = [];
	for (const f of files) {
		const abs = resolve(f);
		if (abs === resolve(paths.indexMd) || abs === resolve(paths.logMd) || abs === resolve(paths.schemaMd) || abs === resolve(paths.lintReportMd)) continue;
		if ((inboundLinks.get(abs) ?? 0) === 0) orphans.push(f);
	}

	return { deadLinks: dead, orphans, contradictions, totalPages: files.length, totalLinks };
}

export function formatLintReport(report: LintReport, wikiRoot: string): string {
	const rel = (p: string) => relative(wikiRoot, p) || p;
	const lines: string[] = [];
	lines.push(`# Wiki Lint Report`);
	lines.push("");
	lines.push(`- Pages scanned: **${report.totalPages}**`);
	lines.push(`- Links scanned: **${report.totalLinks}**`);
	lines.push(`- Dead links: **${report.deadLinks.length}**`);
	lines.push(`- Orphan pages: **${report.orphans.length}**`);
	lines.push(`- Contradiction callouts: **${report.contradictions.length}**`);
	lines.push("");
	if (report.deadLinks.length) {
		lines.push(`## Dead Links`);
		for (const d of report.deadLinks) lines.push(`- \`${rel(d.file)}:${d.line}\` → \`${d.link}\``);
		lines.push("");
	}
	if (report.orphans.length) {
		lines.push(`## Orphan Pages`);
		for (const o of report.orphans) lines.push(`- \`${rel(o)}\``);
		lines.push("");
	}
	if (report.contradictions.length) {
		lines.push(`## Contradictions`);
		for (const c of report.contradictions) lines.push(`- \`${rel(c.file)}:${c.line}\` — ${c.snippet}`);
		lines.push("");
	}
	return lines.join("\n");
}

export function readFileIfExists(path: string): string | null {
	try {
		return existsSync(path) ? readFileSync(path, "utf8") : null;
	} catch {
		return null;
	}
}

// ─── Log archive ─────────────────────────────────────────────────────

/** Count log entries (lines starting with `## [`). */
export function countLogEntries(logPath: string): number {
	const text = readFileIfExists(logPath);
	if (!text) return 0;
	let count = 0;
	for (const line of text.split("\n")) {
		if (/^##\s+\[/.test(line)) count++;
	}
	return count;
}

export interface ArchiveResult {
	archivedEntries: number;
	archiveFiles: string[]; // absolute paths of archive files written
	keptEntries: number;
}

/**
 * Move log entries older than `keepRecent` (count) into per-month archive files
 * `log-archive-YYYY-MM.md` next to log.md. log.md keeps its `# Log` header and
 * the most recent `keepRecent` entries.
 */
export function archiveLog(logPath: string, keepRecent: number): ArchiveResult {
	const text = readFileIfExists(logPath);
	if (!text) return { archivedEntries: 0, archiveFiles: [], keptEntries: 0 };

	const lines = text.split("\n");
	const entries: { stamp: string; block: string }[] = [];
	const header: string[] = [];
	let currentStamp = "";
	let currentLines: string[] = [];
	let seenFirstEntry = false;
	const pushEntry = () => {
		if (currentStamp) entries.push({ stamp: currentStamp, block: currentLines.join("\n") });
	};
	for (const line of lines) {
		const m = line.match(/^##\s+\[([^\]]+)\]/);
		if (m) {
			if (seenFirstEntry) pushEntry();
			seenFirstEntry = true;
			currentStamp = m[1];
			currentLines = [line];
		} else if (!seenFirstEntry) {
			header.push(line);
		} else {
			currentLines.push(line);
		}
	}
	if (seenFirstEntry) pushEntry();

	if (entries.length <= keepRecent) {
		return { archivedEntries: 0, archiveFiles: [], keptEntries: entries.length };
	}

	const toArchive = entries.slice(0, entries.length - keepRecent);
	const toKeep = entries.slice(entries.length - keepRecent);

	const byMonth = new Map<string, string[]>();
	for (const e of toArchive) {
		const monthMatch = e.stamp.match(/^(\d{4}-\d{2})/);
		const month = monthMatch ? monthMatch[1] : "undated";
		const arr = byMonth.get(month) ?? [];
		arr.push(e.block);
		byMonth.set(month, arr);
	}

	const dir = dirname(logPath);
	const archiveFiles: string[] = [];
	for (const [month, blocks] of byMonth) {
		const archivePath = join(dir, `log-archive-${month}.md`);
		const existing = readFileIfExists(archivePath);
		const headerLine = `# Wiki Log Archive (${month})\n`;
		const body = blocks.join("\n");
		const content = existing
			? (existing.endsWith("\n") ? existing : existing + "\n") + body + (body.endsWith("\n") ? "" : "\n")
			: headerLine + "\n" + body + (body.endsWith("\n") ? "" : "\n");
		ensureDir(dirname(archivePath));
		writeFileSync(archivePath, content);
		archiveFiles.push(archivePath);
	}

	const newLog =
		(header.length ? header.join("\n").replace(/\n+$/, "") + "\n\n" : "") +
		toKeep.map((e) => e.block).join("\n") +
		"\n";
	writeFileSync(logPath, newLog);
	return { archivedEntries: toArchive.length, archiveFiles, keptEntries: toKeep.length };
}
