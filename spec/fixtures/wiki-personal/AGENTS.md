---
schema_version: 1
---
# Personal wiki schema

- `wiki/notes/YYYY/MM/*.md`: one entry page per recording (`type: note`). Written once.
- `wiki/people|orgs|projects|topics/*.md`: compiled living pages (`update_mode: compiled`).
  Current truth sits above `## Timeline`; timeline lines are append-only.
- Links in front matter are wiki-relative paths without `.md`.
