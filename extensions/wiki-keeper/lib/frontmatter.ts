import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";

/**
 * Minimal YAML-frontmatter parser. Supports `key: value` (string|number|bool|null)
 * and inline arrays `key: [a, b, c]`. NOT a full YAML parser — intentionally narrow,
 * because the wiki schema only uses flat key/value frontmatter.
 */
export interface Frontmatter {
	[key: string]: string | number | boolean | string[] | null;
}

export interface ParsedDoc {
	frontmatter: Frontmatter;
	body: string;
	hadFrontmatter: boolean;
}

const FENCE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;

export function parseDoc(text: string): ParsedDoc {
	const m = text.match(FENCE);
	if (!m) return { frontmatter: {}, body: text, hadFrontmatter: false };
	const fm: Frontmatter = {};
	for (const rawLine of m[1].split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const key = line.slice(0, idx).trim();
		let val = line.slice(idx + 1).trim();
		if (val === "" || val === "null" || val === "~") {
			fm[key] = null;
		} else if (val === "true") {
			fm[key] = true;
		} else if (val === "false") {
			fm[key] = false;
		} else if (/^-?\d+(\.\d+)?$/.test(val)) {
			fm[key] = Number(val);
		} else if (val.startsWith("[") && val.endsWith("]")) {
			const inner = val.slice(1, -1).trim();
			fm[key] = inner === "" ? [] : inner.split(",").map((s) => unquote(s.trim()));
		} else {
			fm[key] = unquote(val);
		}
	}
	return { frontmatter: fm, body: text.slice(m[0].length), hadFrontmatter: true };
}

function unquote(s: string): string {
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
		return s.slice(1, -1);
	}
	return s;
}

function quoteIfNeeded(s: string): string {
	if (s === "" || /[:#\[\]&*!|>'"%@`,]/.test(s) || /^\s|\s$/.test(s)) {
		return `"${s.replace(/"/g, '\\"')}"`;
	}
	return s;
}

export function serializeDoc(fm: Frontmatter, body: string): string {
	const keys = Object.keys(fm);
	if (keys.length === 0) return body.startsWith("---") ? body : body;
	const lines: string[] = ["---"];
	for (const k of keys) {
		const v = fm[k];
		if (v === null) lines.push(`${k}: null`);
		else if (typeof v === "boolean" || typeof v === "number") lines.push(`${k}: ${v}`);
		else if (Array.isArray(v)) lines.push(`${k}: [${v.map((s) => quoteIfNeeded(s)).join(", ")}]`);
		else lines.push(`${k}: ${quoteIfNeeded(v)}`);
	}
	lines.push("---", "");
	return lines.join("\n") + body.replace(/^\n/, "");
}

/**
 * Compute git's blob SHA for arbitrary content (matches `git hash-object`).
 * Format: SHA1 of `"blob " + length + "\0" + content`.
 */
export function gitBlobSha(content: Buffer | string): string {
	const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
	const hash = createHash("sha1");
	hash.update(`blob ${buf.length}\0`);
	hash.update(buf);
	return hash.digest("hex");
}

export function gitBlobShaOfFile(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return gitBlobSha(readFileSync(path));
	} catch {
		return undefined;
	}
}

export function fileMtime(path: string): number | undefined {
	try {
		return Math.floor(statSync(path).mtimeMs);
	} catch {
		return undefined;
	}
}

/** Re-stamp a wiki page's frontmatter with the current source-sha + source-mtime. Returns updated text. */
export function restampPage(pageText: string, sourceFileAbs: string): string {
	const parsed = parseDoc(pageText);
	const sha = gitBlobShaOfFile(sourceFileAbs);
	const mtime = fileMtime(sourceFileAbs);
	if (!sha) return pageText;
	parsed.frontmatter["source-sha"] = sha;
	if (mtime !== undefined) parsed.frontmatter["source-mtime"] = mtime;
	parsed.frontmatter["last-synced"] = new Date().toISOString().slice(0, 10);
	return serializeDoc(parsed.frontmatter, parsed.body);
}
