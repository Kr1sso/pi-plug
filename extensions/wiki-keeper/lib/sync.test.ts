import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, symlinkSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// sync.ts has runtime cross-imports of ./frontmatter.js and ./wiki-fs.js.
// Node's experimental TS strip mode does NOT auto-resolve .js → .ts, so we
// create transient .js symlinks pointing at the .ts files and remove them
// afterwards. .gitignore in this directory excludes them.
const LIB_DIR = dirname(new URL(import.meta.url).pathname);
const NEEDED_LINKS = ["frontmatter", "wiki-fs", "settings"];
const createdLinks: string[] = [];

before(() => {
	for (const stem of NEEDED_LINKS) {
		const linkPath = join(LIB_DIR, `${stem}.js`);
		const target = `${stem}.ts`;
		if (!existsSync(linkPath)) {
			symlinkSync(target, linkPath);
			createdLinks.push(linkPath);
		}
	}
});

after(() => {
	for (const linkPath of createdLinks) {
		try {
			unlinkSync(linkPath);
		} catch {}
	}
});

// Imports must come AFTER `before()` is registered but resolution happens at
// module load time. Pre-create the symlinks here too as a safety net.
for (const stem of NEEDED_LINKS) {
	const linkPath = join(LIB_DIR, `${stem}.js`);
	if (!existsSync(linkPath)) {
		try {
			symlinkSync(`${stem}.ts`, linkPath);
			createdLinks.push(linkPath);
		} catch {}
	}
}

const {
	isGitRepo,
	gitHead,
	gitBranch,
	gitChangedSince,
	readLastSync,
	writeLastSync,
	listSourceTrackingPages,
	detectDrift,
	suggestSyncTargets,
	summarizeDrift,
} = await import("./sync.ts");
const { resolveWikiPaths, DEFAULT_SETTINGS } = await import("./settings.ts");
const { ensureWikiTree } = await import("./wiki-fs.ts");
const { serializeDoc, gitBlobShaOfFile } = await import("./frontmatter.ts");

function newGitProject(): string {
	const tmp = mkdtempSync(join(tmpdir(), "sync-test-"));
	execSync("git init -q -b main && git config user.email t@test && git config user.name test", { cwd: tmp });
	return tmp;
}

function newWiki(cwd: string) {
	const paths = resolveWikiPaths(cwd, DEFAULT_SETTINGS);
	ensureWikiTree(paths);
	writeFileSync(paths.indexMd, "# Index\n");
	writeFileSync(paths.logMd, "# Log\n");
	writeFileSync(paths.schemaMd, "# Schema\n");
	return paths;
}

describe("sync — git helpers", () => {
	it("isGitRepo true inside a repo", () => {
		const tmp = newGitProject();
		assert.equal(isGitRepo(tmp), true);
	});

	it("isGitRepo false outside a repo", () => {
		const tmp = mkdtempSync(join(tmpdir(), "no-git-"));
		assert.equal(isGitRepo(tmp), false);
	});

	it("gitHead returns the SHA after a commit", () => {
		const tmp = newGitProject();
		writeFileSync(join(tmp, "a.txt"), "x");
		execSync("git add -A && git commit -q -m i", { cwd: tmp });
		const head = gitHead(tmp);
		assert.match(head ?? "", /^[0-9a-f]{40}$/);
	});

	it("gitBranch returns the current branch name", () => {
		const tmp = newGitProject();
		writeFileSync(join(tmp, "a.txt"), "x");
		execSync("git add -A && git commit -q -m i", { cwd: tmp });
		assert.equal(gitBranch(tmp), "main");
	});

	it("gitBranch returns undefined for detached HEAD", () => {
		const tmp = newGitProject();
		writeFileSync(join(tmp, "a.txt"), "x");
		execSync("git add -A && git commit -q -m i && git checkout -q --detach HEAD", { cwd: tmp });
		assert.equal(gitBranch(tmp), undefined);
	});
});

describe("sync — gitChangedSince (porcelain regression)", () => {
	it("returns committed-since changes", () => {
		const tmp = newGitProject();
		writeFileSync(join(tmp, "a.txt"), "v1\n");
		execSync("git add -A && git commit -q -m a", { cwd: tmp });
		const head1 = gitHead(tmp)!;
		writeFileSync(join(tmp, "b.txt"), "v1\n");
		execSync("git add -A && git commit -q -m b", { cwd: tmp });
		const changed = gitChangedSince(tmp, head1);
		assert.deepEqual(changed, ["b.txt"]);
	});

	it("returns dirty (uncommitted) modifications without trimming the path", () => {
		// Regression: previously .trim()'d porcelain lines and slice(3) over-trimmed by 1
		// for the leading-space format ' M file', producing 'rc/main.ts' for 'src/main.ts'.
		const tmp = newGitProject();
		mkdirSync(join(tmp, "src"));
		writeFileSync(join(tmp, "src", "main.ts"), "v1\n");
		execSync("git add -A && git commit -q -m i", { cwd: tmp });
		const head = gitHead(tmp)!;
		writeFileSync(join(tmp, "src", "main.ts"), "v2\n");
		const changed = gitChangedSince(tmp, head);
		assert.ok(changed.includes("src/main.ts"), `got ${JSON.stringify(changed)}`);
		assert.ok(!changed.some((p) => p.startsWith("rc/")), "no leading-char-truncated path");
	});

	it("handles staged-only changes", () => {
		const tmp = newGitProject();
		writeFileSync(join(tmp, "a.txt"), "v1\n");
		execSync("git add -A && git commit -q -m i", { cwd: tmp });
		const head = gitHead(tmp)!;
		writeFileSync(join(tmp, "new.txt"), "added\n");
		execSync("git add new.txt", { cwd: tmp });
		const changed = gitChangedSince(tmp, head);
		assert.ok(changed.includes("new.txt"));
	});

	it("excludes wiki dir when filter passed", () => {
		const tmp = newGitProject();
		writeFileSync(join(tmp, "code.ts"), "x\n");
		mkdirSync(join(tmp, "wiki"));
		writeFileSync(join(tmp, "wiki", "page.md"), "x\n");
		execSync("git add -A && git commit -q -m i", { cwd: tmp });
		const head = gitHead(tmp)!;
		writeFileSync(join(tmp, "code.ts"), "y\n");
		writeFileSync(join(tmp, "wiki", "page.md"), "y\n");
		const filtered = gitChangedSince(tmp, head, "wiki");
		assert.deepEqual(filtered, ["code.ts"]);
		const unfiltered = gitChangedSince(tmp, head);
		assert.equal(unfiltered.length, 2);
	});

	it("handles renames via -M", () => {
		const tmp = newGitProject();
		writeFileSync(join(tmp, "a.txt"), "stable content here\n".repeat(10));
		execSync("git add -A && git commit -q -m i", { cwd: tmp });
		const head = gitHead(tmp)!;
		execSync("git mv a.txt b.txt && git commit -q -m rename", { cwd: tmp });
		const changed = gitChangedSince(tmp, head);
		assert.ok(changed.includes("b.txt") || changed.includes("a.txt"));
	});
});

describe("sync — last-sync persistence", () => {
	it("readLastSync returns undefined when missing", () => {
		const tmp = mkdtempSync(join(tmpdir(), "ls-empty-"));
		const paths = resolveWikiPaths(tmp, DEFAULT_SETTINGS);
		ensureWikiTree(paths);
		assert.equal(readLastSync(paths), undefined);
	});

	it("writeLastSync round-trips", () => {
		const tmp = newGitProject();
		writeFileSync(join(tmp, "a.txt"), "x");
		execSync("git add -A && git commit -q -m i", { cwd: tmp });
		const paths = newWiki(tmp);
		const written = writeLastSync(paths, tmp, 7);
		const read = readLastSync(paths);
		assert.deepEqual(read, written);
		assert.match(read!.gitHead!, /^[0-9a-f]{40}$/);
		assert.equal(read!.gitBranch, "main");
		assert.equal(read!.syncedFiles, 7);
	});

	it("writeLastSync handles non-git directories", () => {
		const tmp = mkdtempSync(join(tmpdir(), "ls-nogit-"));
		const paths = newWiki(tmp);
		const written = writeLastSync(paths, tmp);
		assert.equal(written.gitHead, undefined);
		assert.equal(written.gitBranch, undefined);
		assert.ok(written.timestamp > 0);
	});
});

describe("sync — listSourceTrackingPages", () => {
	it("lists only pages with source-file frontmatter", () => {
		const tmp = newGitProject();
		const paths = newWiki(tmp);
		mkdirSync(join(paths.entities), { recursive: true });
		writeFileSync(join(paths.entities, "tracked.md"),
			serializeDoc({ "source-file": "src/x.ts", "source-sha": "abc" }, "# Tracked\n"));
		writeFileSync(join(paths.entities, "untracked.md"), "# Just a page\n");
		writeFileSync(join(paths.concepts, "concept.md"), "# Idea\n");
		const refs = listSourceTrackingPages(paths, tmp);
		assert.equal(refs.length, 1);
		assert.match(refs[0].wikiFile, /tracked\.md$/);
		assert.equal(refs[0].sourceFile, join(tmp, "src/x.ts"));
		assert.equal(refs[0].storedSha, "abc");
	});
});

describe("sync — detectDrift", () => {
	it("git mode: no changes => empty changedFiles", () => {
		const tmp = newGitProject();
		writeFileSync(join(tmp, "a.txt"), "x");
		execSync("git add -A && git commit -q -m i", { cwd: tmp });
		const paths = newWiki(tmp);
		writeLastSync(paths, tmp);
		const d = detectDrift(paths, tmp, DEFAULT_SETTINGS.wikiDir);
		assert.equal(d.mode, "git");
		assert.equal(d.changedFiles.length, 0);
	});

	it("git mode: detects committed + uncommitted changes, filtered", () => {
		const tmp = newGitProject();
		mkdirSync(join(tmp, "src"));
		writeFileSync(join(tmp, "src/a.ts"), "v1\n");
		execSync("git add -A && git commit -q -m i", { cwd: tmp });
		const paths = newWiki(tmp);
		writeLastSync(paths, tmp);
		writeFileSync(join(tmp, "src/a.ts"), "v2\n");
		writeFileSync(join(tmp, "src/b.ts"), "new\n");
		writeFileSync(join(paths.root, "page.md"), "wiki internal change\n");
		const d = detectDrift(paths, tmp, DEFAULT_SETTINGS.wikiDir);
		assert.equal(d.mode, "git");
		assert.ok(d.changedFiles.includes("src/a.ts"));
		assert.ok(d.changedFiles.includes("src/b.ts"));
		assert.ok(!d.changedFiles.some((p) => p.startsWith("wiki/")));
	});

	it("branch-switch mode suppresses cross-branch diff", () => {
		const tmp = newGitProject();
		writeFileSync(join(tmp, "a.txt"), "x");
		execSync("git add -A && git commit -q -m i", { cwd: tmp });
		const paths = newWiki(tmp);
		writeLastSync(paths, tmp);
		execSync("git checkout -q -b feature/x", { cwd: tmp });
		const d = detectDrift(paths, tmp, DEFAULT_SETTINGS.wikiDir);
		assert.equal(d.mode, "branch-switch");
		assert.equal(d.sinceBranch, "main");
		assert.equal(d.currentBranch, "feature/x");
		assert.equal(d.changedFiles.length, 0);
	});

	it("per-page sha mismatch detected even without HEAD change", () => {
		const tmp = newGitProject();
		mkdirSync(join(tmp, "src"));
		writeFileSync(join(tmp, "src/a.ts"), "v1\n");
		const sha1 = gitBlobShaOfFile(join(tmp, "src/a.ts"))!;
		execSync("git add -A && git commit -q -m i", { cwd: tmp });
		const paths = newWiki(tmp);
		writeFileSync(
			join(paths.entities, "a.md"),
			serializeDoc({ "source-file": "src/a.ts", "source-sha": sha1 }, "# A\n"),
		);
		writeLastSync(paths, tmp);
		// Modify source without committing; now stored sha != current sha.
		writeFileSync(join(tmp, "src/a.ts"), "v2\n");
		const d = detectDrift(paths, tmp, DEFAULT_SETTINGS.wikiDir);
		assert.equal(d.staleWikiPages.length, 1);
		assert.equal(d.staleWikiPages[0].reason, "sha-mismatch");
	});

	it("source-missing pages flagged", () => {
		const tmp = newGitProject();
		const paths = newWiki(tmp);
		writeFileSync(
			join(paths.entities, "a.md"),
			serializeDoc({ "source-file": "src/missing.ts", "source-sha": "abc" }, "# A\n"),
		);
		const d = detectDrift(paths, tmp, DEFAULT_SETTINGS.wikiDir);
		assert.equal(d.staleWikiPages.length, 1);
		assert.equal(d.staleWikiPages[0].reason, "source-missing");
	});

	it("mtime mode when no last-sync git head", () => {
		const tmp = mkdtempSync(join(tmpdir(), "drift-mtime-"));
		const paths = newWiki(tmp);
		writeLastSync(paths, tmp); // non-git → stores timestamp only
		const d = detectDrift(paths, tmp, DEFAULT_SETTINGS.wikiDir);
		assert.equal(d.mode, "mtime");
	});

	it("none mode when no last-sync state at all", () => {
		const tmp = mkdtempSync(join(tmpdir(), "drift-none-"));
		const paths = newWiki(tmp);
		const d = detectDrift(paths, tmp, DEFAULT_SETTINGS.wikiDir);
		assert.equal(d.mode, "none");
	});
});

describe("sync — suggestSyncTargets", () => {
	it("unions changedFiles with stale-page sources", () => {
		const tmp = newGitProject();
		const paths = newWiki(tmp);
		const report: any = {
			mode: "git",
			changedFiles: ["src/a.ts"],
			staleWikiPages: [{ wikiFile: "x", sourceFile: join(tmp, "src/b.ts"), reason: "sha-mismatch" }],
			totalWikiPagesWithSource: 1,
		};
		const targets = suggestSyncTargets(report, tmp, DEFAULT_SETTINGS.wikiDir);
		assert.deepEqual(targets, ["src/a.ts", "src/b.ts"]);
	});

	it("filters out wiki-dir entries", () => {
		const tmp = newGitProject();
		const paths = newWiki(tmp);
		const report: any = {
			mode: "git",
			changedFiles: ["wiki/page.md", "src/a.ts"],
			staleWikiPages: [],
			totalWikiPagesWithSource: 0,
		};
		const targets = suggestSyncTargets(report, tmp, DEFAULT_SETTINGS.wikiDir);
		assert.deepEqual(targets, ["src/a.ts"]);
	});

	it("dedupes when same file appears in both signals", () => {
		const tmp = newGitProject();
		const paths = newWiki(tmp);
		const report: any = {
			mode: "git",
			changedFiles: ["src/a.ts"],
			staleWikiPages: [{ wikiFile: "x", sourceFile: join(tmp, "src/a.ts"), reason: "sha-mismatch" }],
			totalWikiPagesWithSource: 1,
		};
		const targets = suggestSyncTargets(report, tmp, DEFAULT_SETTINGS.wikiDir);
		assert.deepEqual(targets, ["src/a.ts"]);
	});
});

describe("sync — summarizeDrift", () => {
	it("includes branch-switch line when in that mode", () => {
		const tmp = newGitProject();
		const paths = newWiki(tmp);
		const report: any = {
			mode: "branch-switch",
			sinceBranch: "main",
			currentBranch: "feature/x",
			currentHead: "abc12345xxxxxx",
			sinceHead: "def67890xxxxxx",
			changedFiles: [],
			staleWikiPages: [],
			totalWikiPagesWithSource: 0,
		};
		const out = summarizeDrift(report, tmp, paths);
		assert.match(out, /branch:.*main.*feature\/x/);
		assert.match(out, /cross-branch diff suppressed/);
	});

	it("renders changed files list (capped) and stale pages", () => {
		const tmp = newGitProject();
		const paths = newWiki(tmp);
		const report: any = {
			mode: "git",
			currentBranch: "main",
			currentHead: "a".repeat(40),
			sinceHead: "b".repeat(40),
			changedFiles: ["src/a.ts", "src/b.ts"],
			staleWikiPages: [{ wikiFile: join(paths.root, "x.md"), sourceFile: join(tmp, "src/a.ts"), reason: "sha-mismatch" }],
			totalWikiPagesWithSource: 1,
		};
		const out = summarizeDrift(report, tmp, paths);
		assert.match(out, /branch:\s+main/);
		assert.match(out, /changed since sync:\s+2 file/);
		assert.match(out, /src\/a\.ts/);
		assert.match(out, /tracked wiki pages:\s+1/);
		assert.match(out, /stale wiki pages:\s+1/);
	});
});
