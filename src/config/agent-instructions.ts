// The instruction block `cardloom-mcp install` writes to each agent's global instructions file.
// It is the README block under "Enforcing usage" verbatim; tests/config/agent-instructions.test.ts fails if
// the two drift apart, so edit both together.
export const AGENT_INSTRUCTIONS = `## Knowledge Hub (MCP \`cardloom\`) — required

**Before answering/implementing a task touching a known domain** (auth, rate-limiting,
third-party API contracts, infra gotchas, etc.): call \`search_knowledge(query, context)\` first,
with \`context\` read from \`.knowledge-map.yaml\` at this repo's root (\`stack\`, \`versions\`, and
\`project\` / \`aliases\` so results are labelled for this repo). A result with \`match: related\`,
or a response with \`no_direct_match: true\`, is a partial match: use it as a lead for another search, not as an answer.
**If that file doesn't exist yet**, generate a draft yourself before proceeding — inspect this
repo's manifest (package.json / pubspec.yaml / go.mod / requirements.txt, lockfiles) for the
real stack + versions, write it in this shape, then ask the human to review before you rely on it:

\`\`\`yaml
# .knowledge-map.yaml — repo root, human-reviewed after you draft it
project: <owner/repo-name>
aliases: []   # optional: other names this project has had in existing cards
stack:
  - <tech>@<version>
  - <tech>@<version>
domain: <frontend|backend|infra|product|...>
\`\`\`

Don't re-derive something a \`verified\` card already answers.

**After using a returned card — you MUST call \`report_card_usage(id, outcome)\`**
(\`confirmed\`/\`refuted\`/\`neutral\`). This is not optional — every search/get_card response carries
a \`write_back_reminder\`; skipping it lets trust scores and \`needs_review\` flags drift stale.

**Learned something new** (a decision, pattern, or gotcha with no existing card, or a refinement
of an existing one) → call \`save_learning_draft\`. It always lands as \`draft\` — never verify it
yourself. Put a bare commit sha in \`source_commit\` and the repo's GitHub \`owner/name\` in
\`source_repo\` whenever the learning comes from a commit: that is what lets merge promotion find
it. Free text there ("working tree", "local changes") means the card can only ever be approved by hand.

**Found a major mismatch between a \`verified\` card and current reality** (the card says A, the
code/logs/API actually do B — a real contradiction, not a nuance): **stop, don't silently trust
either side.** Lay out:

- which card, what it currently claims (\`id\` + summary)
- what you actually observed (specific file/log/response)
- the two possible resolutions: the card is stale/wrong → deprecate it + save a new card with
  \`supersedes\`, or the code is the regression → fix the code and leave the card as-is

then ask for confirmation on which direction before calling \`update_card_status\` or
\`save_learning_draft(supersedes=...)\`. Don't decide alone when the mismatch affects an
architecture or security call.`;
