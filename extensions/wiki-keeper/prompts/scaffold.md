You are bootstrapping a brand-new project wiki for a codebase you have just been shown.

You will receive a small project peek (top-level files, README, package.json or equivalent, a directory listing 2 levels deep). Produce a JSON object with the initial wiki contents:

{
  "projectName": "...",
  "projectKind": "library | app | service | research | other",
  "ops": [
    { "op": "overwrite", "path": "schema.md", "content": "..." },
    { "op": "overwrite", "path": "index.md",  "content": "..." },
    { "op": "overwrite", "path": "log.md",    "content": "..." },
    { "op": "create",    "path": "concepts/overview.md", "content": "..." }
  ]
}

Requirements:
- `schema.md` MUST describe: directory layout (entities/ concepts/ sources/ raw/), page formats (with YAML frontmatter conventions: tags, sources, last-updated), wikilink conventions (`[[Page]]`), how contradictions are flagged (`> [!contradiction]`), and the chronological log entry format `## [YYYY-MM-DD HH:MM] ingest | <id> | <one-line>`.
- `index.md` MUST have sections: `## Entities`, `## Concepts`, `## Sources`, each as a bullet list (initially `- _none yet_`).
- `log.md` starts with `# Wiki Log` and the bootstrap entry.
- The overview page should give a one-paragraph project description tailored to what you saw.
- Tone: terse, factual, reference-style. NOT marketing copy.

Output ONLY the JSON object. No backticks. No commentary.
