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
