import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	parseDoc,
	serializeDoc,
	gitBlobSha,
	gitBlobShaOfFile,
	fileMtime,
	restampPage,
} from "./frontmatter.ts";

describe("frontmatter — parseDoc", () => {
	it("returns empty frontmatter when no fence", () => {
		const r = parseDoc("# Just a body\n\nhello");
		assert.equal(r.hadFrontmatter, false);
		assert.deepEqual(r.frontmatter, {});
		assert.equal(r.body, "# Just a body\n\nhello");
	});

	it("parses simple key/value strings", () => {
		const r = parseDoc(`---\nfoo: bar\nbaz: hello world\n---\nbody\n`);
		assert.equal(r.hadFrontmatter, true);
		assert.equal(r.frontmatter.foo, "bar");
		assert.equal(r.frontmatter.baz, "hello world");
	});

	it("parses numbers, booleans, nulls", () => {
		const r = parseDoc(`---\nn: 42\nf: 3.14\nneg: -7\nb1: true\nb2: false\nnu: null\nemp: \n---\n`);
		assert.equal(r.frontmatter.n, 42);
		assert.equal(r.frontmatter.f, 3.14);
		assert.equal(r.frontmatter.neg, -7);
		assert.equal(r.frontmatter.b1, true);
		assert.equal(r.frontmatter.b2, false);
		assert.equal(r.frontmatter.nu, null);
		assert.equal(r.frontmatter.emp, null);
	});

	it("parses inline arrays", () => {
		const r = parseDoc(`---\ntags: [a, b, "c d", 'e']\nempty: []\n---\n`);
		assert.deepEqual(r.frontmatter.tags, ["a", "b", "c d", "e"]);
		assert.deepEqual(r.frontmatter.empty, []);
	});

	it("strips surrounding quotes", () => {
		const r = parseDoc(`---\nq1: "hello"\nq2: 'world'\n---\n`);
		assert.equal(r.frontmatter.q1, "hello");
		assert.equal(r.frontmatter.q2, "world");
	});

	it("ignores blank lines and comments inside fence", () => {
		const r = parseDoc(`---\n\n# this is a comment\nfoo: bar\n\n---\n`);
		assert.deepEqual(Object.keys(r.frontmatter), ["foo"]);
	});

	it("preserves body verbatim", () => {
		const body = "# Title\n\nSome text\n\n## Heading\n\nMore.";
		const r = parseDoc(`---\nfoo: bar\n---\n${body}`);
		assert.equal(r.body, body);
	});

	it("handles CRLF line endings in fence", () => {
		const r = parseDoc(`---\r\nfoo: bar\r\n---\r\nbody\r\n`);
		assert.equal(r.frontmatter.foo, "bar");
	});

	it("ignores lines without colons", () => {
		const r = parseDoc(`---\nfoo: bar\nnotakey\n---\n`);
		assert.deepEqual(Object.keys(r.frontmatter), ["foo"]);
	});
});

describe("frontmatter — serializeDoc", () => {
	it("returns body unchanged when frontmatter empty", () => {
		assert.equal(serializeDoc({}, "hello"), "hello");
	});

	it("serializes strings, numbers, booleans, nulls", () => {
		const out = serializeDoc({ s: "x", n: 1, b: true, nu: null }, "body\n");
		assert.match(out, /^---\n/);
		assert.match(out, /\ns: x\n/);
		assert.match(out, /\nn: 1\n/);
		assert.match(out, /\nb: true\n/);
		assert.match(out, /\nnu: null\n/);
		assert.match(out, /---\nbody\n$/);
	});

	it("serializes arrays inline", () => {
		const out = serializeDoc({ tags: ["a", "b"] }, "");
		assert.match(out, /\ntags: \[a, b\]\n/);
	});

	it("quotes strings with special characters", () => {
		const out = serializeDoc({ k: "has: colon" }, "");
		assert.match(out, /\nk: "has: colon"\n/);
	});

	it("escapes embedded double-quotes", () => {
		const out = serializeDoc({ k: 'he said "hi"' }, "");
		assert.match(out, /\nk: "he said \\"hi\\""/);
	});
});

describe("frontmatter — round-trip", () => {
	it("parse → serialize → parse preserves all values", () => {
		const original = `---\nsource-file: src/x.ts\nsource-sha: abc123\ntags: [a, b]\nlast-synced: 2026-04-30\n---\n# Doc\n\nbody\n`;
		const p1 = parseDoc(original);
		const ser = serializeDoc(p1.frontmatter, p1.body);
		const p2 = parseDoc(ser);
		assert.deepEqual(p2.frontmatter, p1.frontmatter);
		assert.equal(p2.body, p1.body);
	});
});

describe("frontmatter — gitBlobSha", () => {
	it("matches `git hash-object` byte-for-byte for arbitrary content", () => {
		const tmp = mkdtempSync(join(tmpdir(), "fm-sha-"));
		execSync("git init -q -b main", { cwd: tmp });
		const samples = [
			"hello\n",
			"",
			"line1\nline2\nline3\n",
			"unicode: αβγ ✓\n",
			Buffer.from([0, 1, 2, 3, 255, 254]).toString("binary"),
		];
		for (const content of samples) {
			writeFileSync(join(tmp, "f"), content);
			const ours = gitBlobSha(content);
			const theirs = execSync("git hash-object f", { cwd: tmp, encoding: "utf8" }).trim();
			assert.equal(ours, theirs, `sha mismatch for content: ${JSON.stringify(content.slice(0, 30))}`);
		}
	});

	it("accepts Buffer input", () => {
		const buf = Buffer.from("hello\n");
		const tmp = mkdtempSync(join(tmpdir(), "fm-sha-"));
		execSync("git init -q -b main", { cwd: tmp });
		writeFileSync(join(tmp, "f"), buf);
		const ours = gitBlobSha(buf);
		const theirs = execSync("git hash-object f", { cwd: tmp, encoding: "utf8" }).trim();
		assert.equal(ours, theirs);
	});
});

describe("frontmatter — gitBlobShaOfFile / fileMtime", () => {
	it("returns undefined for missing file", () => {
		assert.equal(gitBlobShaOfFile("/nonexistent/path/file.txt"), undefined);
		assert.equal(fileMtime("/nonexistent/path/file.txt"), undefined);
	});

	it("returns matching sha for existing file", () => {
		const tmp = mkdtempSync(join(tmpdir(), "fm-file-"));
		const f = join(tmp, "x.txt");
		writeFileSync(f, "hello\n");
		execSync("git init -q -b main", { cwd: tmp });
		const ours = gitBlobShaOfFile(f);
		const theirs = execSync("git hash-object x.txt", { cwd: tmp, encoding: "utf8" }).trim();
		assert.equal(ours, theirs);
		assert.ok((fileMtime(f) ?? 0) > 0);
	});
});

describe("frontmatter — restampPage", () => {
	it("returns input unchanged when source file missing", () => {
		const text = `---\nsource-file: missing.ts\n---\nbody\n`;
		const out = restampPage(text, "/nonexistent/missing.ts");
		assert.equal(out, text);
	});

	it("stamps source-sha + source-mtime + last-synced when source exists", () => {
		const tmp = mkdtempSync(join(tmpdir(), "fm-rs-"));
		const src = join(tmp, "x.ts");
		writeFileSync(src, "// source\n");
		const text = `---\nsource-file: x.ts\nold: keep\n---\n# Body\n`;
		const out = restampPage(text, src);
		const parsed = parseDoc(out);
		assert.equal(parsed.frontmatter.old, "keep");
		assert.ok(typeof parsed.frontmatter["source-sha"] === "string" && (parsed.frontmatter["source-sha"] as string).length === 40);
		assert.ok(typeof parsed.frontmatter["source-mtime"] === "number");
		assert.match(parsed.frontmatter["last-synced"] as string, /^\d{4}-\d{2}-\d{2}$/);
		assert.equal(parsed.body, "# Body\n");
	});
});
