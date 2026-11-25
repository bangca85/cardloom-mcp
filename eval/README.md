# Agent-level eval (maintainer-run)

The benchmark (`npm run benchmark`) measures whether search ranks the right card first. This harness measures the
question that matters to a user: does an **agent** answer a task better with cardloom, and at what token cost?

It is run by a maintainer, by hand. It never runs in CI and it is not part of the npm package (`package.json` `files` is
an allowlist and does not include `eval/`; a test asserts that).

## Safe by default: a dry run

```bash
npm run eval                      # prints the plan, calls nothing, exits 0
npm run eval -- --runs 5          # same, with another run count
```

A real run needs all three of: `--confirm-spend`, `ANTHROPIC_API_KEY`, `EVAL_MODEL`.

```bash
ANTHROPIC_API_KEY=... EVAL_MODEL=<a model id you choose> npm run eval -- --confirm-spend
```

`--confirm-spend` without the key or the model exits 1 and runs nothing. No default model id is hard-coded: you pick
the model, and you should use the same one for every comparison you intend to publish.

### Cost warning

The plan line is `tasks × modes × runs = N model runs`, for example `8 tasks × 3 modes × 3 runs = 72 model runs`.
Every model run can be several API requests: one per tool-use turn, with at most 8 tool calls (so up to 9 requests), and
`read_all` puts every eligible card in each prompt. The harness assumes **no price**. Look up your model's current pricing
and multiply before you pass `--confirm-spend`. Tokens in the results are the API `usage` fields (input + output, summed
over the tool loop), never an estimate.

## Options

| Option | Meaning |
| --- | --- |
| `--confirm-spend` | Call the model for real. Without it: dry run. |
| `--runs N` | Runs per (task, mode). Default 3. |
| `--modes a,b,c` | Any of `top5`, `search_then_get`, `read_all`. Default all three. |
| `--compact-pair` | The G5 pair: `search_then_get` twice, `get_card` full vs `compact: true`. Replaces `--modes`. |
| `--out <dir>` | Results directory. Default `eval/results/` (git-ignored). |

## Modes

All modes use the same model, the same tasks and the same read permissions: default search visibility (verified,
normal sensitivity; the `include_drafts`, `include_deprecated` and `include_restricted` overrides are removed from the
tool schemas and ignored), and `search_knowledge` is always limited to 5 results.

| Mode | What the agent gets |
| --- | --- |
| `top5` | Only `search_knowledge` (limit 5). `get_card` is rejected. |
| `search_then_get` | `search_knowledge` (limit 5) and `get_card`. |
| `read_all` | No tools. The prompt contains every eligible card of the repo: verified, normal sensitivity, and either a card of that project, a global card, or a stack card sharing a stack tag with the repo. |

The tool definitions (names, descriptions, schemas) are read from the real server through an in-memory MCP client, and
tool calls run the real `handleSearchKnowledge` / `handleGetCard` handlers against the synthetic card store, so the agent
sees exactly what a real client would. Tool-use turns are capped at 8 tool calls per run; a run that hits the cap stops
with the text so far and is marked `capped`.

## Metrics

Per mode (or per variant in a compact pair):

- **pass rate**: share of runs whose answer passes every rubric item. A rubric item has `must_include` substrings (all
  required, case-insensitive) and `must_not_include` substrings (none allowed). These are coarse substring checks:
  they catch a missing identifier or a repeated wrong value, not a subtly wrong explanation.
- **mean tokens**: mean of input + output tokens per run, from the API.
- **p95 latency**: nearest-rank 95th percentile of wall-clock milliseconds per run.
- **wrongOnRelatedOnly**: failed runs where every search result the agent saw was labelled `match: related` (so it only
  had leads, not answers) and it still failed the rubric. This is the cost of a weak match being treated as an answer.
- **errors**: runs where the API call failed. They are listed but excluded from the numbers above.

The compact pair adds **rubric failures**, **re-fetch calls** (a `get_card` for a card already fetched in the same run,
typically the full card after a compact one) and **re-fetch chars** (characters returned by those re-fetches). Characters,
not tokens: the API does not attribute tokens to individual tool results and this harness does not estimate them.
Compare total tokens and pass rate between the two rows; adopt `compact` only if tokens drop at equal pass rate.

## Seed tasks

`eval/tasks/tasks.yaml` holds **8 seed tasks** over two tiny synthetic repos (`eval/fixtures/repos/`) and a small
synthetic card store (`eval/fixtures/store/`). No company or personal data. They cover: a verified decision, a verified
pattern, a verified gotcha, a gotcha whose exception sits after the first 600 characters (a compact fetch cannot see it),
a question where only `related` cards exist (the right answer is "no direct answer"), a superseded card (the answer must
follow the replacement), a draft that contradicts a verified card (the answer must follow the verified one), and a stack
card shared by both repos.

**Eight tasks is a smoke test.** Extend the set to 20-30 tasks, with required cards and exceptions labelled, before you
draw any conclusion from it. Note the draft and superseded tasks pin the default visibility (the hidden cards are not
offered), so they check that the agent is not misled when the product does its job.

Fixture dates: the cards are `last_verified: 2026-11-01`, so they are flagged `stale` from 2027-04-30 (180 days). Do not
compare runs made on either side of that date.

## Reading the results

Each real run writes `eval/results/<timestamp>.json` (git-ignored) and prints a table. The JSON has the model, task
count, runs per cell, one `summaries` row per mode or variant, and every individual run: answer, failed rubric items,
tokens, tool calls, latency, the `match` labels and card ids the agent saw, and whether it was capped or errored. When a
number surprises you, read the individual answers before trusting it. The API key is never written to the file.

## The claim rule

The main README may cite a number from this harness only together with the raw table it came from and the task count.
No number from the 8-task seed set is a claim: it is a smoke test of the harness. Until a 20-30 task set has been run with a
named model and the raw table is published, do not write that agents finish tasks better, or use fewer tokens, with
cardloom.

## Type-checking

`eval/` is outside the main `tsconfig.json` (so it is never built into `dist/`). `npm run typecheck:eval` checks `src/`,
`eval/` and `tests/eval/` together with `tsc -p tsconfig.eval.json --noEmit`.
