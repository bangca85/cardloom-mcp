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
| `get_card` | Read one card in full (also available as the resource `knowledge://card/{id}`, which always returns the full body). Optional `compact: true` returns only the first 600 characters of the body (cut on a character boundary, then `…`; `truncated: true` is set only when something was cut); everything else is unchanged, and the default is the full body. Carries `source` (`repo`, 7-character `commit`, `approved_at` date; each `null` when unknown) so you can tell where it came from. Reports `replacement.pending` (a draft proposes to replace it; it is still the current answer) and `replacement.superseded_by` (read that card instead). |
| `save_learning_draft` | Save a new card as a draft. |
| `update_card_status` | Verify, deprecate or reconfirm a card; agents should call it only when you tell them to. |
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
| `CARDLOOM_TELEMETRY` | off | `local` records how each search ended in `telemetry.jsonl` beside the index, for `gaps`. Anything else is off. See [Knowledge gaps](#knowledge-gaps). |
| `CARDLOOM_TELEMETRY_PATH` | beside the index | Absolute path of the telemetry file. Refused if it is inside the knowledge store. |
| `CARDLOOM_TELEMETRY_SAMPLES` | off | `1` or `true` also records the text of searches that found no direct answer. A separate opt-in; read the warning under [Knowledge gaps](#knowledge-gaps). |
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

Search results stay compact and do not carry `source`: adding repo, commit and approval date to every result
raised the estimated response size by about 17% at limit 5. `get_card` returns it for the one card you read:
`source: { repo, commit, approved_at }`. `repo` is the card's `source_repo`, else the first `applies_to` entry when that looks like `owner/name` (a guess; component
names such as `api` give `null`);
`commit` is the sha found in `source_commit`, shortened to 7 characters; `approved_at` is the date part of
`last_verified` (`null` for a draft). Each field is `null` when it is unknown.

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

## Session context

`npx cardloom-mcp context` prints a short list of the verified cards that matter for the project you are
standing in, so an agent starts a session already knowing them. It is meant for a Claude Code `SessionStart`
hook, whose output is added to the session. It is **opt-in**: nothing registers it unless you do.

What it prints (nothing else, and nothing at all when the list would be empty):

```text
# Cardloom: verified cards for acme/billing-api
- Retry payments at most twice (pattern-payment-retry): Retry a payment request at most twice, then surface the error.
- Lock before writing (gotcha-write-lock): Take the write lock before touching the index.
Use search_knowledge/get_card for details.
```

- **Which cards:** `verified` and `sensitivity: normal` only, and only cards of this project (the `project:` key of
  `.knowledge-map.yaml` in the current directory, or one of its `aliases:`), global cards, and stack-scoped cards
  whose stack intersects the map's `stack:`. Drafts, deprecated, restricted, stale and needs-review cards are never
  printed. Without a `.knowledge-map.yaml` (and without `--project <key>`, which replaces the map) it prints nothing.
- **Order and size:** highest trust first, then most used, then id. At most 5 cards (`--max-cards`) and an
  estimated 800 tokens in total (`--max-estimated-tokens`; the figure is an estimate, characters divided by 4,
  not a tokenizer count). Each summary is the first sentence of the card, at most 160 characters. Cards are dropped
  from the end until the output fits; if not even one fits, nothing is printed.
- **Read-only:** it opens the existing index (`INDEX_DB_PATH`, `~/.cardloom/index.db` by default) for reading and
  never builds, migrates or creates anything, not even the `-wal` files of a WAL index. If the index is missing,
  unreadable or from an older version, or the store is empty, it prints nothing and exits 0, so a session never breaks.
  Start the server once (or run `npm run rebuild-index`) to have an index.

Register it with one command (it prints the plan; add `--yes` to apply):

```bash
npx cardloom-mcp install --hooks          # plan: shows the change to ~/.claude/settings.json
npx cardloom-mcp install --hooks --yes    # applies it
```

`--hooks` alone changes only `~/.claude/settings.json` (Claude Code; codex and gemini have no hook here). The file
is parsed strictly and an invalid one is refused and left untouched; everything else in it, and its indentation, are
kept, and running it again does not add a second entry. To use it together with the normal setup, add `--agent`
(for example `install --agent claude --hooks --yes`). To do it by hand, add this to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "npx -y cardloom-mcp context" }] }
    ]
  }
}
```

Things to know before relying on it:

- **Docker users get no session context.** The hook runs on the host and reads the index at `~/.cardloom/index.db`
  (or `INDEX_DB_PATH`), not the index in the Docker named volume, so with a Docker-only setup it prints nothing.
- **`npx -y cardloom-mcp context` may contact the npm registry on every session start**, which can slow the start of a
  session. For a faster hook, install the package globally (`npm install -g cardloom-mcp`) and register the command
  `cardloom-mcp context` instead. `install --hooks` registers the `npx -y` form, so edit the `command` in
  `~/.claude/settings.json` to switch.
- **`npm run context` from a clone** reads the clone's own `.knowledge-map.yaml` (the current directory) and needs
  `INDEX_DB_PATH` set to the index to read; without it, it prints nothing.

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

Don't re-derive something a `verified` card already answers. When a returned card from another project helps, say which project and commit it came from (`get_card` shows its "source").

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

### Re-confirming old cards

A verified card last verified more than `STALE_THRESHOLD_DAYS` ago is flagged `stale`. If you check it and it is
still right, re-confirm it instead of verifying a new card: `update_card_status(id, "reconfirm")` keeps the card
`verified`, sets `last_verified` to now and writes `verification_method: reconfirmed:<previous method>` (one
prefix, however many times). Nothing else changes: not the status, not `verified_by`, not the usage counters.
It is refused for a card that needs review (refuted `REVIEW_FAILURE_THRESHOLD` times or more): supersede it with
a corrected card instead. From the shell:

```bash
npx cardloom-mcp reconfirm --stale          # list stale cards, oldest first, with id, title, age and a hash (--json for scripts)
npx cardloom-mcp reconfirm --confirm pattern-a@<hash>,gotcha-b@<hash> --by alice
```

`--confirm` re-confirms each `id@hash` it is given and refuses an entry whose card file changed since it was listed
(the hash is checked under the write lock), has an unknown id, or needs review; the other entries are still applied,
each refusal is printed on stderr and the exit code is 1. `--by` defaults to `REVIEWER_NAME` and is recorded in
the git commit message (`knowledge: reconfirm <id> (by <name>)`), not in the card file; the name is trimmed to one line of at most 80 characters.
Through `update_card_status`, `by` is optional and defaults the same way. From a clone: `npm run reconfirm -- --stale`.

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

### Reading the report

`npx cardloom-mcp report` shows what the store did in the last 7 days (`--days <n>` for another window, up to 36500, `--json` for
scripts): how many times cards were reported `confirmed`, `refuted` and `neutral`, the five cards confirmed most
often, cards that now need a look, verified cards that go stale within 30 days, and how many drafts are waiting.

```
$ npx cardloom-mcp report
Last 7 days: 3 confirmed · 1 refuted · 1 neutral

Cards that helped most
  pattern-retry-payments · Retry payment requests with backoff (3)

Cards that need a look
  gotcha-old-config

Cards going stale within 30 days
  gotcha-old-config

Drafts waiting: 1 (oldest 0 days)
```

"Cards that need a look" lists cards whose total refutes reached `REVIEW_FAILURE_THRESHOLD` (default 2) and that
were refuted at least once inside the window. "Going stale" means the card's last verification is between
`STALE_THRESHOLD_DAYS` minus 30 days (exclusive) and `STALE_THRESHOLD_DAYS` (default 180, inclusive) old. With no
usage at all in the window it prints `No activity in the last N days.` instead of the counts. The numbers come from
the usage events in `events/*.jsonl` (the same ones that feed the trust counters); the report is read-only, never
creates the store and works without the server running.

### Checking an upgrade

Before bumping a dependency, ask which verified cards it affects. Run this in a repo that has a
[`.knowledge-map.yaml`](#knowledge-mapyaml--giving-the-agent-context-per-repo) whose `stack` lists the tech with a
version (`nextjs@14.2.0`), and pass the version you are moving to:

```
$ npx cardloom-mcp upgrade-check --to nextjs@15.0.0
nextjs 14.2.0 -> 15.0.0

  Stop applying (1)
    pattern-old · Old routing rule

  Start applying (1)
    pattern-new · New caching default

  Apply to both (1)
    pattern-both · Image config applies to both
```

Cards are matched on the card's `version_range` with the same rule search uses for its `drift` flag. Only verified,
non-restricted cards that name the tech in their `stack` and have a `version_range` other than `*` are listed, sorted
by id, at most 20 per list (a list that reached 20 says so). `--to` can be repeated for several techs; a tech that
is not in the map, or that has no version there, is an error naming it. `--json` prints the result as an array of
`{ tech, from, to, stopApplying, startApplying, stillApplying }` with card ids. It reads the card files, changes
nothing, and works without the server running.

### Knowledge gaps

`gaps` answers "what do agents ask that the store cannot answer?". It is built on opt-in local telemetry, which is
**off by default**: with `CARDLOOM_TELEMETRY` unset the server never creates or writes the file.

```
$ CARDLOOM_TELEMETRY=local CARDLOOM_TELEMETRY_SAMPLES=1 npx cardloom-mcp   # in your agent's MCP config env
$ npx cardloom-mcp gaps
5 searches since 2026-11-20T09:12:00.000Z
  answered: 2
  related only: 1
  empty: 2

Questions with no direct answer
  how to rotate the signing key (2)
  retry budget for webhooks (1)
```

What is recorded, one JSON line per `search_knowledge` call: the time (UTC), the tool name, how many results came
back, the outcome (`answered`: at least one direct match; `related_only`: only partial matches; `empty`: nothing),
and the search time in milliseconds. That is all.

What is never recorded: card ids, results or their text, the `context` you pass, repo names. The search text is
recorded only when `CARDLOOM_TELEMETRY_SAMPLES` is `1` or `true`, only for searches that were not `answered`, cut to
200 characters, and left out when the secret scan flags it. The scan catches common credential formats only, and its
patterns are case-sensitive: a lower-case `password: hunter2hunter2` line or a Slack-style `xoxb-...` token is not
caught. It does not remove customer names or internal terms either, which is why the text is a second opt-in.
Turn it on only if you are comfortable with questions typed by an agent being written to your disk.

Where the file lives: `telemetry.jsonl` next to the index (`INDEX_DB_PATH`'s folder: `~/.cardloom` with `npx`, the
`cardloom-metadata` volume in Docker), or exactly where `CARDLOOM_TELEMETRY_PATH` points (an absolute file path; a
relative value is ignored with a note on stderr). It is created with mode 0600 (owner read and write only). The
server refuses to write it inside the knowledge store, which is a git repository you might `git add -A`: if the
resolved path is the store or below it (symlinks are followed), nothing is created, one `[telemetry]` line goes to
stderr per process, and searches are unaffected. That is what happens when `INDEX_DB_PATH` is unset (the index then
sits in `<store>/.metadata`, as with `npm start` and `npm run dev`) and with the example `.env`, whose `INDEX_DB_PATH`
is under the store; set `INDEX_DB_PATH` or `CARDLOOM_TELEMETRY_PATH` outside the store to record. Nothing in trust, flags or ranking reads the file. Lines older than 90 days are
dropped, at most once per UTC day per server process. A failed write never changes a search response; it prints one
`[telemetry]` line on stderr per process at most. `benchmark` never records, even with the switch on.

`npx cardloom-mcp gaps` (or `npm run gaps`) reads the file; `--json` prints the report as JSON. It needs no index or
store and creates nothing. When the resolved path is inside the knowledge store it says `Telemetry is not recorded while the index is inside the knowledge store. Set INDEX_DB_PATH or CARDLOOM_TELEMETRY_PATH outside it.` Without the file it says `No telemetry yet. Set CARDLOOM_TELEMETRY=local to start recording.`
"Questions with no direct answer" lists the unanswered texts (lower-cased, whitespace collapsed, same text grouped)
by count, at most 10; when no line carries text it says search text is not recorded and how to turn it on.

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

## Evaluating

The benchmark above measures retrieval. Whether an agent actually answers tasks better with cardloom is a
separate question, and the repository carries a maintainer-run harness for it under
[`eval/README.md`](https://github.com/bangca85/cardloom-mcp/blob/main/eval/README.md): three modes (top-5 search only,
search then `get_card`, all eligible cards in the prompt), a rubric per task, and a dry run by default because a real run
calls a paid model. It is not part of the npm package and never runs in CI. No number from its 8-task seed set is a claim
about cardloom; a number may be quoted only with its raw table and task count.

## Commands

```bash
npm run build          # tsc
npm run dev            # tsx watch src/index.ts (runs on the host, no Docker)
npm test                # vitest run
npm run rebuild-index   # rebuild index.db from cards/ + events/
npm run benchmark       # measure top-1 hit rate + latency against benchmark/queries.yaml
npm run doctor          # read-only store health check (path, git, card counts by status)
npm run triage-drafts   # read-only: drafts with the cards to compare them with
npm run upgrade-check -- --to nextjs@15.0.0   # read-only: cards affected by a version change (needs .knowledge-map.yaml in the cwd)
npm run report          # read-only: what the store did in the last 7 days (--days <n>, --json)
npm run reconfirm -- --stale   # list stale verified cards; --confirm <id>@<hash> re-confirms them
npm run gaps            # read-only: how searches ended and what found no answer (needs CARDLOOM_TELEMETRY=local, --json)
npm run context         # read-only: verified cards of the current project, for a SessionStart hook (see Session context)
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
`upgrade-check` lists the cards that stop or start applying when a dependency version changes, and `report` shows what
the store did in recent days. A human can re-confirm old cards in bulk with `reconfirm`, without re-reviewing each one from
scratch. An opt-in `SessionStart` hook can print a few verified cards at the start of a session.
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
