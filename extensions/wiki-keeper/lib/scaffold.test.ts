import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { peekProject, renderPeek } from "./scaffold.ts";

describe("scaffold — peekProject", () => {
	it("returns empty manifestFiles + tree for empty dir", () => {
		const tmp = mkdtempSync(join(tmpdir(), "peek-empty-"));
		const peek = peekProject(tmp);
		assert.equal(peek.manifestFiles.length, 0);
		assert.deepEqual(peek.tree, []);
	});

	it("picks up README.md when present", () => {
		const tmp = mkdtempSync(join(tmpdir(), "peek-readme-"));
		writeFileSync(join(tmp, "README.md"), "# My Project\n");
		const peek = peekProject(tmp);
		const readme = peek.manifestFiles.find((m) => m.name === "README.md");
		assert.ok(readme);
		assert.match(readme!.content, /# My Project/);
	});

	it("picks up multiple manifest types", () => {
		const tmp = mkdtempSync(join(tmpdir(), "peek-multi-"));
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "x" }));
		writeFileSync(join(tmp, "Cargo.toml"), '[package]\nname = "x"\n');
		writeFileSync(join(tmp, "AGENTS.md"), "agent rules\n");
		const peek = peekProject(tmp);
		const names = peek.manifestFiles.map((m) => m.name).sort();
		assert.deepEqual(names, ["AGENTS.md", "Cargo.toml", "package.json"]);
	});

	it("truncates large manifests", () => {
		const tmp = mkdtempSync(join(tmpdir(), "peek-trunc-"));
		const big = "x".repeat(8000);
		writeFileSync(join(tmp, "README.md"), big);
		const peek = peekProject(tmp);
		const m = peek.manifestFiles.find((f) => f.name === "README.md")!;
		assert.ok(m.content.length < 5000, `expected truncation, got ${m.content.length} chars`);
		assert.match(m.content, /truncated/);
	});

	it("walks tree to depth 2 with directory markers", () => {
		const tmp = mkdtempSync(join(tmpdir(), "peek-tree-"));
		mkdirSync(join(tmp, "src", "nested"), { recursive: true });
		writeFileSync(join(tmp, "src", "main.ts"), "");
		writeFileSync(join(tmp, "src", "nested", "deep.ts"), "");
		writeFileSync(join(tmp, "top.ts"), "");
		const peek = peekProject(tmp);
		assert.ok(peek.tree.includes("src/"), "src dir should be listed");
		assert.ok(peek.tree.some((e) => e.includes("main.ts")), "src contents listed");
		assert.ok(peek.tree.includes("top.ts"));
	});

	it("skips well-known noise dirs", () => {
		const tmp = mkdtempSync(join(tmpdir(), "peek-skip-"));
		mkdirSync(join(tmp, "node_modules"), { recursive: true });
		writeFileSync(join(tmp, "node_modules", "junk"), "");
		mkdirSync(join(tmp, "wiki"), { recursive: true });
		writeFileSync(join(tmp, "wiki", "index.md"), "");
		mkdirSync(join(tmp, "src"), { recursive: true });
		writeFileSync(join(tmp, "src", "main.ts"), "");
		const peek = peekProject(tmp);
		assert.ok(!peek.tree.some((e) => e.includes("node_modules")), "node_modules skipped");
		assert.ok(!peek.tree.some((e) => e.startsWith("wiki/")), "wiki dir skipped");
		assert.ok(peek.tree.some((e) => e.startsWith("src")), "src not skipped");
	});

	it("skips dotfiles except .github", () => {
		const tmp = mkdtempSync(join(tmpdir(), "peek-dot-"));
		mkdirSync(join(tmp, ".env"), { recursive: true });
		mkdirSync(join(tmp, ".github"), { recursive: true });
		writeFileSync(join(tmp, ".github", "workflows.yml"), "");
		const peek = peekProject(tmp);
		assert.ok(!peek.tree.some((e) => e.includes(".env")));
		assert.ok(peek.tree.some((e) => e.includes(".github")));
	});

	it("caps tree at maxEntries", () => {
		const tmp = mkdtempSync(join(tmpdir(), "peek-cap-"));
		for (let i = 0; i < 60; i++) writeFileSync(join(tmp, `f${i}.txt`), "");
		const peek = peekProject(tmp);
		assert.ok(peek.tree.length <= 40, `expected ≤40 entries, got ${peek.tree.length}`);
	});
});

describe("scaffold — renderPeek", () => {
	it("emits cwd, structure block, and one section per manifest", () => {
		const peek = {
			cwd: "/p/x",
			tree: ["src/", "  main.ts"],
			manifestFiles: [
				{ name: "README.md", content: "# Hello\n" },
				{ name: "package.json", content: '{"name":"x"}' },
			],
		};
		const out = renderPeek(peek);
		assert.match(out, /Working directory: `\/p\/x`/);
		assert.match(out, /## Top-level structure/);
		assert.match(out, /src\//);
		assert.match(out, /## README\.md/);
		assert.match(out, /# Hello/);
		assert.match(out, /## package\.json/);
		assert.match(out, /\{"name":"x"\}/);
	});

	it("emits a fallback note when there are no manifest files", () => {
		const out = renderPeek({ cwd: "/p", tree: [], manifestFiles: [] });
		assert.match(out, /no manifest files found/);
	});
});
