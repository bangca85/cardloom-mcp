x

# cardloom-mcp

MCP Knowledge Hub: long-lived, cross-project technical memory for an AI agent. Knowledge lives as
markdown **cards** (`draft → verified → deprecated`) in a git-backed store, indexed by SQLite for
fast search. A human reviewer approves or retires cards while the agent reads, writes drafts, and
reports usage outcomes.

## Setup

1. Build the server:

   ```bash
   npm install
   npm run build
   ```
2. Build the container image:

   ```bash
   docker compose build
   ```
3. Register the server with your MCP client using the wrapper script at `bin/cardloom-mcp.sh` —
   **use an absolute path**, since MCP clients spawn the command with an arbitrary working
   directory and the wrapper needs to find `docker-compose.yml` regardless.

   **Claude Code:**

   ```bash
   claude mcp add cardloom -- /absolute/path/to/cardloom-mcp/bin/cardloom-mcp.sh
   ```

   **Cursor** (`~/.cursor/mcp.json`):

   ```json
   {
     "mcpServers": {
       "cardloom": {
         "command": "/absolute/path/to/cardloom-mcp/bin/cardloom-mcp.sh"
       }
     }
   }
   ```

   **Codex CLI / Codex extension (VS Code)** (`~/.codex/config.toml`):

   ```toml
   [mcp_servers.cardloom]
   command = "/absolute/path/to/cardloom-mcp/bin/cardloom-mcp.sh"
   args = []
   ```

   Or via the Codex Settings UI → **MCP servers → Connect to a custom MCP** (writes to the
   same `config.toml`): Name `cardloom`, Type `STDIO`, Command to launch =
   `/absolute/path/to/cardloom-mcp/bin/cardloom-mcp.sh`, leave Arguments/Environment
   variables/Working directory empty, Save.
4. Verify: ask your client to list MCP tools. You should see exactly 5 — `search_knowledge`,
   `get_card`, `save_learning_draft`, `update_card_status`, `report_card_usage` — plus one
   resource template, `knowledge://card/{id}`, and one Prompt, `distill_project_knowledge`
   (see [Ingesting an existing project](#ingesting-an-existing-project)).

### Native (no Docker)

Docker on macOS runs a Linux VM (Virtualization.framework) underneath, which reserves several GB
of RAM regardless of how small the container's own workload is. The server itself is light —
measured at ~100MB RSS for the MCP process and ~71MB for the web viewer, both idle at 0% CPU — so
running directly on the host with plain `node` skips the VM overhead entirely.

```bash
npm install
npm run build
```

Register the server with your MCP client using `node` directly instead of the Docker wrapper:

```json
{
  "mcpServers": {
    "cardloom": {
      "command": "node",
      "args": ["/absolute/path/to/cardloom-mcp/dist/index.js"],
      "env": {
        "KNOWLEDGE_STORE_PATH": "/absolute/path/to/cardloom-mcp/knowledge-store",
        "INDEX_DB_PATH": "/absolute/path/to/cardloom-mcp/.metadata/index.db"
      }
    }
  }
}
```

For the web viewer, run `npm run web` (or `node dist/web/server.js`) with the same two env vars
set, plus `PORT` if you don't want the default `3334`.

Trade-off: you lose container isolation and `git commit`s use your host's git config (which
actually matches AD-11 more closely — push/pull was always the host's job). The
`.metadata/index.db` + write lock land on your local filesystem instead of a named Docker
volume — on macOS this sidesteps the virtiofs bind-mount hazard AD-16 warns about for the
containerized path, since there's no bind mount involved at all.

Each MCP session starts a fresh container (`docker compose run --rm -i`) that exits when the
client disconnects. Cards live in `./knowledge-store` (bind mount, human-editable, git-tracked);
the SQLite index lives in a separate named Docker volume — never touch it by hand, it's fully
disposable and rebuilds from `knowledge-store/` (see `npm run rebuild-index`).

Optional environment variables:

```bash
KNOWLEDGE_STORE_PATH=./knowledge-store
INDEX_DB_PATH=./knowledge-store/.metadata/index.db
REVIEWER_NAME=human-reviewer
```

## Host sync (git push/pull)

The container **only commits locally** — it never pushes, pulls, or touches remotes or SSH keys
(by design: credentials stay on the host, never inside the container). Syncing between machines
is a host-side git habit, same as any other repo:

```bash
# ~/.zshrc or ~/.bashrc
alias ksync='git -C ~/path/to/cardloom-mcp/knowledge-store pull --rebase && git -C ~/path/to/cardloom-mcp/knowledge-store push'
```

Run `ksync` whenever you switch machines, or automate it with `cron`/`launchd`:

```cron
# crontab -e — sync every 15 minutes
*/15 * * * * git -C /path/to/cardloom-mcp/knowledge-store pull --rebase && git -C /path/to/cardloom-mcp/knowledge-store push
```

Set up `knowledge-store` as its own git repo with a private remote (GitHub, etc.) from the
**host**, not from inside the container:

```bash
cd knowledge-store
git remote add origin git@github.com:you/your-private-knowledge.git
git push -u origin main
```

Do not commit your real `knowledge-store/` to this project repository. It can contain private
project names, decisions, error logs, source references, and SQLite runtime files. Keep it in a
separate private repo or local-only directory.

## `.knowledge-map.yaml` — giving the agent context per repo

The server never reads this file itself (FR19 — deferred). Instead, in each of your *other*
project repos, keep a `.knowledge-map.yaml` that your agent reads and passes as `context` to
`search_knowledge`, so results rank by facet relevance instead of just keyword match:

```yaml
# .knowledge-map.yaml — lives in the root of each project repo you work in
repo: my-app
stack:
  - nextjs@15
  - postgres@16
  - node
domain: backend
```

Workflow for a brand-new repo:

1. Ask the agent to inspect the repo (package.json, lockfiles, etc.) and generate a **draft**
   `.knowledge-map.yaml`.
2. Review and edit it yourself — fix wrong stack detection, add domain hints.
3. Commit it into the project repo (not `cardloom-mcp`).
4. Point your agent/client at it so `search_knowledge` calls include `context: {stack, versions}`
   read from that file.

## Enforcing usage from a consumer project's CLAUDE.md / AGENTS.md

Nothing forces the agent to call these tools — MCP tools only fire when the model decides to.
If you want reliable query-before-answer and write-back-after-learning behavior in one of your
*other* project repos, paste this into that repo's project-instructions file: `CLAUDE.md` for
Claude Code, `AGENTS.md` for Codex (Codex does not read `CLAUDE.md`). If both clients touch the
same repo, paste it into both files.

````markdown
## Knowledge Hub (MCP `cardloom`) — required

**Before answering/implementing a task touching a known domain** (auth, rate-limiting,
third-party API contracts, infra gotchas, etc.): call `search_knowledge(query, context)` first,
with `context` read from `.knowledge-map.yaml` at this repo's root (stack/versions).
**If that file doesn't exist yet**, generate a draft yourself before proceeding — inspect this
repo's manifest (package.json / pubspec.yaml / go.mod / requirements.txt, lockfiles) for the
real stack + versions, write it in this shape, then ask the human to review before you rely on it:

```yaml
# .knowledge-map.yaml — repo root, human-reviewed after you draft it
repo: <repo-name>
stack:
  - <tech>@<version>
  - <tech>@<version>
domain: <frontend|backend|infra|product|...>
```

Don't re-derive something a `verified` card already answers.

**After using a returned card — you MUST call `report_card_usage(id, outcome)`**
(`confirmed`/`refuted`/`neutral`). This is not optional — every search/get_card response carries
a `write_back_reminder`; skipping it lets trust scores and `needs_review` flags drift stale.

**Learned something new** (a decision, pattern, or gotcha with no existing card, or a refinement
of an existing one) → call `save_learning_draft`. It always lands as `draft` — never verify it
yourself. Put a bare commit sha in `source_commit` and the repo's GitHub `owner/name` in
`source_repo` whenever the learning comes from a commit: that is what lets merge promotion find
it. Free text there ("working tree", "local changes") means the card can only ever be approved by hand.

**Found a major mismatch between a `verified` card and current reality** (the card says A, the
code/logs/API actually do B — a real contradiction, not a nuance): **stop, don't silently trust
either side.** Lay out:

- which card, what it currently claims (`id` + summary)
- what you actually observed (specific file/log/response)
- the two possible resolutions: the card is stale/wrong → deprecate it + save a new card with
  `supersedes`, or the code is the regression → fix the code and leave the card as-is

then ask for confirmation on which direction before calling `update_card_status` or
`save_learning_draft(supersedes=...)`. Don't decide alone when the mismatch affects an
architecture or security call.
````

## Ingesting an existing project

To distill an existing repo's accumulated knowledge (docs, architecture decisions, git history,
story debug logs) into draft cards in one go, use the built-in MCP Prompt instead of hand-writing
a distillation prompt each time:

- Claude Code / any MCP client that supports Prompts: invoke `distill_project_knowledge`
  (optionally with `project_path` — defaults to cwd) and let the agent run it.
- The prompt instructs the agent to enumerate sources exhaustively (not just CLAUDE.md's
  condensed summaries — the full numbered decision list a summary points at, every story file's
  Debug Log section, full git history, claude-mem if present), report a source survey with
  expected nugget counts *before* saving anything, dedupe against existing verified cards via
  `search_knowledge` (using `supersedes` where a lesson is refined rather than new), and present
  cards in small batches for you to approve.
- All cards still land in `draft` — nothing gets `verify`d without you approving in chat.

## Approving knowledge in chat

Every card an agent saves via `save_learning_draft` starts in `status: draft` — never trusted
automatically (FR2). To promote or retire one:

- **Approve:** tell the agent to approve a card; it calls
  `update_card_status(id, "verify")`. Status flips to `verified`, and if the card declared
  `supersedes: <old-id>`, the old card is deprecated in the *same* operation (one commit).
- **Reject / retire:** tell the agent to deprecate a card with a reason; it calls
  `update_card_status(id, "deprecate", reason)`. The file is kept (invalidate-and-preserve, FR3)
  and disappears from default search, but stays readable via `get_card`.

`deprecated` is terminal — there's no un-deprecate. To bring a retired idea back, save a new card
with `supersedes` pointing at the old one and approve it.

## Merge promotion (`npm run promote-merged`)

A draft whose source commit went through its own repo's review and merge has a second piece of
evidence besides your chat approval. `promote-merged` (host-side CLI — it reads your other clones
and calls `gh`, which the container never can) finds those drafts and, depending on
`PROMOTION_MODE`, lists or verifies them.

| `PROMOTION_MODE` | What happens |
| --- | --- |
| `off` | Nothing. |
| `review` (default) | Lists merged drafts as candidates. You approve in chat; the agent calls `update_card_status(id, "verify", verification_method="<evidence>+chat-approval")`. |
| `auto` | Verifies the eligible ones itself, `verified_by: merge-bot`, `verification_method: merged:<repo>@<sha> (<via> <date>)`. Lists the rest as candidates. |

**"Merged" means the commit entered the default branch AFTER the card was written** (card date =
its `knowledge: add` commit in the store). A card about code already on `main` records main's
HEAD, which is trivially "merged"; counting that would verify every observation on save. How a
commit's arrival is dated: on the first-parent line → its own date; brought in by a merge → the
merge commit's date; not in the clone at all (squash merge) → the GitHub pull request's `merged_at`.

`auto` never verifies, and always leaves as a candidate:

- a type outside `PROMOTION_AUTO_TYPES` (default `decision,pattern` — a merge is evidence about
  the change itself, not about a third-party system a gotcha describes);
- a `restricted` card;
- a card with `supersedes` — verifying it deprecates the old card (AD-13), and an unapproved draft
  must never kill a verified card.

Skipped outright: `source_commit` without a sha, a learning from uncommitted work on top of a sha,
a commit not merged yet, a repo that cannot be found.

| Env | Default | Meaning |
| --- | --- | --- |
| `PROMOTION_MODE` | `review` | `off` / `review` / `auto`; anything else reads as `review` |
| `PROMOTION_REPO_ROOTS` | — | `:`-separated dirs scanned 3 levels deep for clones named like the card's repo |
| `PROMOTION_AUTO_TYPES` | `decision,pattern` | card types `auto` may verify |
| `PROMOTION_FETCH` | `1` | `git fetch origin` each matched clone first; `0` = trust its current refs |
| `PROMOTION_BOT_NAME` | `merge-bot` | `verified_by` written by `auto` |

```bash
npm run build
npm run promote-merged -- --dry-run          # auto mode prints would_verify, writes nothing
npm run promote-merged -- --mode=review --json
```

> Note: an auto-verified card can be undone only like any verified card — `deprecate` it, or
> `git revert` its `knowledge: verify` commit in the store and `npm run rebuild-index`.
> There is no way back to `draft` (AD-9).

## Rebuilding the index

If `index.db` ever goes missing or looks wrong, rebuild it from scratch — `cards/*.md` and
`events/*.jsonl` are the only source of truth, the index is 100% derived and disposable:

```bash
npm run build && npm run rebuild-index
# or, in the container:
docker compose run --rm cardloom-mcp npm run rebuild-index
```

## Benchmark

`knowledge-store/benchmark/queries.yaml` is the source of truth for the Success Criteria (top-1
hit rate — target ≥70% MVP, measured monthly). It's a plain YAML list, committed alongside your
cards:

```yaml
- query: "how do I retry a failed network request"
  expected: pattern-retry-with-backoff       # card id this query should return as top-1
  context:                                    # optional, same shape as search_knowledge's context
    stack: [node]
- query: "TypeError: Cannot read property 'foo' of undefined"
  expected: gotcha-foo-undefined-crash
```

Write queries the way you'd actually ask — real questions, real pasted error messages — each
pointing at the card id you expect to come back first. Multiple queries can point at the same
card.

Run it:

```bash
npm run build && npm run benchmark
# or, in the container:
docker compose run --rm cardloom-mcp npm run benchmark
```

Each run builds its own throwaway in-memory index from the card files in the store (it never
reads `index.db`, so a stale index cannot produce a false score), then prints a corpus fingerprint
line (card count, verified count, sha256 over `id|status|file_mtime`) before the report.

It runs every query through the exact same `search_knowledge` ranking path (no separate scoring
logic to drift out of sync) and reports top-1 hit rate, p50/p95 latency, and a list of misses. A
low hit rate is a signal to add facets or fix a card, not a failure. If any `expected` card id in
`benchmark/queries.yaml` has no card in the store, the benchmark lists those ids and exits with
code 2 without scoring. Other operational problems (corrupt YAML, unreadable store) exit 1. If
`benchmark/queries.yaml` doesn't exist yet, it says so and exits cleanly instead of erroring.

## Commands

```bash
npm run build          # tsc
npm run dev            # tsx watch src/index.ts (runs on the host, no Docker)
npm test                # vitest run
npm run rebuild-index   # rebuild index.db from cards/ + events/
npm run benchmark       # measure top-1 hit rate + latency against benchmark/queries.yaml
docker compose build && docker compose run --rm -i cardloom-mcp
```

## Public repository hygiene

This repository is intended to contain source code, tests, and public documentation only.
Keep these out of public commits:

- `knowledge-store/` and any real cards/events/benchmark data
- SQLite files such as `*.db`, `*.db-wal`, and `*.db-shm`
- local MCP/agent settings such as `.claude/`, `.agent/`, `.agents/`, and `_bmad/`
- internal planning docs unless they have been explicitly sanitized for `docs/public/`
- build outputs and dependencies such as `dist/` and `node_modules/`
