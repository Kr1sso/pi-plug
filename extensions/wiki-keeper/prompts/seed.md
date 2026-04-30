## Continuing work — wiki-backed session

A wiki rotation just happened. Your previous context has been compiled into the project wiki at `./{{WIKI_DIR}}/` (qmd collection: `{{QMD_COLLECTION}}`). The wiki is the authoritative source of accumulated knowledge for this project.

### Discipline

1. **Before reading any project file, call `wiki_query` first.** Most answers already live in the wiki — this is the entire point of the rotation.
2. Only fall back to direct `read` / `bash` when the wiki returns nothing relevant or you need a verbatim file.
3. As you make new discoveries during this session, they will be folded back into the wiki at the next rotation. Be explicit about findings, decisions, and file paths so the next ingest can capture them.

### Where we left off

{{LAST_LOG_TAIL}}

### Current task

{{NEXT_TASK}}
