import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { lintWiki, type LintReport } from "./wiki-fs.ts";
import type { WikiPaths } from "./settings.ts";

/**
 * Build a throwaway wiki tree on disk and return its WikiPaths.
 * `files` is a map of relative path (under wiki root) → file contents.
 * The standard subdirectories (entities/concepts/sources/raw) are pre-created.
 */
function makeWiki(files: Record<string, string>): { tmp: string; paths: WikiPaths } {
	const tmp = mkdtempSync(join(tmpdir(), "wiki-lint-test-"));
	const root = join(tmp, "wiki");
	for (const sub of ["entities", "concepts", "sources", "raw"]) {
		mkdirSync(join(root, sub), { recursive: true });
	}
	for (const [rel, content] of Object.entries(files)) {
		const full = join(root, rel);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content);
	}
	const paths: WikiPaths = {
		root,
		raw: join(root, "raw"),
		entities: join(root, "entities"),
		concepts: join(root, "concepts"),
		sources: join(root, "sources"),
		indexMd: join(root, "index.md"),
		logMd: join(root, "log.md"),
		schemaMd: join(root, "schema.md"),
		lintReportMd: join(root, "lint-report.md"),
	};
	return { tmp, paths };
}

/** Minimal "skeleton" pages required to make the wiki valid (no orphans for these). */
const SKELETON: Record<string, string> = {
	"index.md": "# Index\n",
	"log.md": "# Log\n",
	"schema.md": "# Schema\n",
};

describe("lintWiki — wikilink resolution", () => {
	let tmp: string;
	let report: LintReport;

	before(() => {
		const w = makeWiki({
			...SKELETON,
			"index.md": "# Index\n[[entities/app]]\n[[entities/editor]]\n[[concepts/overview]]\n[[concepts/blue-noise-rng-slots]]\n",
			"entities/app.md": "# App\n",
			"entities/editor.md": "# Editor\n",
			"concepts/overview.md": "# Overview\n",
			"concepts/blue-noise-rng-slots.md": "# Blue Noise\n",
			"test.md": [
				"[[entities/app]]",                     // path style
				"[[/entities/editor]]",                 // root-relative
				"[[./entities/app]]",                   // leading ./
				"[[../entities/app]]",                  // leading ../
				"[[Concepts/Overview]]",                // mixed case
				"[[concepts/blue-noise-rng-slots.md]]", // .md extension included
				"[[Blue Noise Rng Slots]]",             // spaces variant of dashed basename
				"[[App]]",                              // bare basename, unambiguous
				"[[really-missing-page]]",              // genuine dead link
			].join("\n") + "\n",
		});
		tmp = w.tmp;
		report = lintWiki(w.paths);
	});

	after(() => rmSync(tmp, { recursive: true, force: true }));

	it("reports exactly one dead link", () => {
		assert.equal(report.deadLinks.length, 1, JSON.stringify(report.deadLinks));
	});

	it("only flags the genuinely missing target", () => {
		assert.equal(report.deadLinks[0]?.link, "[[really-missing-page]]");
	});

	it("counts every wikilink (including resolved ones)", () => {
		// 4 in index.md + 9 in test.md = 13
		assert.equal(report.totalLinks, 13);
	});
});

describe("lintWiki — non-prose stripping", () => {
	it("ignores wikilinks inside YAML frontmatter, fenced code, and inline code", () => {
		const { tmp, paths } = makeWiki({
			...SKELETON,
			"index.md": "# Index\n[[entities/app]]\n",
			"entities/app.md": "# App\n",
			"schema.md": [
				"---",
				"tags: [meta]",
				"sources: [[[Some Source]]]", // frontmatter — must be ignored
				"---",
				"Use `[[Page Title]]` like so.", // inline code — must be ignored
				"```yaml",
				"sources: [[[Foo]]]",
				"x: [[bar]]",
				"```",                          // fenced — must be ignored
				"~~~",
				"[[also-fenced]]",
				"~~~",
				"Real prose link: [[entities/app]].", // counted
			].join("\n") + "\n",
		});
		try {
			const r = lintWiki(paths);
			assert.equal(r.deadLinks.length, 0, JSON.stringify(r.deadLinks));
			// 1 in index.md + 1 in schema.md prose = 2
			assert.equal(r.totalLinks, 2);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("preserves original line numbers when reporting dead links after stripped regions", () => {
		const { tmp, paths } = makeWiki({
			...SKELETON,
			"index.md": "# Index\n[[entities/test]]\n",
			"entities/test.md": [
				"---",         // 1
				"tags: [x]",   // 2
				"---",         // 3
				"",            // 4
				"```ts",       // 5
				"const x = 1;",// 6
				"```",         // 7
				"[[ghost]]",   // 8 ← expected line
			].join("\n") + "\n",
		});
		try {
			const r = lintWiki(paths);
			assert.equal(r.deadLinks.length, 1);
			assert.equal(r.deadLinks[0]?.line, 8);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("lintWiki — lint-report.md self-feedback", () => {
	it("does not re-flag dead links quoted inside a previous lint-report.md", () => {
		const { tmp, paths } = makeWiki({
			...SKELETON,
			"index.md": "# Index\n[[entities/app]]\n",
			"entities/app.md": "# App\n",
			"lint-report.md": [
				"# Wiki Lint Report",
				"- `wiki/x.md:1` → `[[ghost-page]]`",
				"- `wiki/y.md:2` → `[[also-ghost]]`",
				"- `wiki/z.md:3` → `entities/missing.md`",
			].join("\n") + "\n",
		});
		try {
			const r = lintWiki(paths);
			assert.equal(r.deadLinks.length, 0, JSON.stringify(r.deadLinks));
			assert.ok(!r.orphans.some((o) => o.endsWith("lint-report.md")), "lint-report.md must not be an orphan");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("lintWiki — bare basename ambiguity", () => {
	it("flags ambiguous bare links as dead but resolves disambiguated paths", () => {
		const { tmp, paths } = makeWiki({
			...SKELETON,
			"index.md": "# Index\n[[entities/foo]]\n[[concepts/foo]]\n",
			"entities/foo.md": "# Entities Foo\n",
			"concepts/foo.md": "# Concepts Foo\n",
			"test.md": "[[foo]]\n[[entities/foo]]\n[[concepts/foo]]\n",
		});
		try {
			const r = lintWiki(paths);
			const ambiguousDead = r.deadLinks.find((d) => d.link === "[[foo]]");
			assert.ok(ambiguousDead, `expected [[foo]] to be dead; got ${JSON.stringify(r.deadLinks)}`);
			assert.ok(!r.deadLinks.some((d) => d.link === "[[entities/foo]]"));
			assert.ok(!r.deadLinks.some((d) => d.link === "[[concepts/foo]]"));
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("resolves bare basename when only one match exists", () => {
		const { tmp, paths } = makeWiki({
			...SKELETON,
			"index.md": "# Index\n[[entities/unique]]\n",
			"entities/unique.md": "# Unique\n",
			"test.md": "[[unique]]\n[[Unique]]\n",
		});
		try {
			const r = lintWiki(paths);
			assert.equal(r.deadLinks.length, 0, JSON.stringify(r.deadLinks));
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("lintWiki — orphan detection", () => {
	it("reports unlinked pages as orphans", () => {
		const { tmp, paths } = makeWiki({
			...SKELETON,
			"index.md": "# Index\n[[entities/app]]\n",
			"entities/app.md": "# App\n",
			"entities/lonely.md": "# Lonely\n",
		});
		try {
			const r = lintWiki(paths);
			assert.equal(r.orphans.length, 1);
			assert.ok(r.orphans[0]?.endsWith("lonely.md"));
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("never marks index/log/schema/lint-report as orphans", () => {
		const { tmp, paths } = makeWiki({
			...SKELETON,
			"lint-report.md": "# Lint\n",
		});
		try {
			const r = lintWiki(paths);
			assert.equal(r.orphans.length, 0, JSON.stringify(r.orphans));
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("counts a page linked only via root-relative or path-style wikilinks as non-orphan", () => {
		const { tmp, paths } = makeWiki({
			...SKELETON,
			"index.md": "# Index\n[[/entities/app]]\n[[concepts/overview]]\n",
			"entities/app.md": "# App\n",
			"concepts/overview.md": "# Overview\n",
		});
		try {
			const r = lintWiki(paths);
			assert.equal(r.orphans.length, 0, JSON.stringify(r.orphans));
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("lintWiki — contradiction callouts", () => {
	it("detects > [!contradiction] callouts with correct line numbers", () => {
		const { tmp, paths } = makeWiki({
			...SKELETON,
			"entities/foo.md": "# Foo\n> [!contradiction]\n> A vs B\n",
		});
		try {
			const r = lintWiki(paths);
			assert.equal(r.contradictions.length, 1);
			assert.equal(r.contradictions[0]?.line, 2);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("is case-insensitive on the callout keyword", () => {
		const { tmp, paths } = makeWiki({
			...SKELETON,
			"entities/foo.md": "# Foo\n> [!Contradiction]\n> mixed case\n",
		});
		try {
			const r = lintWiki(paths);
			assert.equal(r.contradictions.length, 1);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("lintWiki — markdown-style links", () => {
	it("flags missing relative .md links and skips http/anchor/mailto", () => {
		const { tmp, paths } = makeWiki({
			...SKELETON,
			"index.md": [
				"# Index",
				"[App](entities/app.md)",
				"[Missing](entities/missing.md)",
				"[Web](https://example.com)",
				"[Anchor](#section)",
				"[Mail](mailto:foo@bar)",
			].join("\n") + "\n",
			"entities/app.md": "# App\n",
		});
		try {
			const r = lintWiki(paths);
			assert.equal(r.deadLinks.length, 1, JSON.stringify(r.deadLinks));
			assert.equal(r.deadLinks[0]?.link, "entities/missing.md");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("lintWiki — minimal wiki", () => {
	it("handles a wiki with only the skeleton without crashing", () => {
		const { tmp, paths } = makeWiki(SKELETON);
		try {
			const r = lintWiki(paths);
			assert.equal(r.totalPages, 3);
			assert.equal(r.totalLinks, 0);
			assert.equal(r.deadLinks.length, 0);
			assert.equal(r.orphans.length, 0);
			assert.equal(r.contradictions.length, 0);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

import { applyOps, replaceSection, archiveLog, countLogEntries, type WikiOp } from "./wiki-fs.ts";
import { existsSync as _exists, readFileSync as _readFile, writeFileSync as _writeFile } from "node:fs";

describe("applyOps", () => {
	it("creates a new file", () => {
		const { tmp, paths } = makeWiki(SKELETON);
		try {
			const r = applyOps(paths, [{ op: "create", path: "entities/foo.md", content: "# Foo\n" }]);
			assert.equal(r.created.length, 1);
			assert.equal(r.skipped.length, 0);
			assert.ok(_exists(join(paths.root, "entities/foo.md")));
		} finally { rmSync(tmp, { recursive: true, force: true }); }
	});

	it("create skips when file already exists", () => {
		const { tmp, paths } = makeWiki({ ...SKELETON, "entities/foo.md": "# old\n" });
		try {
			const r = applyOps(paths, [{ op: "create", path: "entities/foo.md", content: "# new\n" }]);
			assert.equal(r.created.length, 0);
			assert.equal(r.skipped.length, 1);
			assert.match(r.skipped[0].reason, /exists/);
			// File NOT overwritten:
						assert.equal(_readFile(join(paths.root, "entities/foo.md"), "utf8"), "# old\n");
		} finally { rmSync(tmp, { recursive: true, force: true }); }
	});

	it("overwrite replaces existing file", () => {
		const { tmp, paths } = makeWiki({ ...SKELETON, "entities/x.md": "# v1\n" });
		try {
			const r = applyOps(paths, [{ op: "overwrite", path: "entities/x.md", content: "# v2\n" }]);
			assert.equal(r.updated.length, 1);
						assert.equal(_readFile(join(paths.root, "entities/x.md"), "utf8"), "# v2\n");
		} finally { rmSync(tmp, { recursive: true, force: true }); }
	});

	it("overwrite creates the file if missing", () => {
		const { tmp, paths } = makeWiki(SKELETON);
		try {
			const r = applyOps(paths, [{ op: "overwrite", path: "concepts/new.md", content: "# new\n" }]);
			assert.equal(r.created.length, 1);
		} finally { rmSync(tmp, { recursive: true, force: true }); }
	});

	it("append adds content with newline separation", () => {
		const { tmp, paths } = makeWiki({ ...SKELETON, "log.md": "# Log\nline1" });
		try {
			applyOps(paths, [{ op: "append", path: "log.md", content: "line2" }]);
						const t = _readFile(join(paths.root, "log.md"), "utf8");
			assert.match(t, /line1\nline2\n/);
		} finally { rmSync(tmp, { recursive: true, force: true }); }
	});

	it("delete removes existing file", () => {
		const { tmp, paths } = makeWiki({ ...SKELETON, "entities/gone.md": "# gone\n" });
		try {
			const r = applyOps(paths, [{ op: "delete", path: "entities/gone.md" }]);
			assert.equal(r.updated.length, 1);
			assert.equal(_exists(join(paths.root, "entities/gone.md")), false);
		} finally { rmSync(tmp, { recursive: true, force: true }); }
	});

	it("delete skips when file already absent", () => {
		const { tmp, paths } = makeWiki(SKELETON);
		try {
			const r = applyOps(paths, [{ op: "delete", path: "entities/never.md" }]);
			assert.equal(r.skipped.length, 1);
			assert.match(r.skipped[0].reason, /already absent/);
		} finally { rmSync(tmp, { recursive: true, force: true }); }
	});

	it("log appends to log.md", () => {
		const { tmp, paths } = makeWiki(SKELETON);
		try {
			applyOps(paths, [{ op: "log", entry: "## [now] ingest | s | hi" }]);
						assert.match(_readFile(paths.logMd, "utf8"), /## \[now\] ingest \| s \| hi/);
		} finally { rmSync(tmp, { recursive: true, force: true }); }
	});

	it("rejects path escaping wiki root", () => {
		const { tmp, paths } = makeWiki(SKELETON);
		try {
			const r = applyOps(paths, [{ op: "create", path: "../escape.md", content: "x" }]);
			assert.equal(r.skipped.length, 1);
			assert.match(r.skipped[0].reason, /escapes/);
		} finally { rmSync(tmp, { recursive: true, force: true }); }
	});

	it("creates intermediate directories for nested paths", () => {
		const { tmp, paths } = makeWiki(SKELETON);
		try {
			applyOps(paths, [{ op: "create", path: "deep/nested/page.md", content: "# x\n" }]);
			assert.ok(_exists(join(paths.root, "deep/nested/page.md")));
		} finally { rmSync(tmp, { recursive: true, force: true }); }
	});

	it("captures errors in errors[] without crashing", () => {
		const { tmp, paths } = makeWiki(SKELETON);
		try {
			// Try to write to a path that becomes invalid: write a file at "entities" then try to create under it
						_writeFile(join(paths.root, "blocker.md"), "x");
			const r = applyOps(paths, [{ op: "create", path: "blocker.md/child.md", content: "x" }]);
			assert.ok(r.errors.length >= 1, "expected an error for trying to create under a file");
		} finally { rmSync(tmp, { recursive: true, force: true }); }
	});

	it("applies multiple ops in order", () => {
		const { tmp, paths } = makeWiki(SKELETON);
		try {
			const ops: WikiOp[] = [
				{ op: "create", path: "concepts/a.md", content: "# A\n" },
				{ op: "create", path: "concepts/b.md", content: "# B\n" },
				{ op: "log", entry: "## [now] ingest | s | a+b" },
			];
			const r = applyOps(paths, ops);
			assert.equal(r.created.length, 2);
		} finally { rmSync(tmp, { recursive: true, force: true }); }
	});
});

describe("replaceSection", () => {
	it("replaces a section bounded by next sibling heading", () => {
		const orig = "# Doc\n\n## A\nold A\n\n## B\nkeep B\n";
		const out = replaceSection(orig, "## A", "new A");
		assert.match(out, /## A\nnew A/);
		assert.match(out, /## B\nkeep B/);
		assert.ok(!out.includes("old A"));
	});

	it("appends section when heading not found", () => {
		const orig = "# Doc\n\nbody\n";
		const out = replaceSection(orig, "## New", "new content");
		assert.match(out, /## New\nnew content/);
		assert.match(out, /^# Doc/);
	});

	it("handles section that runs to end of file", () => {
		const orig = "# Doc\n\n## Last\noriginal last\n";
		const out = replaceSection(orig, "## Last", "replaced last");
		assert.match(out, /## Last\nreplaced last/);
		assert.ok(!out.includes("original last"));
	});

	it("respects heading depth (## stops at ## or #, not at ###)", () => {
		const orig = "## A\nA body\n\n### A.1\nsub\n\n## B\nB body\n";
		const out = replaceSection(orig, "## A", "new A");
		// ### A.1 is part of A's section (deeper), so it should be replaced too
		assert.ok(!out.includes("### A.1"));
		assert.match(out, /## B\nB body/);
	});

	it("appends as plain text when heading lacks # prefix", () => {
		const orig = "body";
		const out = replaceSection(orig, "Plain Heading", "stuff");
		assert.match(out, /Plain Heading/);
	});
});

describe("countLogEntries", () => {
	it("returns 0 for missing file", () => {
		assert.equal(countLogEntries("/nonexistent/log.md"), 0);
	});

	it("counts ## [...] lines, ignoring header and other ## lines", () => {
		const tmp = mkdtempSync(join(tmpdir(), "cnt-"));
		const log = join(tmp, "log.md");
		writeFileSync(log, "# Wiki Log\n\n## [2026-01-01 12:00] ingest | a\nbody\n\n## Not an entry\n\n## [2026-01-02 12:00] sync | b\n");
		assert.equal(countLogEntries(log), 2);
	});

	it("returns 0 for empty file", () => {
		const tmp = mkdtempSync(join(tmpdir(), "cnt-"));
		const log = join(tmp, "log.md");
		writeFileSync(log, "");
		assert.equal(countLogEntries(log), 0);
	});
});

describe("archiveLog", () => {
	function makeLog(entries: number): string {
		const tmp = mkdtempSync(join(tmpdir(), "arc-"));
		const log = join(tmp, "log.md");
		const blocks: string[] = ["# Wiki Log", ""];
		for (let i = 0; i < entries; i++) {
			const month = (i % 4) + 1;
			blocks.push(`## [2026-0${month}-15 12:00] ingest | s${i} | entry ${i}`);
			blocks.push(`body for ${i}`);
			blocks.push("");
		}
		writeFileSync(log, blocks.join("\n"));
		return log;
	}

	it("does nothing when entries <= keepRecent", () => {
		const log = makeLog(3);
		const r = archiveLog(log, 5);
		assert.equal(r.archivedEntries, 0);
		assert.equal(r.archiveFiles.length, 0);
		assert.equal(r.keptEntries, 3);
	});

	it("archives older entries into per-month files, keeps recent", () => {
		const log = makeLog(12);
		const r = archiveLog(log, 5);
		assert.equal(r.archivedEntries, 7);
		assert.equal(r.keptEntries, 5);
		// 4 distinct months in our generator → 4 archive files
		assert.equal(r.archiveFiles.length, 4);
		// log.md now has only 5 entries
		assert.equal(countLogEntries(log), 5);
		// each archive has at least 1 entry, total = 7
		const total = r.archiveFiles.reduce((s, f) => s + countLogEntries(f), 0);
		assert.equal(total, 7);
	});

	it("preserves the # Log header in the trimmed file", () => {
		const log = makeLog(8);
		archiveLog(log, 3);
				assert.match(_readFile(log, "utf8"), /^# Wiki Log/);
	});

	it("returns zero for missing file", () => {
		const r = archiveLog("/nonexistent/log.md", 5);
		assert.equal(r.archivedEntries, 0);
		assert.equal(r.archiveFiles.length, 0);
	});

	it("appends to existing archive file rather than overwriting", () => {
		const log = makeLog(8);
		const dir = dirname(log);
		const existing = join(dir, "log-archive-2026-01.md");
		writeFileSync(existing, "# Wiki Log Archive (2026-01)\n\n## [2025-01-01 00:00] sync | old | preserved\n");
		archiveLog(log, 3);
		const text = _readFile(existing, "utf8");
		assert.match(text, /preserved/, "pre-existing entry must survive");
		// And the new entries for 2026-01 are appended
		assert.match(text, /## \[2026-01-/);
	});

	it("handles 'undated' entries gracefully", () => {
		const tmp = mkdtempSync(join(tmpdir(), "arc-undated-"));
		const log = join(tmp, "log.md");
		writeFileSync(log, "# Wiki Log\n\n## [garbage stamp] ingest | s | x\nbody\n\n## [2026-04-15 12:00] ingest | s | y\nbody\n\n## [2026-04-16 12:00] ingest | s | z\nbody\n");
		const r = archiveLog(log, 1);
		assert.equal(r.archivedEntries, 2);
		// Should produce one undated archive + one 2026-04
		const names = r.archiveFiles.map((f) => f.split("/").pop()).sort();
		assert.deepEqual(names, ["log-archive-2026-04.md", "log-archive-undated.md"]);
	});
});
