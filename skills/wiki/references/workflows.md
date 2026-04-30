# Wiki workflows

## Query

Always query the wiki before reading project files.

```
wiki_query({ query: "how does the auth middleware decide on token rotation?", topK: 5 })
```

You'll get back hits with file paths and snippets. Pick the most relevant and `read` them in full. Only fall back to `read` on project source code when:
- the wiki returned no hits, or
- the wiki hits are too high-level and you need verbatim implementation.

## Ingest (automatic)

You don't ingest manually. The extension watches context fill. When it crosses ~50%:
1. The current session transcript is serialized.
2. Pre-fetched related wiki pages are pulled via qmd.
3. The translation model produces a JSON list of file ops (create / overwrite / append / replace_section / log).
4. Ops are applied atomically. The log is updated. The index is updated.
5. Lint runs (dead links, orphans, contradictions). `wiki/lint-report.md` is rewritten.
6. qmd reindexes.
7. For auto-trigger: pi's compaction swaps your context for a thin "wiki rotated, query first" pointer.
   For `/wiki:rotate`: a new pi session starts seeded with the same pointer.

## Lint (manual)

```
/wiki:lint
```

Writes `wiki/lint-report.md`. Three categories:
- **Dead links** — `[[Page]]` or `[text](file.md)` that doesn't resolve. These are hard errors. Run `/wiki:flush` to let the keeper repair them, or fix the links in your conversation and trigger another flush.
- **Orphan pages** — pages with zero inbound links from other wiki pages (excluding `index.md`, `log.md`, `schema.md`, `lint-report.md`). Either link them in or delete them.
- **Contradictions** — tally of `> [!contradiction]` callouts. These are intentional and informational; no action needed unless you want to resolve them.

## Manual flush vs rotate

- `/wiki:flush` — translates and updates the wiki, but does NOT touch your context. Use mid-session when you have a clear milestone but want to keep working without a context reset.
- `/wiki:rotate` — full cycle + clean session, seeded from the wiki. Use when you're done with a chunk of work and want a fresh start.

## When the wiki is empty

The first time you work in a project, the wiki-keeper auto-scaffolds:
1. Reads top-level files (README, package.json, etc.) and a 2-deep tree.
2. Asks the translation model to produce `schema.md`, `index.md`, `log.md`, and an overview page tailored to what it saw.
3. qmd indexes the result.

If scaffolding fails (no model / no API key), the keeper falls back to default templates and you can `/wiki:flush` later to enrich them.
