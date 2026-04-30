---
tags: [overview]
last-updated: 2025-01-01
---

# Project Overview

`pi-plug` is a [pi](https://) extension + skill bundle that maintains a persistent, on-disk project wiki under `./wiki/`. The `wiki-keeper` extension watches session context fill and, at a configurable threshold (default 50%), translates the live session into structured wiki updates (entities, concepts, sources, index, log) instead of relying on lossy default compaction. Content is indexed with [qmd](https://github.com/tobi/qmd) for hybrid BM25 + vector retrieval, exposed to the agent via a `wiki_query` tool with prompt nudges enforcing a "wiki first, project second" workflow. Ships with slash commands (`/wiki:flush`, `/wiki:rotate`, `/wiki:sync`, `/wiki:undo`, `/wiki:query`, `/wiki:lint`, `/wiki:fix`, `/wiki:status`, `/wiki:model`), auto-scaffolding on first run, and a lint pass for dead links, orphans, and contradictions.
