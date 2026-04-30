# pi-plug

> A pi extension + skill that maintains a persistent project wiki, automatically rotated before context fill enters the dumb zone.

Inspired by [Karpathy's LLM Wiki idea](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

## What it does

- **Watches context fill.** When it crosses 50% (configurable), the wiki-keeper extension translates the current session into wiki updates instead of letting pi's lossy default compaction take over.
- **Maintains `./wiki/`.** A structured, interlinked markdown knowledge base — entities, concepts, sources, an index, a chronological log. Cross-references with `[[wikilinks]]`, contradictions flagged inline.
- **Indexes with [qmd](https://github.com/tobi/qmd).** Hybrid BM25 + vector search, all on-device. Installed automatically.
- **Forces "wiki first, project second."** Registers a `wiki_query` tool with prompt nudges to make the agent consult the wiki before reading project source.
- **Auto-scaffolds.** First time in a project, it peeks at the top-level structure and asks the model to draft a project-tailored `schema.md`, `index.md`, and overview page.
- **Lints.** Dead links, orphan pages, and `> [!contradiction]` callouts — written to `wiki/lint-report.md` after every cycle.

## Install

```bash
pi install git:github.com/Kr1sso/pi-plug
```

That clones the repo and runs `install.sh`, which installs `qmd` globally (`npm i -g @tobilu/qmd`).

To install only for one project:

```bash
pi install -l git:github.com/Kr1sso/pi-plug
```

## Use

The extension auto-arms on every session. Once context fills past 50%:

```
[wiki-keeper] Context at 52% — triggering wiki rotation (threshold 50%).
[wiki-keeper] wiki: snapshot
[wiki-keeper] wiki: translating
[wiki-keeper] wiki: applying 14 ops
[wiki-keeper] wiki: linting
[wiki-keeper] wiki: reindexing
[wiki-keeper] Wiki updated: 3 created, 11 updated, 0 skipped.
```

Your context is then replaced with a thin "wiki rotated — query first" pointer. You're back near 0% fill, with the heavy state offloaded to the wiki.

### Commands

| Command | What |
|---|---|
| `/wiki:flush` | Translate current session → wiki updates. Don't touch context. |
| `/wiki:rotate` | Translate → start a fresh session seeded from the wiki. |
| `/wiki:query <q>` | Manual qmd query against the wiki. |
| `/wiki:lint` | Run dead-link / orphan / contradiction check. |
| `/wiki:status` | Show context fill, qmd state, settings. |
| `/wiki:model <provider> <id>` | Set translation model (default: current model). |

### Tools registered

- `wiki_query(query, topK?)` — the LLM is nudged to call this before any project file read.

## Settings

`.pi/settings.json` (project) or `~/.pi/agent/settings.json` (global):

```json
{
  "wikiKeeper": {
    "triggerFillRatio": 0.50,
    "wikiDir": "wiki",
    "rawSubdir": "raw",
    "qmdCollection": "project-wiki",
    "autoCompactOnTrigger": true,
    "lint": true,
    "autoScaffold": true,
    "translationModelId": "",
    "translationModelProvider": "",
    "cooldownMs": 60000
  }
}
```

| Key | Default | Notes |
|---|---|---|
| `triggerFillRatio` | `0.50` | Auto-rotate when `tokens / contextWindow >= this`. |
| `wikiDir` | `wiki` | Project-relative. |
| `qmdCollection` | `project-wiki` | qmd collection name. |
| `autoCompactOnTrigger` | `true` | If false, only notify; user runs `/wiki:rotate` manually. |
| `lint` | `true` | Run lint as part of every cycle. |
| `autoScaffold` | `true` | Bootstrap `wiki/` on first run. |
| `translationModelProvider` / `translationModelId` | `""` | Override the translation model. Empty = current `ctx.model`. |
| `cooldownMs` | `60000` | Min delay between auto-rotations. |

## Why these design choices

### Why translate at 50% instead of letting pi's default compaction handle it?

Pi's default compaction kicks in much later (when ~16k tokens are left until the window is full) and **keeps the last ~20k tokens of conversation verbatim**. That defeats the wiki pattern: after a "compaction", we'd start the next turn at ~20–30% fill with stale tail still polluting context. The dumb zone creeps right back. Triggering at 50% gives us:
- Headroom to *do the translation cleanly* (the translation prompt itself uses ~10–20k tokens).
- A real reset, not a half-hearted summary.

### Why `ctx.compact()` for auto-trigger but `ctx.newSession()` for `/wiki:rotate`?

`turn_end` only has access to the base `ExtensionContext`, which exposes `ctx.compact()` but not `ctx.newSession()`. The `session_before_compact` hook lets us hijack the compaction summary and replace it with a thin "wiki rotated, query first" pointer — same effect as a new session, no UX surprise. The manual `/wiki:rotate` command runs in `ExtensionCommandContext` where `newSession` is available, so we use the cleaner true-reset path there.

### Why JSON ops for translation, not free-form markdown?

Diffable, validatable, sandboxable. The translation model returns `[{op:"create", path:..., content:...}, ...]`, and we apply them through one validated function with path-escape protection, lint, and rollback-friendly logging. Letting the model emit raw markdown would mean re-implementing diffing on top.

### Why a separate skill?

The extension can't enforce "query the wiki first" — only the model can. The skill puts that discipline in the system prompt as a SKILL the agent loads on demand, so other harnesses (Claude Code, Codex) using the agent-skills standard can pick it up too. The extension does the mechanics; the skill does the cognition.

## Layout

```
pi-plug/
├── package.json                 # declares both extension and skill as pi resources
├── install.sh                   # qmd global install
├── extensions/
│   └── wiki-keeper/
│       ├── index.ts             # the extension
│       ├── prompts/             # ingest / scaffold / seed prompts
│       └── lib/                 # qmd, wiki-fs, settings, translate, scaffold
└── skills/
    └── wiki/
        ├── SKILL.md
        └── references/{schema,workflows}.md
```

## License

MIT
