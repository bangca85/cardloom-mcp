# Changelog

All notable changes to this project will be documented in this file.

## 1.0.1

- README: flow diagram as an image in "How it works" (the text version was cut off on npm).
- SECURITY.md: private reporting link, supported versions and scope.

## 1.0.0

First public release.

- Card-based knowledge store: markdown cards (`decision`, `gotcha`, `pattern`, `playbook`, `snippet`) with a
  `draft → verified → deprecated` lifecycle, kept in git, with a rebuildable SQLite FTS5 index.
- MCP tools `search_knowledge`, `get_card`, `save_learning_draft`, `update_card_status` and
  `report_card_usage`, the resource `knowledge://card/{id}`, and the prompt `distill_project_knowledge`.
- Search: tiered fallback by default (`SEARCH_FALLBACK=tiered`) with a `match` label on every result and
  `no_direct_match` when nothing answers; `SEARCH_FALLBACK=off` for exact-word search only.
- Optional `project` key on cards and in `.knowledge-map.yaml` (`project:`, `aliases:`), with scope labels on
  results. Project-aware orderings (`SEARCH_RANKING=x|y`) are opt-in.
- Merge promotion (`npm run promote-merged`), a local web viewer, and a benchmark CLI with query kinds and a
  ranking matrix.
- `npx cardloom-mcp` launcher and a read-only `cardloom-mcp doctor` command.
