# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

- Default search `limit` is now 5 (was 10); pass `limit` for more.
- New `install` command (`npx -y cardloom-mcp install`, then `--yes`): finds the `claude`, `codex` and `gemini` CLIs
  on PATH, registers the server for all projects (`claude mcp add --scope user`, `codex mcp add`,
  `gemini mcp add --scope user`) and writes the README instruction block between `<!-- cardloom:start -->` and
  `<!-- cardloom:end -->` in `~/.claude/CLAUDE.md`, `$CODEX_HOME/AGENTS.md` (default `~/.codex`) and
  `~/.gemini/GEMINI.md`. Without `--yes` it only prints the plan. An existing `cardloom` entry counts only if its
  command runs `cardloom-mcp`; another command is left unchanged and gets no instructions, and `cardloom-dev`
  is never touched. Agents are handled independently, a failure exits 1, and re-running finishes the rest without
  duplicating the block. `--help` / `-h` print the usage and exit 0. Does not create `~/.cardloom`.
  Detection runs from an empty temporary directory (removed afterwards), so for Claude Code only a user-scope
  `cardloom` counts as registered (a local or project-scope one is registered again at user scope, and a second
  run reports it as already registered). An unreadable `gemini mcp list` is never read as "no cardloom entry": the
  agent is left unchanged. Instruction files are written through a temp file and a rename, so a failed write
  cannot truncate them, a symlinked file stays a symlink and the file keeps its permissions.
  The block lives in `src/config/agent-instructions.ts`; a test fails if it differs from the README.
- README: new FAQ "How is cardloom different from other agent memory tools?" and `tests/readme-claims.test.ts`,
  which fails if the README links no `trust-guarantees` test or contains a forbidden claim pattern.
- Tests: `tests/integration/trust-guarantees.test.ts` checks, on the JSON `search_knowledge` and `get_card` return, that
  drafts, deprecated, restricted and superseded cards are not returned by default, that drafts are labelled
  `untrusted`, deprecated cards `deprecated` and restricted cards `restricted` when requested, that an old card is flagged `stale`, and that a superseded card reports its replacement. The README
  has a new "What is tested" section.
- Benchmark: `--compare-limits` runs every query with `limit` 5 and with `limit` 10 (two real runs) for each
  ranking and prints recall@5 and recall@10 per kind plus the estimated response tokens (mean and p95,
  measured on the JSON `search_knowledge` returns, characters / 4). `--limit <n>` runs a single benchmark at
  that limit; recall@10 appears when `n` is 10 or more. A synthetic fixture
  store for trying it is in `tests/fixtures/benchmark-store`.
- Benchmark: four new query kinds, `superseded` (needs `replaced`), `stale`, `drift` (needs `context.versions`)
  and `wrong_scope` (needs `forbidden`), each scored per failure type: `visible` (is the replaced card still
  in the top 5), `retrieved` (is the expected card in the top 5), `flag acc` (is it flagged stale or drift)
  and `wrong@1` (does a forbidden card rank first). See the README "Benchmark" section.
- `get_card` (and the `knowledge://card/{id}` resource) now report a replacement: `replacement.pending` lists
  drafts that propose to replace the card (it is still the current answer), and `replacement.superseded_by`
  names the verified card that replaced it. The field is absent when neither applies.
- Rejecting a draft now has a convention: start the deprecation reason with `rejected:`. The web viewer
  shows a "Reject" button on drafts that does this for you. The `distill_project_knowledge` prompt tells
  the agent not to save a learning a human already rejected.
- `doctor` reports review stats: drafts waiting (and the age of the oldest), cards approved by a human,
  by merge promotion, rejected, and retired before review, plus the human approval rate. Merge promotion means
  the exact `verification_method` `promote-merged` writes in `auto` mode; `merged:...+chat-approval` (a human
  approving a candidate in chat) counts as a human approval.
- New `triage` command (`npx cardloom-mcp triage`, `npm run triage-drafts`): lists each draft with the cards
  worth comparing it with before you decide (similar title, overlapping facets, the card it supersedes,
  whether that card was already replaced or rejected). It reports evidence only, never a verdict, and is
  read-only. `--limit <n>` examines the oldest n drafts; `--json` prints the report as JSON; `--help` / `-h` print
  the usage and exit 0.

## 1.1.2

- Listed in the official MCP Registry as `io.github.bangca85/cardloom-mcp`: `mcpName` in `package.json`
  and a `server.json` at the repository root.

## 1.1.1

- Merge promotion: a `source_commit` whose abbreviation is made only of digits (about 4% of 7-character
  abbreviations) is now recognised as a commit instead of being skipped with "no sha". It is used only
  when no token with both a digit and a letter exists, and it still has to resolve to a real commit.

## 1.1.0

- Requires Node 22 or newer (Node 20 reached end of life in April 2026). CI now runs 22 and 24.
- `better-sqlite3` 13: ships its prebuilt binaries inside the package, so installing no longer runs a
  download-or-compile script. This avoids the npm warning about install scripts and the
  "unsupported" deprecation notice for `prebuild-install`.
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
