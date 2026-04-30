---
tags: [meta]
last-updated: 2025-01-01
---

# Wiki Schema

Conventions for this wiki. Terse. Reference-style.

## Directory layout

```
wiki/
  schema.md         # this file
  index.md          # entry point: Entities / Concepts / Sources
  log.md            # chronological activity log
  entities/         # concrete things: modules, files, commands, tools, settings keys
  concepts/         # ideas, mechanisms, flows, design notes
  sources/          # external references (URLs, papers, gists)
  raw/              # raw extracted snippets, transcripts, dumps
```

## Page formats

Every page begins with YAML frontmatter.

### Generic page

```yaml
---
tags: [tag1, tag2]
sources: [[[Some Source]]]
last-updated: YYYY-MM-DD
---
```

### File-tracking page (under `entities/` mirroring a source file)

```yaml
---
tags: [code]
source-file: src/path/to/file.ts
source-sha: <git-sha-or-hash>
source-mtime: <iso-timestamp>
last-synced: YYYY-MM-DD
last-updated: YYYY-MM-DD
---
```

## Wikilinks

Cross-reference pages with `[[Page Title]]` or `[[path/to/page|Alias]]`. Prefer linking over restating.

## Callouts

- Contradiction between sources or between wiki and reality:

  ```
  > [!contradiction]
  > Page X says A; sync on YYYY-MM-DD shows B.
  ```

- File changed since last sync:

  ```
  > [!updated]
  > source-file changed since last-synced. Re-read.
  ```

- File renamed:

  ```
  > [!renamed]
  > old/path.ts -> new/path.ts
  ```

- File removed:

  ```
  > [!removed]
  > source-file no longer exists at recorded path.
  ```

## Log entries

`log.md` is append-only. Each entry:

```
## [YYYY-MM-DD HH:MM] <kind> | <session-id> | <one-line summary>
```

Kinds: `ingest`, `scaffold`, `sync`, `lint`, `manual-flush`, `manual-rotate`, `auto`.
