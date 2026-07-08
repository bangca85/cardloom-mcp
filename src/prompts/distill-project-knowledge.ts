import type { GetPromptResult } from '@modelcontextprotocol/sdk/types.js';

export interface DistillProjectKnowledgeArgs {
  project_path?: string;
}

/**
 * Builds the distillation instructions as an MCP Prompt message. Kept as a pure string
 * builder (no DB/service dependency) so the prompt text can be unit-tested without a server.
 */
export function buildDistillProjectKnowledgePrompt(args: DistillProjectKnowledgeArgs): GetPromptResult {
  const projectPath = args.project_path?.trim() || '(current working directory)';

  const text = `You have access to the "cardloom" MCP knowledge hub. Task: distill this project's technical knowledge into cards.

Project path: ${projectPath}

## Step 1 — Read sources exhaustively

Do not sample — enumerate and go through ALL of the following, not just the top-level summary:

- CLAUDE.md, README, and every file under docs/ or _bmad-output/ in this project.
- Any architecture/design/ADR document with a numbered decision list (e.g. "D1", "D24", "ADR-003", "AD-7") — read the FULL list end to end. A condensed "constraints" section in CLAUDE.md is usually a subset; go to the source document it summarizes and cover every entry, not just the ones quoted there.
- Every story/implementation-artifact file (e.g. docs/implementation-artifacts/*.md) — specifically its "Debug Log References" / "Completion Notes" / "Dev Agent Record" sections. These contain real bugs and fixes that never make it into docs. Go file by file; do not stop after the first handful.
- Any PRD, business/product spec, or requirements doc (why a feature exists, target users, business rules, compliance constraints) — this project may span multiple products/repos, and business logic is exactly the kind of thing that gets forgotten between them. Don't skip these as "not technical."
- git log across the FULL history, not just recent commits — walk it in batches if long. Pull commits whose message signals a real lesson: fix(...), refactor(...) with a stated reason, perf(...), security fixes, revert. Skip mechanical commits (formatting, deps bump, typo).
- If a claude-mem MCP server is available, query its observations/timeline for this project and fold relevant findings in too.

## Step 2 — Distill into cards, do not copy source text verbatim

One card = one opinion/lesson, not one document. Pick the right type:

- **decision**: why X over Y — must include the reason and the trade-off given up. Also use this for business/product rules ("why this product's refund flow works this way") — a business rule with a reason is still a decision, just \`domain: product\` instead of an engineering domain.
- **gotcha**: a recurring error and its fix — MUST include \`error_signature\` (the original error message, as verbatim as you can get it).
- **pattern**: a way of doing something that repeats across the repo and is worth reusing elsewhere.
- **playbook**: a multi-step procedure (deploy, local setup, credential rotation, incident runbook, or a recurring business process).

Skip: anything obvious, anything clearly superseded/dead in the current code, anything too narrow to ever apply outside this exact line of code.

## Step 3 — Before writing anything, report your source survey

List every source you found (files, doc sections, commit ranges, claude-mem query) and an estimated nugget count per source. Do this BEFORE the first \`save_learning_draft\` call, so the human can sanity-check scope up front. If the estimate is low for a project this size, say so and explain why (e.g. "most of this repo is generated code").

## Step 4 — Save each card with real facets

Call \`save_learning_draft\` per card, no placeholders:

- \`type\`: one of decision / gotcha / pattern / playbook
- \`domain\`: frontend / backend / infra / AI / product — pick the one that actually fits; use \`product\` for business rules, feature rationale, and PRD-derived context that isn't tied to one engineering layer
- \`stack\`: real tech tags relevant to this lesson (e.g. ["nextjs", "postgres"])
- \`applies_to\` / \`scope\`: where this actually applies — this project/module by name, or global if it generalizes
- \`version_range\`: the semver range this lesson holds true for
- \`source_commit\`: the specific commit hash if you have one, else the current HEAD
- \`provenance\`: exactly where this came from — file path, doc section, commit hash, or "claude-mem observation <id>"

All cards land in draft. Never call \`update_card_status\` to verify your own card.

## Step 5 — Check for duplicates and staleness before saving

Before saving a card, call \`search_knowledge\` for its topic **with \`include_drafts: true\` and \`include_deprecated: true\`**. Default search only returns \`status: verified\` cards (AD-10) — since every card this workflow produces starts as \`draft\` and stays that way until a human approves it, a default-visibility search will report zero hits even when the exact same lesson already exists as an unapproved draft from an earlier run. A "0 existing cards" result without those flags set is not evidence the hub is empty — rerun the search with both flags before trusting it.

If an existing card (draft, verified, or deprecated) says something close:
- Same lesson, refined/corrected → save the new one with \`supersedes: <old-id>\` instead of a standalone card.
- Duplicate of an unapproved draft → don't save a second copy; surface the existing draft for approval instead.
- Old **verified** card is clearly obsolete and nothing you're adding replaces it → do not silently deprecate it. Ask the human first, naming the specific card id and the concrete reason it's stale.

## Step 6 — Present for approval in batches

Show cards a few at a time in chat, not as one giant dump. Wait for the human's response per batch:
- "approve" → call \`update_card_status(id, "verify")\`.
- "no" / "wrong" → leave it in draft (or discard the content if it's unusable) — do not verify it.

Start now: list the sources you found and the expected nugget count per source before making any \`save_learning_draft\` call.`;

  return {
    description: 'Distill this project\'s technical knowledge (docs, architecture decisions, commit history, story debug logs) into draft knowledge cards for review.',
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text,
        },
      },
    ],
  };
}
