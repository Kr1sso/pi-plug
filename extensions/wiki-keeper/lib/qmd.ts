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

export async function qmdEnsureCollection(collection: string, wikiRoot: string): Promise<QmdResult> {
	// `qmd collection add` is idempotent in modern qmd; ignore "already exists" errors.
	const r = await run("qmd", ["collection", "add", wikiRoot, "--name", collection], { timeoutMs: 30_000 });
	if (!r.ok && /exists/i.test(r.stderr + r.stdout)) {
		return { ...r, ok: true };
	}
	return r;
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
 * Best-effort check: does the collection's qmd index appear empty?
 * Parses `qmd status -c <coll>` looking for a doc count. Returns true ONLY when
 * we can confidently parse a 0-doc result; returns false when unparseable so we
 * don't kick off a needless embed.
 */
export async function qmdCollectionIsEmpty(collection: string): Promise<boolean> {
	const r = await qmdStatus(collection);
	if (!r.ok) return false;
	const text = (r.stdout + "\n" + r.stderr).toLowerCase();
	// Look for explicit zero indicators across plausible qmd output formats.
	if (/\b0\s+document(s)?\b/.test(text)) return true;
	if (/\bdocuments?\s*[:=]\s*0\b/.test(text)) return true;
	if (/\bno\s+documents?\b/.test(text)) return true;
	if (/\bcollection\s+empty\b/.test(text)) return true;
	return false;
}
