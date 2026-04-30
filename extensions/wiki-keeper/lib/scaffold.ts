import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const PEEK_FILES = [
	"README.md",
	"readme.md",
	"package.json",
	"pyproject.toml",
	"Cargo.toml",
	"go.mod",
	"build.gradle",
	"build.gradle.kts",
	"pom.xml",
	"composer.json",
	"Gemfile",
	"AGENTS.md",
	"CLAUDE.md",
];

const SKIP_DIRS = new Set([
	"node_modules", ".git", "dist", "build", "target", ".next", ".cache",
	"venv", ".venv", "__pycache__", ".pi", "wiki", "out", "coverage",
]);

function readSnippet(path: string, maxBytes = 4000): string {
	try {
		const buf = readFileSync(path);
		const text = buf.toString("utf8");
		return text.length > maxBytes ? text.slice(0, maxBytes) + `\n…(truncated, file is ${text.length} bytes)` : text;
	} catch {
		return "";
	}
}

function listDir(path: string, depth: number, maxEntries = 40): string[] {
	const out: string[] = [];
	const walk = (dir: string, prefix: string, d: number) => {
		if (d > depth || out.length >= maxEntries) return;
		let names: string[];
		try {
			names = readdirSync(dir).sort();
		} catch {
			return;
		}
		for (const name of names) {
			if (out.length >= maxEntries) break;
			if (name.startsWith(".") && name !== ".github") continue;
			if (SKIP_DIRS.has(name)) continue;
			const full = join(dir, name);
			let st;
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				out.push(`${prefix}${name}/`);
				walk(full, prefix + "  ", d + 1);
			} else {
				out.push(`${prefix}${name}`);
			}
		}
	};
	walk(path, "", 0);
	return out;
}

export interface ProjectPeek {
	cwd: string;
	manifestFiles: { name: string; content: string }[];
	tree: string[];
}

export function peekProject(cwd: string): ProjectPeek {
	const manifestFiles: { name: string; content: string }[] = [];
	for (const name of PEEK_FILES) {
		const p = join(cwd, name);
		if (existsSync(p)) {
			manifestFiles.push({ name, content: readSnippet(p) });
		}
	}
	return { cwd, manifestFiles, tree: listDir(cwd, 2) };
}

export function renderPeek(peek: ProjectPeek): string {
	const parts: string[] = [];
	parts.push(`# Project peek\n\nWorking directory: \`${peek.cwd}\`\n`);
	parts.push(`## Top-level structure (depth 2)\n\n\`\`\`\n${peek.tree.join("\n")}\n\`\`\`\n`);
	for (const m of peek.manifestFiles) {
		parts.push(`## ${m.name}\n\n\`\`\`\n${m.content}\n\`\`\`\n`);
	}
	if (peek.manifestFiles.length === 0) {
		parts.push("(no manifest files found — treat as a generic codebase or notes folder.)");
	}
	return parts.join("\n");
}
