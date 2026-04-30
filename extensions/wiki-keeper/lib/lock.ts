import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";

const STALE_LOCK_MS = 5 * 60_000; // 5 minutes

interface LockMeta {
	pid: number;
	sessionId: string;
	startedAt: number;
	host?: string;
}

function readLock(path: string): LockMeta | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as LockMeta;
	} catch {
		return undefined;
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e: any) {
		return e?.code === "EPERM"; // EPERM = exists but not ours; ESRCH = gone
	}
}

function isStale(meta: LockMeta): boolean {
	if (!isAlive(meta.pid)) return true;
	if (Date.now() - meta.startedAt > STALE_LOCK_MS) return true;
	return false;
}

export interface LockHandle {
	release(): void;
	meta: LockMeta;
}

/** Best-effort cross-process lock using exclusive file create. */
export async function acquireWikiLock(
	lockPath: string,
	sessionId: string,
	options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<LockHandle | undefined> {
	const timeoutMs = options.timeoutMs ?? 30_000;
	const pollMs = options.pollMs ?? 250;
	const deadline = Date.now() + timeoutMs;
	const meta: LockMeta = {
		pid: process.pid,
		sessionId,
		startedAt: Date.now(),
		host: process.env.HOSTNAME || process.env.HOST || "unknown",
	};
	const payload = JSON.stringify(meta);

	mkdirSync(dirname(lockPath), { recursive: true });

	while (true) {
		try {
			// 'wx' = exclusive create; throws EEXIST if file exists
			const fh = await open(lockPath, "wx");
			await fh.writeFile(payload);
			await fh.close();
			return {
				meta,
				release() {
					try {
						const current = readLock(lockPath);
						if (current && current.pid === process.pid && current.startedAt === meta.startedAt) {
							unlinkSync(lockPath);
						}
					} catch {}
				},
			};
		} catch (err: any) {
			if (err?.code !== "EEXIST") {
				return undefined; // unexpected error; fail open
			}
			const existing = readLock(lockPath);
			if (existing && isStale(existing)) {
				try {
					unlinkSync(lockPath);
				} catch {}
				continue; // retry immediately
			}
			if (Date.now() >= deadline) return undefined;
			await new Promise((r) => setTimeout(r, pollMs));
		}
	}
}

// ─── Snapshots (for /wiki:undo) ───────────────────────────────────────

export interface SnapshotInfo {
	path: string;
	timestamp: number;
	stamp: string;
}

const SNAPSHOT_DIR = ".snapshots";
const DEFAULT_KEEP_SNAPSHOTS = 10;

function listSnapshotsRaw(wikiRoot: string): SnapshotInfo[] {
	const dir = join(wikiRoot, SNAPSHOT_DIR);
	if (!existsSync(dir)) return [];
	const entries: SnapshotInfo[] = [];
	for (const name of (readdirSyncSafe(dir))) {
		const full = join(dir, name);
		try {
			const st = statSync(full);
			if (st.isDirectory()) entries.push({ path: full, timestamp: st.mtimeMs, stamp: name });
		} catch {}
	}
	return entries.sort((a, b) => b.timestamp - a.timestamp);
}

function readdirSyncSafe(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

export function listSnapshots(wikiRoot: string): SnapshotInfo[] {
	return listSnapshotsRaw(wikiRoot);
}

function copyRec(src: string, dst: string): void {
	const st = statSync(src);
	if (st.isDirectory()) {
		const base = src.split("/").pop() ?? "";
		if (base === SNAPSHOT_DIR) return;
		if (base === ".lock") return;
		mkdirSync(dst, { recursive: true });
		for (const child of readdirSync(src)) copyRec(join(src, child), join(dst, child));
	} else if (st.isFile()) {
		copyFileSync(src, dst);
	}
}

export function snapshotWiki(wikiRoot: string, keep = DEFAULT_KEEP_SNAPSHOTS): SnapshotInfo | undefined {
	if (!existsSync(wikiRoot)) return undefined;
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const dest = join(wikiRoot, SNAPSHOT_DIR, stamp);
	mkdirSync(dest, { recursive: true });
	for (const entry of readdirSync(wikiRoot)) {
		if (entry === SNAPSHOT_DIR || entry === ".lock") continue;
		copyRec(join(wikiRoot, entry), join(dest, entry));
	}
	pruneSnapshots(wikiRoot, keep);
	return { path: dest, timestamp: Date.now(), stamp };
}

function pruneSnapshots(wikiRoot: string, keep: number): void {
	const all = listSnapshotsRaw(wikiRoot);
	for (const old of all.slice(keep)) {
		try {
			rmSync(old.path, { recursive: true, force: true });
		} catch {}
	}
}

export function restoreLatestSnapshot(wikiRoot: string): SnapshotInfo | undefined {
	const all = listSnapshotsRaw(wikiRoot);
	if (all.length === 0) return undefined;
	const latest = all[0];
	// Remove all top-level entries except .snapshots / .lock
	for (const entry of readdirSync(wikiRoot)) {
		if (entry === SNAPSHOT_DIR || entry === ".lock") continue;
		rmSync(join(wikiRoot, entry), { recursive: true, force: true });
	}
	for (const entry of readdirSync(latest.path)) {
		copyRec(join(latest.path, entry), join(wikiRoot, entry));
	}
	// Remove the snapshot we restored from so the next undo goes one further back.
	try {
		rmSync(latest.path, { recursive: true, force: true });
	} catch {}
	return latest;
}

export function writeFile(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}
