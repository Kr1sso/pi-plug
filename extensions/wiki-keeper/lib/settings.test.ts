import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadSettings,
	resolveCollectionName,
	resolveWikiPaths,
	DEFAULT_SETTINGS,
} from "./settings.ts";

describe("settings — defaults", () => {
	it("has expected default values", () => {
		assert.equal(DEFAULT_SETTINGS.triggerFillRatio, 0.5);
		assert.equal(DEFAULT_SETTINGS.wikiDir, "wiki");
		assert.equal(DEFAULT_SETTINGS.qmdCollection, "");
		assert.equal(DEFAULT_SETTINGS.autoCompactOnTrigger, true);
		assert.equal(DEFAULT_SETTINGS.lint, true);
		assert.equal(DEFAULT_SETTINGS.autoScaffold, true);
		assert.equal(DEFAULT_SETTINGS.cooldownMs, 60_000);
		assert.equal(DEFAULT_SETTINGS.keepSnapshots, 10);
		assert.equal(DEFAULT_SETTINGS.qmdAutoEmbedOnStart, true);
		assert.equal(DEFAULT_SETTINGS.prefetchMinPages, 5);
		assert.equal(DEFAULT_SETTINGS.logArchiveSuggestEntries, 500);
	});
});

describe("settings — loadSettings", () => {
	it("returns defaults when no settings files exist", () => {
		const tmp = mkdtempSync(join(tmpdir(), "set-empty-"));
		// Override HOME so we don't pull the real ~/.pi/agent/settings.json
		const prevHome = process.env.HOME;
		process.env.HOME = tmp;
		try {
			const s = loadSettings(tmp);
			assert.deepEqual(s, DEFAULT_SETTINGS);
		} finally {
			process.env.HOME = prevHome;
		}
	});

	it("project settings override defaults", () => {
		const tmp = mkdtempSync(join(tmpdir(), "set-proj-"));
		mkdirSync(join(tmp, ".pi"), { recursive: true });
		writeFileSync(
			join(tmp, ".pi", "settings.json"),
			JSON.stringify({ wikiKeeper: { triggerFillRatio: 0.7, lint: false } }),
		);
		const prevHome = process.env.HOME;
		process.env.HOME = mkdtempSync(join(tmpdir(), "set-home-empty-"));
		try {
			const s = loadSettings(tmp);
			assert.equal(s.triggerFillRatio, 0.7);
			assert.equal(s.lint, false);
			assert.equal(s.wikiDir, "wiki", "non-overridden fields stay default");
		} finally {
			process.env.HOME = prevHome;
		}
	});

	it("project settings override global settings", () => {
		const tmp = mkdtempSync(join(tmpdir(), "set-overlay-"));
		const home = mkdtempSync(join(tmpdir(), "set-home-"));
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		writeFileSync(
			join(home, ".pi", "agent", "settings.json"),
			JSON.stringify({ wikiKeeper: { triggerFillRatio: 0.4, lint: true } }),
		);
		mkdirSync(join(tmp, ".pi"), { recursive: true });
		writeFileSync(
			join(tmp, ".pi", "settings.json"),
			JSON.stringify({ wikiKeeper: { triggerFillRatio: 0.8 } }),
		);
		const prevHome = process.env.HOME;
		process.env.HOME = home;
		try {
			const s = loadSettings(tmp);
			assert.equal(s.triggerFillRatio, 0.8, "project wins over global");
			assert.equal(s.lint, true, "global value preserved when project does not override");
		} finally {
			process.env.HOME = prevHome;
		}
	});

	it("ignores malformed JSON without crashing", () => {
		const tmp = mkdtempSync(join(tmpdir(), "set-bad-"));
		mkdirSync(join(tmp, ".pi"), { recursive: true });
		writeFileSync(join(tmp, ".pi", "settings.json"), "{ broken json");
		const prevHome = process.env.HOME;
		process.env.HOME = mkdtempSync(join(tmpdir(), "set-home-"));
		try {
			const s = loadSettings(tmp);
			assert.deepEqual(s, DEFAULT_SETTINGS);
		} finally {
			process.env.HOME = prevHome;
		}
	});
});

describe("settings — resolveCollectionName", () => {
	it("uses explicit setting when provided", () => {
		assert.equal(
			resolveCollectionName({ ...DEFAULT_SETTINGS, qmdCollection: "my-coll" }, "/anything"),
			"my-coll",
		);
	});

	it("trims whitespace from explicit setting", () => {
		assert.equal(
			resolveCollectionName({ ...DEFAULT_SETTINGS, qmdCollection: "  spaced  " }, "/anything"),
			"spaced",
		);
	});

	it("derives a project-unique name when empty", () => {
		const a = resolveCollectionName(DEFAULT_SETTINGS, "/Users/test/projects/foo");
		const b = resolveCollectionName(DEFAULT_SETTINGS, "/Users/test/projects/bar");
		const c = resolveCollectionName(DEFAULT_SETTINGS, "/different/path/foo");
		assert.notEqual(a, b, "different basenames → different names");
		assert.notEqual(a, c, "same basename + different path → different names");
		assert.match(a, /^foo-[0-9a-f]{8}-wiki$/);
		assert.match(b, /^bar-[0-9a-f]{8}-wiki$/);
		assert.match(c, /^foo-[0-9a-f]{8}-wiki$/);
	});

	it("derivation is deterministic per cwd", () => {
		const cwd = "/some/path/project-x";
		const a = resolveCollectionName(DEFAULT_SETTINGS, cwd);
		const b = resolveCollectionName(DEFAULT_SETTINGS, cwd);
		assert.equal(a, b, "stable across calls");
	});

	it("sanitizes basename special characters", () => {
		const name = resolveCollectionName(DEFAULT_SETTINGS, "/x/Some Project Name (v2)!");
		assert.match(name, /^some-project-name-v2-[0-9a-f]{8}-wiki$/);
	});

	it("falls back to 'project' when basename is empty", () => {
		const name = resolveCollectionName(DEFAULT_SETTINGS, "/");
		// On macOS basename("/") is empty string → fallback engages.
		assert.match(name, /^project-[0-9a-f]{8}-wiki$/);
	});

	it("caps basename to 32 chars", () => {
		const longBase = "a".repeat(80);
		const name = resolveCollectionName(DEFAULT_SETTINGS, `/${longBase}`);
		const beforeHash = name.split("-")[0];
		assert.ok(beforeHash.length <= 32, `basename portion was ${beforeHash.length} chars`);
	});
});

describe("settings — resolveWikiPaths", () => {
	it("composes paths under the project + wikiDir", () => {
		const p = resolveWikiPaths("/proj/x", DEFAULT_SETTINGS);
		assert.equal(p.root, "/proj/x/wiki");
		assert.equal(p.raw, "/proj/x/wiki/raw");
		assert.equal(p.entities, "/proj/x/wiki/entities");
		assert.equal(p.concepts, "/proj/x/wiki/concepts");
		assert.equal(p.sources, "/proj/x/wiki/sources");
		assert.equal(p.indexMd, "/proj/x/wiki/index.md");
		assert.equal(p.logMd, "/proj/x/wiki/log.md");
		assert.equal(p.schemaMd, "/proj/x/wiki/schema.md");
		assert.equal(p.lintReportMd, "/proj/x/wiki/lint-report.md");
	});

	it("respects custom wikiDir / rawSubdir", () => {
		const p = resolveWikiPaths("/p", { ...DEFAULT_SETTINGS, wikiDir: "knowledge", rawSubdir: "src" });
		assert.equal(p.root, "/p/knowledge");
		assert.equal(p.raw, "/p/knowledge/src");
	});
});
