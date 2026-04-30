---
name: wiki
description: Project knowledge base discipline. Use when working in a project that has a wiki/ directory maintained by the pi-plug wiki-keeper extension. Tells you to query the wiki BEFORE reading project files, how to structure ingest contributions, and how to lint.
---

# Wiki

This project uses a persistent, LLM-maintained knowledge wiki at `./wiki/`, indexed by `qmd` and rotated automatically by the `wiki-keeper` extension when context fill crosses 50%.

## Discipline (the only thing that matters)

1. **Query the wiki first.** Before any `read` of project source, call the `wiki_query` tool with a natural-language question. Most answers are already there.
2. **Read project files only when the wiki has no relevant hit**, or when you need verbatim source content.
3. **Be explicit about new findings.** Anything you discover this session — file paths, decisions, gotchas, contradictions with prior wiki pages — should be stated clearly in the conversation. The next ingest will fold them into the wiki automatically. Vague reasoning gets lost.
4. **Never edit the wiki by hand.** The wiki-keeper owns it. If you think it needs a fix, run `/wiki:flush` and let the keeper rewrite it.

## When the user asks about the wiki

- `/wiki:status` — show context fill, qmd state, settings.
- `/wiki:query <q>` — manual query.
- `/wiki:flush` — translate the current session into wiki updates (no session reset).
- `/wiki:rotate` — translate, then start a fresh session seeded from the wiki (clean context).
- `/wiki:lint` — run dead-link / orphan / contradiction checks.
- `/wiki:model <provider> <id>` — set a different model for translation (default: current model).

## Schema

See [`references/schema.md`](references/schema.md) for the page format, frontmatter, link conventions, and contradiction callouts.

## Workflows

See [`references/workflows.md`](references/workflows.md) for ingest, query, and lint workflows in detail.
