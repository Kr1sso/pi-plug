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

export function lintWiki(paths: WikiPaths): LintReport {
	const files = listMarkdownFiles(paths.root);
	const fileSet = new Set(files.map((f) => resolve(f)));
	// Map of base (no ext, lowercase) → absolute path, for wikilink resolution.
	const byBase = new Map<string, string>();
	for (const f of files) {
		const base = f.replace(/\.md$/i, "").toLowerCase();
		byBase.set(base, f);
		// Also index by file basename without dir for [[Page]] style lookups.
		const justName = base.split("/").pop() ?? base;
		if (!byBase.has(justName)) byBase.set(justName, f);
	}
	const inboundLinks = new Map<string, number>();
	const dead: LintReport["deadLinks"] = [];
	const contradictions: LintReport["contradictions"] = [];
	let totalLinks = 0;

	for (const file of files) {
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		const lines = text.split("\n");
		for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
			const line = lines[lineIdx];
			if (CONTRADICTION_RE.test(line)) {
				contradictions.push({ file, line: lineIdx + 1, snippet: line.trim().slice(0, 200) });
			}
			let m: RegExpExecArray | null;
			WIKILINK_RE.lastIndex = 0;
			while ((m = WIKILINK_RE.exec(line))) {
				totalLinks++;
				const target = m[1].trim().toLowerCase();
				const hit = byBase.get(target) || byBase.get(target.replace(/\s+/g, "-"));
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
