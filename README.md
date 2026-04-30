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
| `/wiki:sync [paths...]` | Sync the wiki with on-disk changes (git diff since last sync, or explicit paths). |
| `/wiki:undo` | Restore the wiki from the most recent pre-cycle snapshot. |
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

## Visible activity indicator

While any wiki action runs you'll see a 3-line widget above the editor:

```
● wiki rotation in progress — do not /exit
  phase: calling translation model
  elapsed: 8s
```

Plus a footer entry mirroring the same. Both clear automatically on completion. Shown for: scaffold, rotation, flush, sync, undo. Phases tick through `acquiring lock → snapshot → extracting keyphrases → fetching related pages → calling translation model → applying N ops → linting → qmd reindex`.

## Committing the wiki to git

The wiki is just markdown — commit it. The keeper auto-writes `wiki/.gitignore` so transient state stays out:

```
.lock
.snapshots/
lint-report.md
```

What you DO commit: `index.md`, `log.md`, `schema.md`, `entities/`, `concepts/`, `sources/`, `raw/`, and `.last-sync.json`.

Why commit `.last-sync.json`: it stores the git HEAD the wiki was last synced against. When a teammate pulls and runs pi, the keeper compares their HEAD to the recorded one and notifies them on `session_start` if files have drifted ("Wiki may be stale: 17 file(s) changed since last sync. Run `/wiki:sync`."). Without it, every teammate would see drift against their first-ever session.

## SHA-precise drift tracking

Every wiki page about a specific source file carries frontmatter:

```yaml
---
source-file: src/payment.ts
source-sha: a3f9c1b…         # git blob sha, auto-stamped
source-mtime: 1738209200      # auto-stamped
last-synced: 2026-04-30       # auto-stamped
---
```

The keeper auto-stamps `source-sha`/`source-mtime`/`last-synced` after every cycle by walking all source-tracked pages and recomputing `git hash-object` on the referenced file. Drift detection unions three signals:

1. **Git diff**: `git diff --name-only -M <last_head>..HEAD` + `git status --porcelain`.
2. **Per-page SHA mismatch**: walk every page with `source-file`, compare stored `source-sha` to current. Works even outside git.
3. **Source-missing**: file referenced in frontmatter no longer exists on disk → page flagged `source-status: missing`, surfaced in lint.

## What `/wiki:sync` does

Different from `/wiki:flush` (which translates *conversation*). `/wiki:sync` translates *files*:

1. Acquire wiki lock + snapshot.
2. Detect drift → list of changed source paths.
3. Read current file contents (truncated at ~8KB each).
4. qmd-fetch wiki pages that mention those paths.
5. One LLM call: "here are the pre-existing wiki claims, here is the files' current state — produce JSON ops." Translation marks updates with `> [!updated]`, renames with `> [!renamed]`, removals with `> [!removed]`.
6. Apply ops; restamp every touched page's source-sha; lint; qmd reindex; update `.last-sync.json`.

Capped at 30 targets per run. Use explicit paths to override.

## Multi-session safety (5 agents on one codebase)

Multiple pi sessions can run against the same project simultaneously. Handled with:

- **Cross-process lock** (`wiki/.lock`): only one session writes the wiki at a time. Others wait up to 45s, then skip (retry on next trigger). Stale locks (dead PID or >5 min old) are auto-cleaned.
- **Pre-cycle snapshots** (`wiki/.snapshots/<ts>/`): the wiki is snapshotted before every write. Last 5 kept. `/wiki:undo` restores from the latest.
- **Session-id tagged log entries**: every `log.md` line includes the session id, so concurrent activity is traceable with `grep`.
- **Reads stay free**: `wiki_query` and `/wiki:query` never take the lock; only the cycle does.

Not protected: two sessions whose translations both touch the same page concurrently. The lock serializes them, but if B started its translation before A finished, B is operating on a stale view and may emit conflicting ops. Lint surfaces these as `> [!contradiction]` callouts. True multi-tenant correctness requires per-session ingest journals — not in v0.x.

## Wiki-first discipline

Once the wiki has at least one ingest entry, the extension appends a one-shot addendum to the system prompt of every new session:

> This project has a knowledge wiki at `./wiki/`. Before reading any project source file, call the `wiki_query` tool. Only fall back to direct `read` when the wiki has no relevant hit.

This is in addition to the `wiki_query` tool's own description — two reinforcement layers because models tend to ignore single-source nudges.

## First-run smoke test

```bash
pi install git:github.com/Kr1sso/pi-plug          # global; or -l for project-local
pi                                                # quit
pi                                                # start again — wiki-keeper now in [Extensions]
# inside pi:
/wiki:status                                      # confirm setup, qmd, fill ratio
/wiki:flush                                       # force a cycle, watch wiki/ populate
ls wiki/                                          # index.md, log.md, schema.md, entities/, ...
```

If nothing appears in `[Extensions]` after restart, run `pi -e ./.pi/git/github.com/Kr1sso/pi-plug/extensions/wiki-keeper/index.ts` to surface load errors.

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
