import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	acquireWikiLock,
	snapshotWiki,
	listSnapshots,
	restoreLatestSnapshot,
} from "./lock.ts";

function makeWiki(): string {
	const tmp = mkdtempSync(join(tmpdir(), "lock-test-"));
	mkdirSync(join(tmp, "entities"), { recursive: true });
	writeFileSync(join(tmp, "index.md"), "# Index v1\n");
	writeFileSync(join(tmp, "entities", "foo.md"), "# Foo v1\n");
	return tmp;
}

describe("lock — acquireWikiLock", () => {
	it("acquires when free", async () => {
		const tmp = makeWiki();
		const lock = await acquireWikiLock(join(tmp, ".lock"), "session-A", { timeoutMs: 1000 });
		assert.ok(lock, "should acquire");
		assert.equal(lock!.meta.sessionId, "session-A");
		assert.ok(existsSync(join(tmp, ".lock")));
		lock!.release();
		assert.equal(existsSync(join(tmp, ".lock")), false);
	});

	it("times out when contended", async () => {
		const tmp = makeWiki();
		const a = await acquireWikiLock(join(tmp, ".lock"), "A", { timeoutMs: 1000 });
		assert.ok(a);
		const b = await acquireWikiLock(join(tmp, ".lock"), "B", { timeoutMs: 300, pollMs: 50 });
		assert.equal(b, undefined, "B should time out while A holds lock");
		a!.release();
	});

	it("acquires after holder releases", async () => {
		const tmp = makeWiki();
		const a = await acquireWikiLock(join(tmp, ".lock"), "A", { timeoutMs: 1000 });
		assert.ok(a);
		a!.release();
		const b = await acquireWikiLock(join(tmp, ".lock"), "B", { timeoutMs: 1000 });
		assert.ok(b, "B should acquire after A released");
		b!.release();
	});

	it("cleans up stale lock from dead PID", async () => {
		const tmp = makeWiki();
		// Plant a "ghost" lock with a pid that does not exist.
		writeFileSync(
			join(tmp, ".lock"),
			JSON.stringify({ pid: 999999, sessionId: "ghost", startedAt: Date.now() }),
		);
		const lock = await acquireWikiLock(join(tmp, ".lock"), "live", { timeoutMs: 2000, pollMs: 100 });
		assert.ok(lock, "should reclaim stale lock");
		assert.equal(lock!.meta.sessionId, "live");
		lock!.release();
	});

	it("cleans up stale lock older than 5 minutes regardless of pid", async () => {
		const tmp = makeWiki();
		writeFileSync(
			join(tmp, ".lock"),
			JSON.stringify({ pid: process.pid, sessionId: "old", startedAt: Date.now() - 6 * 60_000 }),
		);
		const lock = await acquireWikiLock(join(tmp, ".lock"), "fresh", { timeoutMs: 2000, pollMs: 100 });
		assert.ok(lock, "should reclaim aged lock even if pid is alive");
		lock!.release();
	});

	it("release is idempotent and only removes own lock", async () => {
		const tmp = makeWiki();
		const a = await acquireWikiLock(join(tmp, ".lock"), "A", { timeoutMs: 1000 });
		a!.release();
		// Now acquire as B; A's release() should NOT remove B's lock.
		const b = await acquireWikiLock(join(tmp, ".lock"), "B", { timeoutMs: 1000 });
		assert.ok(b);
		a!.release(); // would be a bug if this removed B's lock
		assert.ok(existsSync(join(tmp, ".lock")), "B's lock should still exist after A.release()");
		b!.release();
	});

	it("creates lock dir if missing", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "lock-test-empty-"));
		const lockPath = join(tmp, "deep", "nested", ".lock");
		const lock = await acquireWikiLock(lockPath, "X", { timeoutMs: 1000 });
		assert.ok(lock);
		assert.ok(existsSync(lockPath));
		lock!.release();
	});
});

describe("lock — snapshotWiki / restoreLatestSnapshot", () => {
	it("snapshots wiki contents recursively, excluding .lock and .snapshots", () => {
		const tmp = makeWiki();
		writeFileSync(join(tmp, ".lock"), "ephemeral");
		mkdirSync(join(tmp, ".snapshots"), { recursive: true });
		writeFileSync(join(tmp, ".snapshots", "old.txt"), "old");

		const snap = snapshotWiki(tmp);
		assert.ok(snap);
		assert.ok(existsSync(join(snap!.path, "index.md")));
		assert.ok(existsSync(join(snap!.path, "entities", "foo.md")));
		assert.equal(existsSync(join(snap!.path, ".lock")), false, ".lock should be excluded");
		assert.equal(existsSync(join(snap!.path, ".snapshots")), false, "nested .snapshots should be excluded");
	});

	it("returns undefined when wiki root does not exist", () => {
		assert.equal(snapshotWiki("/nonexistent/wiki/path/zzz"), undefined);
	});

	it("listSnapshots returns newest-first", async () => {
		const tmp = makeWiki();
		const s1 = snapshotWiki(tmp);
		await new Promise((r) => setTimeout(r, 5));
		writeFileSync(join(tmp, "index.md"), "# v2\n");
		const s2 = snapshotWiki(tmp);
		const list = listSnapshots(tmp);
		assert.ok(list.length >= 2);
		assert.equal(list[0].stamp, s2!.stamp, "newest first");
		assert.equal(list[1].stamp, s1!.stamp);
	});

	it("prunes to keep parameter", async () => {
		const tmp = makeWiki();
		// Write 7 snapshots, keep 3.
		for (let i = 0; i < 7; i++) {
			writeFileSync(join(tmp, "index.md"), `# v${i}\n`);
			snapshotWiki(tmp, 3);
			await new Promise((r) => setTimeout(r, 5));
		}
		const list = listSnapshots(tmp);
		assert.equal(list.length, 3, "should keep exactly 3");
	});

	it("restoreLatestSnapshot rolls back to the most recent snapshot", async () => {
		const tmp = makeWiki();
		writeFileSync(join(tmp, "index.md"), "# v1\n");
		writeFileSync(join(tmp, "entities", "foo.md"), "# Foo v1\n");
		const s1 = snapshotWiki(tmp);
		assert.ok(s1);

		await new Promise((r) => setTimeout(r, 5));
		writeFileSync(join(tmp, "index.md"), "# v2\n");
		writeFileSync(join(tmp, "entities", "foo.md"), "# Foo v2\n");
		const s2 = snapshotWiki(tmp);
		assert.ok(s2);

		// Mutate further (this state will be rolled back).
		writeFileSync(join(tmp, "index.md"), "# v3-bogus\n");

		const restored = restoreLatestSnapshot(tmp);
		assert.ok(restored);
		assert.equal(restored!.stamp, s2!.stamp);
		assert.equal(readFileSync(join(tmp, "index.md"), "utf8").trim(), "# v2");
		assert.equal(readFileSync(join(tmp, "entities", "foo.md"), "utf8").trim(), "# Foo v2");
		// The restored snapshot itself should be removed so the next undo goes further back.
		assert.equal(listSnapshots(tmp).length, 1);
	});

	it("restoreLatestSnapshot returns undefined when no snapshots exist", () => {
		const tmp = makeWiki();
		assert.equal(restoreLatestSnapshot(tmp), undefined);
	});

	it("restore deletes top-level files not present in the snapshot", () => {
		const tmp = makeWiki();
		writeFileSync(join(tmp, "index.md"), "# v1\n");
		const snap = snapshotWiki(tmp);
		assert.ok(snap);

		// Add a new file after the snapshot.
		writeFileSync(join(tmp, "spurious.md"), "should be deleted on restore\n");
		assert.ok(existsSync(join(tmp, "spurious.md")));

		restoreLatestSnapshot(tmp);
		assert.equal(existsSync(join(tmp, "spurious.md")), false, "post-snapshot file should be gone");
	});
});
