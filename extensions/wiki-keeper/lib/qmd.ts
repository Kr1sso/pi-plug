import { spawn } from "node:child_process";

export interface QmdResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	code: number;
}

function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; input?: string } = {}): Promise<QmdResult> {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, { cwd: opts.cwd, env: process.env });
		let stdout = "";
		let stderr = "";
		const timer = opts.timeoutMs
			? setTimeout(() => {
					try {
						child.kill("SIGKILL");
					} catch {}
				}, opts.timeoutMs)
			: undefined;
		child.stdout.on("data", (b) => (stdout += b.toString()));
		child.stderr.on("data", (b) => (stderr += b.toString()));
		child.on("error", (err) => {
			if (timer) clearTimeout(timer);
			resolve({ ok: false, stdout, stderr: stderr + String(err), code: -1 });
		});
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			resolve({ ok: code === 0, stdout, stderr, code: code ?? -1 });
		});
		if (opts.input) {
			child.stdin.write(opts.input);
			child.stdin.end();
		}
	});
}

export async function qmdAvailable(): Promise<boolean> {
	const r = await run("qmd", ["--version"], { timeoutMs: 5000 });
	return r.ok;
}

/**
 * Pure helper: parse qmd's `collection add` output for the path-conflict case.
 * Returns the existing collection name when qmd reports the wiki path is already
 * registered under a different name; undefined otherwise. Exported for unit testing.
 */
export function parseExistingCollectionFromAddOutput(stdout: string, stderr = ""): string | undefined {
	const combined = stdout + "\n" + stderr;
	if (!/already exists for this path/i.test(combined)) return undefined;
	const match = combined.match(/Name:\s*([A-Za-z0-9_.\-]+)\s*\(qmd:\/\//);
	return match?.[1];
}

export async function qmdEnsureCollection(collection: string, wikiRoot: string): Promise<QmdResult & { actualName?: string; conflict?: boolean }> {
	// `qmd collection add` is idempotent for the same name in modern qmd.
	const r = await run("qmd", ["collection", "add", wikiRoot, "--name", collection], { timeoutMs: 30_000 });
	if (r.ok) return { ...r, actualName: collection };

	// Path conflict: a DIFFERENT collection name is already bound to this path. qmd's modern
	// behaviour refuses re-registration. Use the existing name so callers don't silently
	// embed/query a non-existent collection (zero-hit failure mode).
	const existing = parseExistingCollectionFromAddOutput(r.stdout, r.stderr);
	if (existing) {
		return { ...r, ok: true, actualName: existing, conflict: true };
	}

	// Same-name-already-exists: idempotent success.
	if (/exists/i.test(r.stdout + r.stderr)) {
		return { ...r, ok: true, actualName: collection };
	}

	return r;
}

/**
 * Re-index a qmd collection: runs `qmd update` (lex/BM25 index) followed by `qmd embed`
 * (vector embeddings). qmd's `embed` only processes hashes already known to the lex index,
 * so calling `embed` without first calling `update` is a no-op for new/changed files — a
 * silent failure mode that produces empty wiki_query results even when the wiki has
 * dozens of pages on disk.
 */
export async function qmdReindex(collection: string, cwd: string): Promise<{ update: QmdResult; embed: QmdResult; ok: boolean }> {
	const update = await run("qmd", ["update"], { cwd, timeoutMs: 5 * 60_000 });
	// Even if `update` fails (e.g. transient lock), still try embed for any pending hashes.
	const embed = await run("qmd", ["embed", "-c", collection], { cwd, timeoutMs: 10 * 60_000 });
	return { update, embed, ok: update.ok && embed.ok };
}

export async function qmdEmbed(collection: string, cwd: string): Promise<QmdResult> {
	return run("qmd", ["embed", "-c", collection], { cwd, timeoutMs: 5 * 60_000 });
}

export interface QmdQueryHit {
	path?: string;
	docid?: string;
	score?: number;
	snippet?: string;
	[k: string]: unknown;
}

export async function qmdQuery(query: string, collection: string, topK = 5): Promise<QmdQueryHit[]> {
	const r = await run("qmd", ["query", query, "-c", collection, "--json", "-n", String(topK)], { timeoutMs: 60_000 });
	if (!r.ok) return [];
	try {
		const parsed = JSON.parse(r.stdout);
		if (Array.isArray(parsed)) return parsed as QmdQueryHit[];
		if (parsed && Array.isArray(parsed.results)) return parsed.results as QmdQueryHit[];
		if (parsed && Array.isArray(parsed.hits)) return parsed.hits as QmdQueryHit[];
		return [];
	} catch {
		return [];
	}
}

export async function qmdStatus(collection?: string): Promise<QmdResult> {
	const args = ["status"];
	if (collection) args.push("-c", collection);
	return run("qmd", args, { timeoutMs: 15_000 });
}

/**
 * Pure helper: classify whether qmd status text indicates an empty collection.
 * Exported separately so it can be unit-tested without spawning qmd.
 */
export function isQmdStatusTextEmpty(stdout: string, stderr = ""): boolean {
	const text = (stdout + "\n" + stderr).toLowerCase();
	if (/\b0\s+document(s)?\b/.test(text)) return true;
	if (/\bdocuments?\s*[:=]\s*0\b/.test(text)) return true;
	if (/\bno\s+documents?\b/.test(text)) return true;
	if (/\bcollection\s+empty\b/.test(text)) return true;
	return false;
}

/**
 * Best-effort check: does the collection's qmd index appear empty?
 * Parses `qmd status -c <coll>` looking for a doc count. Returns true ONLY when
 * we can confidently parse a 0-doc result; returns false when unparseable so we
 * don't kick off a needless embed.
 */
export async function qmdCollectionIsEmpty(collection: string): Promise<boolean> {
	const r = await qmdStatus(collection);
	if (!r.ok) return false;
	return isQmdStatusTextEmpty(r.stdout, r.stderr);
}
