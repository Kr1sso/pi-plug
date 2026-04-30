# Wiki schema reference

The wiki lives at `./wiki/` (configurable). Layout:

```
wiki/
├── index.md          # catalog of all pages
├── log.md            # chronological log
├── schema.md         # project-tailored variant of this file (auto-generated)
├── lint-report.md    # latest lint output
├── entities/         # concrete things (files, modules, services, people)
├── concepts/         # ideas, patterns, decisions, hypotheses
├── sources/          # ingested documents (sessions, articles, PDFs)
└── raw/              # immutable source files
```

## Page format

Optional YAML frontmatter:

```yaml
---
tags: [tag1, tag2]
sources: ["sources/2026-04-30-session.md"]
last-updated: 2026-04-30
---
```

Body: terse, factual markdown. Use `[[PageName]]` for wiki cross-refs, `[text](relative.md)` for source links.

## Contradictions

```
> [!contradiction]
> Old: <prior claim>
> New: <new claim>
> Source: <where the new claim came from>
```

Superseded claims: `~~old text~~ — see [[NewPage]]`.

## Log entry format

```
## [YYYY-MM-DD HH:MM] <kind> | <session-or-task-id> | <one-line>
```

Kinds: `ingest`, `scaffold`, `lint`, `manual-flush`, `manual-rotate`, `auto`.

The log is parseable:

```bash
grep "^## \[" wiki/log.md | tail -10
```

## Naming

- Files: `lowercase-kebab-case.md`.
- Categorize by directory (`entities/`, `concepts/`, `sources/`).
- One page per thing. Splits and merges happen on rotation, not by hand.
