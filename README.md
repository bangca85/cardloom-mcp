# cardloom-mcp

[![CI](https://github.com/bangca85/cardloom-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/bangca85/cardloom-mcp/actions/workflows/ci.yml)

**Save engineering decisions and fixes your coding agent can look up later.** Give your agent
instructions to search before answering and to save new lessons as draft cards. Search returns verified
cards by default, and you decide what gets verified. Cards are plain markdown in a git repository, and
search is a local SQLite index with no LLM on the read path. It works with any MCP client, such as
Claude Code, Cursor or Codex.

## How it works

- **Cards.** One markdown file per lesson: a `decision`, `gotcha` (with the error message in
  `error_signature`), `pattern`, `playbook` or `snippet`, tagged with the stack, versions and project
  it applies to.
- **Lifecycle.** `draft → verified → deprecated`. An agent can only create drafts; a human approves
  (`verified`) or retires (`deprecated`) them. Deprecated is final and the file is kept for history. Merge promotion can optionally verify
  drafts whose source commit was merged.
  Search returns verified cards by default; drafts and deprecated cards only on request, always labelled.
- **Git is the source of truth.** `cards/*.md` and `events/*.jsonl` are committed locally. The SQLite
  index is derived and can be rebuilt at any time. Syncing between machines is an ordinary git
  push/pull that you run; the server never touches a remote.
- **Search.** Full-text search (SQLite FTS5) with matching on stack, version and project. Every result
  says how it matched, so an agent can tell a real hit from a loose one, and carries a trust score
  from usage feedback and age.
- **Checks on save and read.** Draft and deprecated content is labelled `untrusted` / `deprecated` in
  every response, secret patterns are rejected on save, and a card that conflicts with an existing
  one is refused instead of silently overwriting it.

The agent searches before it works, reports whether a card helped, and saves what it learned as a
draft. You decide what a draft becomes:

<p align="center">
  <img src="https://raw.githubusercontent.com/bangca85/cardloom-mcp/main/assets/how-it-works.png" alt="Flow: the agent calls search_knowledge, report_card_usage and save_learning_draft; Cardloom reads verified cards and writes feedback events and new draft cards to git. A card moves draft, verified, deprecated, and only a human approves those steps." width="900">
</p>

## Tools

| Tool | What it does |
| --- | --- |
| `search_knowledge` | Find cards by keywords or a pasted error message; returns compact results with a `match` label. |
| `get_card` | Read one card in full (also available as the resource `knowledge://card/{id}`). Reports `replacement.pending` (a draft proposes to replace it; it is still the current answer) and `replacement.superseded_by` (read that card instead). |
| `save_learning_draft` | Save a new card as a draft. |
| `update_card_status` | Verify or deprecate a card; agents should call it only when you tell them to. |
| `report_card_usage` | Report whether a card helped: `confirmed`, `refuted` or `neutral`. |

There is also one prompt, `distill_project_knowledge`, which guides an agent through turning an existing
project's docs and history into draft cards.

## Quickstart

Five steps from an empty knowledge store to your first trusted card:

1. Register the server and the usage instructions with every agent CLI found on your machine
   (Claude Code, Codex, Gemini CLI). The first command only prints what it would do:

   ```bash
   npx -y cardloom-mcp install
   npx -y cardloom-mcp install --yes
   ```

   `install --yes` registers the server for all your projects and adds the
   [instruction block](#enforcing-usage-claudemd--agentsmd--geminimd) between `<!-- cardloom:start -->`
   and `<!-- cardloom:end -->` in `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md` (or `$CODEX_HOME/AGENTS.md`) and
   `~/.gemini/GEMINI.md`. It never touches a `cardloom` entry that runs another command, and running it
   again finishes whatever failed without duplicating the block (see
   [Set it up once for all projects](#set-it-up-once-for-all-projects)). To register by hand for
   one project instead:

   ```bash
   claude mcp add cardloom -- npx -y cardloom-mcp
   ```

2. Run `npx cardloom-mcp doctor` to see the store path and card counts by status. If there are no
   verified cards, it points you back to this quickstart. The check is read-only.
3. Ask your agent to save one gotcha it just hit, for example: "Save what we learned about this
   error as a gotcha card, and put the exact error message in `error_signature`." The agent calls
   `save_learning_draft`; the card lands as `draft`.
4. Approve it in chat: "Verify that card." The agent calls `update_card_status` with action
   `verify`. Until you do this, the draft stays out of default search (see [Approving knowledge in chat](#approving-knowledge-in-chat)).
5. Search for it: ask the agent to call `search_knowledge` with the exact `error_signature` text you
   saved. With default settings the card comes back with `match: "exact_signature"`.

To label results for the repo you are working in, add a `.knowledge-map.yaml` at that repo's root
(details in [`.knowledge-map.yaml`](#knowledge-mapyaml--giving-the-agent-context-per-repo)):

```yaml
project: acme/billing-api
stack:
  - node
domain: backend
```

To have your agent use the tools without being asked each time, see
[Enforcing usage](#enforcing-usage-claudemd--agentsmd--geminimd).

## Setup

The server exposes the same five tools with each setup option.

Options 2 and 3 run from a clone: `git clone https://github.com/bangca85/cardloom-mcp.git && cd cardloom-mcp`.

### Option 1: npx (no clone, no Docker)

Needs Node 22 or newer (CI runs 22 and 24). The launcher keeps your cards in
`~/.cardloom/knowledge-store` and the SQLite index in `~/.cardloom/index.db`; set
`KNOWLEDGE_STORE_PATH` / `INDEX_DB_PATH` to put them elsewhere.

```bash
claude mcp add cardloom -- npx -y cardloom-mcp
npx cardloom-mcp doctor   # read-only health check: store path, card counts by status
```

`claude mcp add` registers the server for the current project only; add `--scope user` to use it
everywhere (see [Set it up once for all projects](#set-it-up-once-for-all-projects)).

Other clients use the same command. Cursor (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "cardloom": { "command": "npx", "args": ["-y", "cardloom-mcp"] }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.cardloom]
command = "npx"
args = ["-y", "cardloom-mcp"]
```

The SQLite driver (`better-sqlite3`) ships prebuilt binaries for common platforms; elsewhere npm
compiles it, which needs a C++ toolchain.

### Option 2: Docker

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

Each MCP session starts a fresh container (`docker compose run --rm -i`) that exits when the client
disconnects. Cards live in `./knowledge-store` (a bind mount: human-editable and git-tracked). The SQLite
index lives in a separate named Docker volume, because a SQLite file on a macOS bind mount is unreliable;
never touch it by hand, it is fully disposable and rebuilds from `knowledge-store/` (see
`npm run rebuild-index`).

### Option 3: Native from a clone (no Docker)

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

Trade-off: you lose container isolation, and `git commit`s use your host's git config. The SQLite
index and its write lock live on your local filesystem, so there is no bind-mount quirk to worry about.

## Configuration

Every setting is an environment variable and every one is optional.

| Variable | Default | Meaning |
| --- | --- | --- |
| `KNOWLEDGE_STORE_PATH` | `~/.cardloom/knowledge-store` with `npx`, `./knowledge-store` otherwise | Where cards (`cards/`), usage events (`events/`) and your benchmark live. It is its own git repository. |
| `INDEX_DB_PATH` | `~/.cardloom/index.db` with `npx`, `<store>/.metadata/index.db` otherwise | The SQLite index. Derived data, safe to delete. |
| `SEARCH_FALLBACK` | `tiered` | `tiered`: when exact-word search finds fewer than `limit` cards, add partial matches labelled `related`. `off`: exact-word search only. |
| `SEARCH_RANKING` | `baseline` | Result order: `baseline` or the opt-in `x` / `y`. See [How search works](#how-search-works). |
| `STALE_THRESHOLD_DAYS` | `180` | A verified card older than this is flagged `stale`. |
| `REVIEW_FAILURE_THRESHOLD` | `2` | A card with this many `refuted` reports is flagged `needs_review`. |
| `REVIEWER_NAME` | `human-reviewer` | Recorded as `verified_by` when a card is approved. |
| `KNOWLEDGE_MACHINE_ID` | the host name | Names this machine's usage log (`events/<id>.jsonl`) so two machines never write the same file. |
| `PROMOTION_MODE` and the other `PROMOTION_*` | see [Merge promotion](#merge-promotion-npm-run-promote-merged) | Control `npm run promote-merged`. |
| `PORT` | `3334` | Web viewer port. |
| `GRAPH_GENERIC_STACK_TAGS`, `MAX_SHARED_STACK_GROUP_SIZE`, `MAX_SHARED_STACK_EDGES` | empty, `50`, `5000` | Web viewer graph tuning. |

## How search works

`search_knowledge(query, context)` takes keywords or a pasted error message. `context` carries the
calling repo's `stack`, `versions`, `project` and `aliases` (see
[`.knowledge-map.yaml`](#knowledge-mapyaml--giving-the-agent-context-per-repo)).

Each result says how it matched:

| `match` | Meaning |
| --- | --- |
| `exact_signature` | The card's `error_signature` appears in your query. It is checked on the stored text, so `ERR-42` does not match `ERR_42`. |
| `exact_identifier` | Your query contains an identifier from the card's `error_signature`, such as `ITMS-90683` or `AccessDeniedException`. |
| `exact_title` | Your query is the card's whole title. |
| `all_terms` | Every word of your query is in the card. |
| `related` | Only some of the words match. |

When all returned cards are partial matches, the response includes `no_direct_match: true`. Use those
cards as leads for a follow-up search, not as an answer. Set `SEARCH_FALLBACK=off` to get only cards that
match all words.

`search_knowledge` returns at most 5 cards by default (it was 10 in earlier versions). Pass `limit` for more,
for example `limit: 10`. With the tiered fallback, partial matches are added only when fewer than `limit` cards
match every word.

By default only `verified`, non-restricted cards are returned. `include_drafts`, `include_deprecated` and
`include_restricted` opt in, and those cards are always labelled. Each result also carries a `trust` score
and flags: `drift` (the card's version range does not match the caller's), `stale` and `needs_review`.
With a `project` in the context, results also say whether a card belongs to this project, is shared, or
applies to another project; cards for other projects are never hidden.

**Ranking.** The default (`SEARCH_RANKING=baseline`) orders results by stack and version match, then text
relevance, then trust. The `x` and `y` modes also rank by project. They are opt-in because, in our
benchmark, putting the project ahead of the text score pushed exact matches from shared cards below weaker
matches from the caller's own project. Run `npm run benchmark -- --matrix` against your own store before
enabling them.

## What is tested

[`tests/integration/trust-guarantees.test.ts`](tests/integration/trust-guarantees.test.ts) checks the JSON
that `search_knowledge` and `get_card` return, not internal objects, for these behaviours:

- **Filtered by default.** A default search does not return draft, deprecated or restricted cards, and does
  not return a card that has been superseded.
- **Labelled when requested.** With `include_drafts`, a draft is returned with `untrusted: true`; with
  `include_deprecated`, a deprecated card is returned with `deprecated: true`; with `include_restricted`, a
  restricted card is returned with `restricted: true`. `get_card` labels the same three cards the same way
  (and returns the `deprecation_reason`).
- **Flagged when old.** A card last verified more than `STALE_THRESHOLD_DAYS` ago carries `flags.stale: true`
  in search results (the test uses a card verified 400 days before a fixed date).
- **Replacement reported.** `get_card` on a superseded card names the card that replaced it in
  `replacement.superseded_by`.

The test shows what the server returns and how it labels it. Whether an agent acts on those labels is not
covered by this test.

## `.knowledge-map.yaml` — giving the agent context per repo

Add a `.knowledge-map.yaml` to the root of each project you work on. Your agent reads it and passes the
project and stack details to `search_knowledge`, so results are matched against your stack and versions:

```yaml
# .knowledge-map.yaml — lives in the root of each project repo you work in
project: acme/billing-api
aliases:            # optional: other names this project has had in existing cards
  - billing-api
stack:
  - nextjs@15
  - postgres@16
  - node
domain: backend
```

`project:` is the key the agent passes as `context.project` (and `aliases:` as `context.aliases`)
so results are labelled by scope (this project, shared, other project); they are ranked by project
only when `SEARCH_RANKING` is set to `x` or `y`. Cards for other projects are never hidden.
Older maps that use `repo:` instead of `project:` are still accepted by clients.

Workflow for a brand-new repo:

1. Ask the agent to inspect the repo (package.json, lockfiles, etc.) and generate a **draft**
   `.knowledge-map.yaml`.
2. Review and edit it yourself — fix wrong stack detection, add domain hints.
3. Commit it into the project repo (not `cardloom-mcp`).
4. Point your agent/client at it so `search_knowledge` calls include `context: {stack, versions, project, aliases}`
   read from that file.

## Enforcing usage (CLAUDE.md / AGENTS.md / GEMINI.md)

Nothing forces the agent to call these tools — MCP tools only fire when the model decides to. To have
your agent search before answering, report whether a card helped, and save new lessons as drafts, give it
the instructions below, in either of two places:

- **Globally, once for every project:** put the block in your client's global instructions file. See
  [Set it up once for all projects](#set-it-up-once-for-all-projects).
- **Per project:** put it in the repo's own `CLAUDE.md` (Claude Code), `AGENTS.md` (Codex) or `GEMINI.md`
  (Gemini CLI). Codex does not read `CLAUDE.md`, and Gemini CLI reads `AGENTS.md` only if you list it in
  `context.fileName`. If several clients work in the repo, add the block to each client's file.

Use one place or the other: the same block in both only costs tokens.

````markdown
## Knowledge Hub (MCP `cardloom`) — required

**Before answering/implementing a task touching a known domain** (auth, rate-limiting,
third-party API contracts, infra gotchas, etc.): call `search_knowledge(query, context)` first,
with `context` read from `.knowledge-map.yaml` at this repo's root (`stack`, `versions`, and
`project` / `aliases` so results are labelled for this repo). A result with `match: related`,
or a response with `no_direct_match: true`, is a partial match: use it as a lead for another search, not as an answer.
**If that file doesn't exist yet**, generate a draft yourself before proceeding — inspect this
repo's manifest (package.json / pubspec.yaml / go.mod / requirements.txt, lockfiles) for the
real stack + versions, write it in this shape, then ask the human to review before you rely on it:

```yaml
# .knowledge-map.yaml — repo root, human-reviewed after you draft it
project: <owner/repo-name>
aliases: []   # optional: other names this project has had in existing cards
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

### Set it up once for all projects

`npx -y cardloom-mcp install --yes` does everything in this section for the agent CLIs it finds on PATH
(`--agent claude|codex|gemini` limits it, and it can be repeated). Without `--yes` it prints the plan and changes
nothing.

- It skips registering when a server named exactly `cardloom` already runs `cardloom-mcp` (for Claude Code only
  a user-scope entry counts: a local or project-scope one is not global, so `cardloom` is registered again at
  user scope), and writes the instructions anyway. If `cardloom` exists with another command (a dev checkout, say), it leaves that entry
  alone, says so, and writes no instructions for that agent. A server named `cardloom-dev` is not touched.
- The instruction block goes between `<!-- cardloom:start -->` and `<!-- cardloom:end -->`; text outside the
  markers is never changed and a second run replaces the block instead of adding another. If a marker is
  unmatched or repeated, that agent fails and its file is left as it was. A file that already has the
  ``## Knowledge Hub (MCP `cardloom`)`` section pasted without markers is left alone too, with a note saying to wrap it in the
  markers or delete it so a later run can keep it current.
- Any agent that fails makes the command exit 1 with a summary; run it again to finish the rest.
- Even without `--yes` it runs `claude mcp get cardloom` and `gemini mcp list` (and `codex mcp list --json`) to see
  what is registered, and the first two may start the MCP servers you have configured. They run from an empty
  temporary directory, so only user-level entries are seen.

To do it by hand, register the server for every project and put the instruction block above in the client's global file:

| Client | Register the server for all projects | Global instructions file |
| --- | --- | --- |
| Claude Code | `claude mcp add --scope user cardloom -- npx -y cardloom-mcp` | `~/.claude/CLAUDE.md` |
| Codex (OpenAI's coding agent) | `codex mcp add cardloom -- npx -y cardloom-mcp` | `~/.codex/AGENTS.md` |
| Gemini CLI | `gemini mcp add --scope user cardloom npx -y cardloom-mcp` | `~/.gemini/GEMINI.md` |

- **Scope matters.** `claude mcp add` and `gemini mcp add` register the server for the current project
  only unless you pass `--scope user`, so the Quickstart command is project-scoped. `codex mcp add` writes
  `~/.codex/config.toml`, which is already global.
- **Codex.** Use `~/.codex/AGENTS.override.md` for a temporary global override without touching the base
  file. If you set `CODEX_HOME`, both files live there instead of `~/.codex`.
- **Gemini CLI.** You can also add the server by hand to `~/.gemini/settings.json` (merge it with what is
  already there):

  ```json
  { "mcpServers": { "cardloom": { "command": "npx", "args": ["-y", "cardloom-mcp"] } } }
  ```

  To make Gemini CLI read an `AGENTS.md` as well, set `"context": { "fileName": ["AGENTS.md", "GEMINI.md"] }`
  in the same file.
- **ChatGPT.** The ChatGPT chat apps do not read these files; Codex is the OpenAI client covered here.
- **Check it worked.** Run `claude mcp list`, `codex mcp list` or `gemini mcp list` and look for `cardloom`,
  then ask the agent to list its MCP tools. In Gemini CLI, `/memory show` prints the instructions it loaded.

## Approving knowledge in chat

Every card an agent saves via `save_learning_draft` starts in `status: draft` and stays out of default search
until it is verified. To promote or retire one:

- **Approve:** tell the agent to approve a card; it calls
  `update_card_status(id, "verify")`. Status flips to `verified`, and if the card declared
  `supersedes: <old-id>`, the old card is deprecated in the *same* operation (one commit). If that old card was already
  replaced by another card, the approval is refused with `invalid_transition` (`<old-id> is already superseded by <other-id>`) and nothing
  changes; the draft stays a draft and can still be deprecated.
- **Reject / retire:** tell the agent to deprecate a card with a reason; it calls
  `update_card_status(id, "deprecate", reason)`. The file is kept (a retired card is never
  deleted) and disappears from default search, but stays readable via `get_card`.
- **Reject a draft:** when the learning is wrong, a duplicate or not worth keeping, start the reason
  with `rejected:` (for example `rejected: duplicate of pattern-foo`). The web viewer's "Reject" button
  on a draft does this for you. `distill_project_knowledge` reads that prefix and tells the agent not to save
  the same learning again unless the new draft says what is different.

`npm run doctor` shows how review is going: drafts waiting (and the age of the oldest), cards approved by
a human, by merge promotion, rejected, and retired before review, and the human approval rate (of drafts a
human approved or rejected; merge promotion and retired drafts are listed beside it, not in it). A card counts
as merge promotion only when its `verification_method` is exactly what `promote-merged` writes in `auto` mode
(`merged:<repo>@<sha> (<via> <date>)`); the same evidence with `+chat-approval` after it, which is what you get
when you approve a candidate in chat, counts as a human approval. A draft's
age is counted from the commit that added the card when the store is a git repository, otherwise from the
card file's modification time.

`deprecated` is terminal — there's no un-deprecate. To bring a retired idea back, save a new card
with `supersedes` pointing at the old one and approve it.

### Triaging drafts

`npx cardloom-mcp triage` (or `npm run triage-drafts` from a clone) lists every draft with the cards you may
want to look at before deciding: same type and a similar title (Jaccard overlap of the title words, 0.5 or
more) or overlapping facets, plus the card the draft `supersedes` (shown as `this draft replaces it`). Each line shows the card's status, title
similarity, whether the facets overlap and whether it is the same project. It also says when that card was
already replaced (`superseded by <id>`) or rejected. Drafts with nothing to compare are listed under "No
related card". The report is evidence only: it gives no verdict and changes nothing, and facet overlap does
not predict what `verify` will do (verify does not run the conflict check). `--limit <n>` examines only the
oldest `n` drafts; `--json` prints the report as JSON. It reads the card files, not `index.db`, so it works
without the server running.

## Ingesting an existing project

Use the built-in prompt `distill_project_knowledge` to turn a repo's docs, architecture decisions, git
history and debug logs into draft cards:

- Invoke it from any MCP client that supports prompts (Claude Code does), optionally with `project_path`
  (defaults to the current directory), and let the agent run it.
- The prompt instructs the agent to enumerate sources exhaustively (not just CLAUDE.md's
  condensed summaries — the full numbered decision list a summary points at, every story file's
  Debug Log section, full git history, claude-mem if present), report a source survey with
  an estimate of how many lessons each source contains *before* saving anything, dedupe against existing verified cards via
  `search_knowledge` (using `supersedes` where a lesson is refined rather than new), and present
  cards in small batches for you to approve.
- All cards still land in `draft` — nothing gets `verify`d without you approving in chat.

## Merge promotion (`npm run promote-merged`)

`promote-merged` finds drafts whose source commit reached its repo's default branch after the draft was
written. By default it lists them for you to approve; in `auto` mode it verifies the eligible ones itself.
It runs on the host because it reads your other clones and calls `gh`, which the container cannot.

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
A commit pushed straight to the default branch also counts: that is evidence about the commit's history,
not proof that anyone reviewed the card.

`auto` never verifies, and always leaves as a candidate:

- a type outside `PROMOTION_AUTO_TYPES` (default `decision,pattern` — a merge is evidence about
  the change itself, not about a third-party system a gotcha describes);
- a `restricted` card;
- a card with `supersedes` — verifying it deprecates the old card, and an unapproved draft
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
> There is no way back to `draft`.

## Host sync (git push/pull)

The server **only commits locally**: it never pushes, pulls, or touches remotes or SSH keys, so
credentials never need to be inside the Docker container. To sync between machines, run
`git pull --rebase` and `git push` from your host. Use the path of your store: `~/.cardloom/knowledge-store`
with `npx`, or `<clone>/knowledge-store` otherwise.

```bash
# ~/.zshrc or ~/.bashrc
alias ksync='git -C ~/.cardloom/knowledge-store pull --rebase && git -C ~/.cardloom/knowledge-store push'
```

Run `ksync` whenever you switch machines, or automate it with `cron`/`launchd`:

```cron
# crontab -e — sync every 15 minutes
*/15 * * * * git -C /path/to/your/knowledge-store pull --rebase && git -C /path/to/your/knowledge-store push
```

Set up `knowledge-store` as its own git repo with a private remote (GitHub, etc.) from the
**host**, not from inside the container:

```bash
cd ~/.cardloom/knowledge-store   # or <clone>/knowledge-store
git remote add origin git@github.com:you/your-private-knowledge.git
git push -u origin HEAD
```

Do not commit your real `knowledge-store/` to this project repository. It can contain private
project names, decisions, error logs, source references, and SQLite runtime files. Keep it in a
separate private repo or local-only directory.

## Web viewer

A local List and Graph view of your cards, served at `http://127.0.0.1:3334`. From a clone run
`npm run web` (with the same `KNOWLEDGE_STORE_PATH` and `INDEX_DB_PATH` as the server); with Docker run
`docker compose up cardloom-web`. The `npx` launcher starts only the MCP server.

## Rebuilding the index

If `index.db` ever goes missing or looks wrong, rebuild it from scratch — `cards/*.md` and
`events/*.jsonl` are the only source of truth, the index is 100% derived and disposable:

```bash
npm run build && npm run rebuild-index
# or, in the container:
docker compose run --rm cardloom-mcp npm run rebuild-index
```

## Benchmark

Your benchmark is `benchmark/queries.yaml` inside your store, committed alongside your cards. It is a
plain YAML list:

```yaml
- query: "how do I retry a failed network request"
  expected: pattern-retry-with-backoff       # card id this query should return as top-1
  context:                                    # optional, same shape as search_knowledge's context
    stack: [node]
- query: "TypeError: Cannot read property 'foo' of undefined"
  expected: gotcha-foo-undefined-crash
```

Each entry may also carry a `kind` (default `known`, so entries with just `query` + `expected` keep
working), an `expected` list, and `forbidden` ids:

```yaml
- query: "retry policy for payments"
  kind: project_decision                      # known | missing | project_decision | cross_project | superseded | stale | drift | wrong_scope
  expected: decision-payments-retry
  forbidden: [decision-billing-retry]         # top-1 here counts as a wrong-project answer
  context: { project: acme/payments-api, stack: [node] }
- query: "how do we shard the queue"
  kind: cross_project
  expected: [pattern-queue-sharding, gotcha-hot-partition]   # recall@5 counts any of these
- query: "zqxv7000 error"
  kind: missing                               # no card should answer this; no `expected`
```

Per kind the report gives `n` plus: `known` / `cross_project` hit@1, MRR@5, recall@5 (any id in
`expected`); `missing` `falseAnswerRate` (share whose top-1 is not labelled `related`) and
`anyResultRate` (share returning at least one result); `project_decision` hit@1 and
`wrongProjectTop1Rate` (share whose top-1 is in `forbidden`). To compare ranking modes before changing
`SEARCH_RANKING`, look at `wrongProjectTop1Rate` (project_decision) and recall@5 (cross_project).

Four more kinds score the failures around old, outdated and out-of-scope answers, each as a separate
metric so you can tell *which* part failed (the default-visibility top 5 is what a caller sees):

```yaml
- query: "retry policy"
  kind: superseded                            # a newer card replaced an older one
  expected: decision-retry-v2
  replaced: decision-retry-v1                 # required: the card `expected` replaced
- query: "how do we invalidate the cache"
  kind: stale                                 # expected card is old; it should come back flagged stale
  expected: pattern-cache-invalidation
- query: "api pagination"
  kind: drift                                 # expected card's version range misses the caller's versions
  expected: pattern-api-pagination-v2
  context: { stack: [node], versions: { node: "3.1.0" } }   # `context.versions` is required
- query: "lookup cache"
  kind: wrong_scope                           # another scope's card must not rank first
  expected: pattern-python-cache
  forbidden: [pattern-node-lookup-cache]      # required, non-empty
  context: { stack: [node] }
```

- `visible` (`replacedVisibleRate`, superseded): share of queries where `replaced` shows up anywhere in the
  top 5, with or without a label. It is a visibility failure: a retired card should not be returned at all.
  Superseded also reports hit@1 and MRR@5 on `expected`.
- `retrieved` (`retrievedRate`, stale and drift): share of queries with `expected` in the top 5, which
  isolates retrieval from flagging.
- `flag acc` (`flagAccuracy`, stale and drift): among the retrieved cards, the share carrying
  `flags.stale` (stale) or `flags.drift` (drift). It is 0 when nothing was retrieved.
- `wrong@1` (`wrongScopeTop1Rate`, wrong_scope): share whose top-1 is a `forbidden` id, flagged or not. It is
  a ranking failure. Wrong_scope also reports hit@1 and `wrongTop1FlaggedRate` (printed `flagged@1`), the
  share of those wrong top-1s that carry `flags.drift`; it is a diagnostic, not a pass/fail rate.

The text report prints these as `visible=`, `retrieved=`, `flag acc=` and `wrong@1=`, and `--matrix`
shows them as `visible`, `retrieved`, `flag acc` and `wrong@1` cells.

`--synthetic` skips `queries.yaml` and derives a suite from the store (verified + normal cards
only): `title` (verbatim), `title_nl` (the first seven title words inside a question template), `sig_noisy` (a noisy pasted
error line, gotchas only) and 100 `missing` queries built from fabricated tokens, each checked to
have zero full-text hits. `--matrix` runs the same queries under `baseline/off`,
`baseline/tiered`, `x/tiered` and `y/tiered` (ranking/fallback) and prints one row per config:

```bash
npm run build && npm run benchmark -- --synthetic --matrix
```

A plain run (no `--limit`) reports at the tool's default limit, 5, so its numbers describe what an agent gets
from `search_knowledge` without passing `limit`; `--limit` and `--compare-limits` are unchanged. `--limit <n>`
runs the benchmark with `search_knowledge`'s `limit` set to `n` (the report then also shows
recall@10 when `n` is 10 or more). `--compare-limits` runs every query twice, once with `limit` 5 and once with
`limit` 10, for each ranking (`baseline`, `x`, `y`), and prints one table per ranking: recall@5 per kind for the
limit-5 run, recall@5 and recall@10 for the limit-10 run, hit@1 and each kind's own metric for both, and the
estimated response size of both runs (mean and p95 tokens). Both are real runs, never "run 10 and cut to 5",
because with the tiered fallback `limit` decides whether the OR tier runs at all: when the AND tier already
returns `limit` cards, the OR tier is skipped, so a card that only matches some terms can appear at 10 and
not at 5. Token figures are estimates (the JSON `search_knowledge` returns, characters divided by 4), not a
tokenizer count. The two flags cannot be combined, and an offline fixture to try them on lives in
`tests/fixtures/benchmark-store`:

```bash
npm run build && npm run benchmark -- --compare-limits
KNOWLEDGE_STORE_PATH=tests/fixtures/benchmark-store npm run benchmark -- --compare-limits
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
low hit rate is a signal to add facets or fix a card, not a failure. If any `expected` or `forbidden` card id in
`benchmark/queries.yaml` has no card in the store, the benchmark lists those ids and exits with
code 2 without scoring. Expected ids that exist but default search would never return (not
`verified`, or `restricted`) only print a warning. Other operational problems (corrupt YAML, unreadable store) exit 1. If
`benchmark/queries.yaml` doesn't exist yet, it says so and exits cleanly instead of erroring.

## Commands

```bash
npm run build          # tsc
npm run dev            # tsx watch src/index.ts (runs on the host, no Docker)
npm test                # vitest run
npm run rebuild-index   # rebuild index.db from cards/ + events/
npm run benchmark       # measure top-1 hit rate + latency against benchmark/queries.yaml
npm run doctor          # read-only store health check (path, git, card counts by status)
npm run triage-drafts   # read-only: drafts with the cards to compare them with
npm run web             # local web viewer (List / Graph view) on http://127.0.0.1:3334
npm run promote-merged  # list or verify drafts whose source commit was merged
docker compose build && docker compose run --rm -i cardloom-mcp
```

## How is cardloom different from other agent memory tools?

Memory tools such as mem0 and claude-mem let the agent write memories and read them back with no review step.
cardloom adds one: agents only save drafts, a human approves them by default, and a default search returns only approved
cards. Cards are markdown files in a git repository you own, and search runs locally without an LLM call.
Drafts, retired and restricted cards are filtered out unless you ask for them, and are labelled when returned.
Old cards are flagged `stale`, and `get_card` reports when a card has been replaced.
[`tests/integration/trust-guarantees.test.ts`](tests/integration/trust-guarantees.test.ts) checks these
behaviours on the JSON the server returns. It does not test whether an agent uses them well.

Another tool fits better in two cases. Use mem0 or claude-mem if you want memory with no review step. Use a
plain `CLAUDE.md` if you have one small repository.

## Contributing, security, license

- **Contributing:** see [CONTRIBUTING.md](CONTRIBUTING.md). Never commit a real `knowledge-store/`, SQLite
  files or local agent settings; use synthetic cards in tests and examples.
- **Security:** report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Treat
  unreviewed cards as untrusted content.
- **License:** [ISC](LICENSE).
