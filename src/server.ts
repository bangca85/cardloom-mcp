import fs from 'node:fs';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { config } from './config/env.js';
import { WRITE_BACK_REMINDER } from './config/messages.js';
import { getDatabase } from './db/database.js';
import { initKnowledgeStore } from './services/knowledge-store.js';
import { reconcileIndex } from './services/index-reconciler.js';
import { renderCard } from './services/card-service.js';
import { handleSaveLearningDraft } from './tools/save-learning-draft.js';
import { handleSearchKnowledge } from './tools/search-knowledge.js';
import { handleGetCard } from './tools/get-card.js';
import { handleReportCardUsage } from './tools/report-card-usage.js';
import { handleUpdateCardStatus } from './tools/update-card-status.js';
import { buildDistillProjectKnowledgePrompt } from './prompts/distill-project-knowledge.js';
import { CARD_TYPES, CARD_SCOPES, CARD_SENSITIVITIES, CARD_DOMAINS } from './types/card-schema.js';
import { KnowledgeError } from './types/errors.js';

export interface ErrorBody {
  error: {
    code?: string;
    message: string;
    details?: unknown;
  };
}

export function mcpError(err: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  let body: ErrorBody;

  if (err instanceof KnowledgeError) {
    body = { error: { code: err.code, message: err.message } };
    if (err.details !== undefined) {
      body.error.details = err.details;
    }
  } else {
    console.error('[server] unhandled:', err);
    body = { error: { message: 'Internal server error' } };
  }

  return { content: [{ type: 'text' as const, text: JSON.stringify(body) }], isError: true as const };
}

/** Wraps a tool handler so every catch site maps errors through the same boundary (AD-7). */
export function withErrorBoundary<Args extends unknown[], R>(
  handler: (...args: Args) => R | Promise<R>,
): (...args: Args) => Promise<R | ReturnType<typeof mcpError>> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (err) {
      return mcpError(err);
    }
  };
}

// The version clients see is the package version, read once from package.json (it sits one level above
// both src/ and dist/, and is always part of the published package), so the two can never drift apart.
const PACKAGE_VERSION: string = (
  JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version: string }
).version;

export function createServer(db: Database.Database, knowledgeStorePath: string): McpServer {
  const server = new McpServer({
    name: 'cardloom-knowledge',
    version: PACKAGE_VERSION,
  });

  server.registerTool(
    'save_learning_draft',
    {
      title: 'Save Learning Draft',
      description:
        'Save a new knowledge card. Cards from an agent always start in status "draft" — verification is a separate, later action.',
      inputSchema: {
        title: z.string().describe('Card title (combined with type to derive the immutable card id)'),
        type: z.enum(CARD_TYPES).describe('Card type'),
        scope: z.enum(CARD_SCOPES).describe('Applicability scope'),
        applies_to: z.array(z.string()).describe('Project/target identifiers this card applies to'),
        stack: z.array(z.string()).describe('Tech stack tags this card applies to'),
        version_range: z.string().describe('Semver range this card applies to'),
        body: z
          .string()
          .describe(
            'Card body in GitHub-flavored Markdown — never continuous prose. Break it into `##` sections (adapt names to the card type, e.g. Context/Decision/Why for a decision, or Symptom/Root Cause/Fix for a gotcha), each a short paragraph or bullet list. Use `> Note: ...` blockquote lines for caveats or exceptions worth flagging separately. For any technical detail (a type/interface, function signature, config shape, API/CLI call), include a real snippet in a fenced ```lang code block — do not just name it inline and describe it in prose; reserve single backticks for short identifiers with no snippet to show. This keeps rendering scannable across the web viewer, search snippets, and get_card output.',
          ),
        domain: z.enum(CARD_DOMAINS).optional().describe('Optional domain facet'),
        task_type: z.string().optional().describe('Optional task-type facet'),
        error_signature: z.string().optional().describe('Required (non-empty) when type is "gotcha"'),
        supersedes: z
          .string()
          .optional()
          .describe('Id of an existing card this one supersedes — recorded as a pending marker only; the old card is left unchanged'),
        conflicts_with: z.array(z.string()).optional().describe('Ids explicitly declared as conflicting with this card'),
        sensitivity: z.enum(CARD_SENSITIVITIES).optional().describe('Defaults to "normal"'),
        source_commit: z
          .string()
          .describe(
            'Commit this learning came from: a bare sha (7-40 hex), nothing else, when there is one. Free text here ("working tree", "local changes") means merge promotion can never verify the card.',
          ),
        source_repo: z
          .string()
          .optional()
          .describe(
            'GitHub "owner/name" of the repo source_commit belongs to. Set it whenever source_commit is a sha: it is how merge promotion finds the commit and checks it reached the default branch.',
          ),
        project: z
          .string()
          .optional()
          .describe(
            'Project key from the repo\'s .knowledge-map.yaml, e.g. "acme/billing-api". Only for scope "project" cards; lowercased and trimmed on save, and a filesystem path is rejected.',
          ),
        provenance: z.string().describe('How this learning was derived'),
      },
    },
    withErrorBoundary((args) => handleSaveLearningDraft(db, knowledgeStorePath, args)),
  );

  server.registerTool(
    'search_knowledge',
    {
      title: 'Search Knowledge',
      description:
        'Search knowledge cards by keyword or verbatim error message. Pass `context` (stack + versions read from your .knowledge-map.yaml) so results rank by facet relevance, not just text match; also pass `project` (and `aliases`) from the same file in `context`. Each result has a `match` label; `match: "related"` or `no_direct_match: true` means only partial matches were found, so use them as leads, not answers, and a `hint` appears when the store has no verified cards. Returns compact snippets only, never full card bodies. Every response carries a write_back_reminder: after using a returned card you MUST call report_card_usage(id, outcome).',
      inputSchema: {
        query: z.string().describe('Search query — keywords or a verbatim error message'),
        context: z
          .object({
            stack: z.array(z.string()).optional().describe('Tech stack tags of the calling repo'),
            versions: z.record(z.string(), z.string()).optional().describe('Stack tag -> version range the calling repo is on'),
            project: z.string().optional().describe('Project key from .knowledge-map.yaml (project:, or repo: in older maps)'),
            aliases: z.array(z.string()).optional().describe('Other names this project has had in existing cards'),
          })
          .optional()
          .describe('Caller repo context — read by the agent/client from .knowledge-map.yaml, the server does not read it itself'),
        include_drafts: z.boolean().optional().describe('Include draft cards (labeled untrusted)'),
        include_deprecated: z.boolean().optional().describe('Include deprecated cards'),
        include_restricted: z.boolean().optional().describe('Include sensitivity:restricted cards'),
        limit: z.number().optional().describe('Max results (default 10)'),
      },
    },
    withErrorBoundary((args) => handleSearchKnowledge(db, args)),
  );

  server.registerTool(
    'get_card',
    {
      title: 'Get Card',
      description:
        'Read a single knowledge card by id — full metadata, body, trust, and status labels (draft -> untrusted, deprecated -> deprecated + reason, restricted -> restricted). Same content as the knowledge://card/{id} Resource. "replacement.pending": a draft proposes to replace this card; it is still the current answer, tell the user. "replacement.superseded_by": read that card instead. Every response carries a write_back_reminder: after using this card you MUST call report_card_usage(id, outcome).',
      inputSchema: {
        id: z.string().describe('Card id, e.g. "pattern-use-x-pattern"'),
      },
    },
    withErrorBoundary((args) => handleGetCard(db, args)),
  );

  server.registerTool(
    'report_card_usage',
    {
      title: 'Report Card Usage',
      description:
        'Report the outcome of using a card you got from search_knowledge or get_card. This is mandatory: every card you use, you MUST report back with confirmed (it worked), refuted (it was wrong/outdated), or neutral (inconclusive). This is how trust scores and needs_review flags stay accurate.',
      inputSchema: {
        id: z.string().describe('Card id'),
        // Intentionally a loose string, not z.enum — an invalid value must reach our own
        // validation_error contract (AD-7) instead of the SDK's generic InvalidParams error.
        outcome: z.string().describe('One of: confirmed, refuted, neutral'),
        repo: z.string().optional().describe('Optional identifier for the repo this usage happened in'),
      },
    },
    withErrorBoundary((args) => handleReportCardUsage(db, knowledgeStorePath, args)),
  );

  server.registerTool(
    'update_card_status',
    {
      title: 'Update Card Status',
      description:
        'Change a card\'s status. action="verify" (draft -> verified, only after a human reviewer approves it) or action="deprecate" (draft/verified -> deprecated, requires reason; the file is kept, never deleted — FR3). deprecated is terminal, there is no un-deprecate. When deprecating a draft because the learning is wrong, a duplicate or not worth keeping, start the reason with "rejected:". Any other transition returns invalid_transition with the valid options.',
      inputSchema: {
        id: z.string().describe('Card id'),
        // Loose string, not z.enum, for the same reason as report_card_usage's outcome field —
        // an unrecognized action must map to our own invalid_transition contract (AD-7/AD-9).
        action: z.string().describe('One of: verify, deprecate'),
        reason: z.string().optional().describe('Required when action is "deprecate"'),
        by: z.string().optional().describe('Who performed this action — defaults to REVIEWER_NAME or "human-reviewer"'),
        verification_method: z
          .string()
          .optional()
          .describe(
            'How the card was verified, for action "verify" — defaults to "chat-approval". When approving a candidate from `npm run promote-merged`, pass the evidence it printed (e.g. "merged:owner/repo@sha+chat-approval").',
          ),
      },
    },
    withErrorBoundary((args) => handleUpdateCardStatus(db, knowledgeStorePath, args)),
  );

  server.registerResource(
    'card',
    new ResourceTemplate('knowledge://card/{id}', { list: undefined }),
    {
      title: 'Knowledge Card',
      description: 'Read a single knowledge card by id — identical content to the get_card tool.',
    },
    (uri, variables) => {
      try {
        const rawId = variables['id'];
        const id = Array.isArray(rawId) ? rawId[0] : rawId;
        const card = renderCard(db, id ?? '');

        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify({ card, write_back_reminder: WRITE_BACK_REMINDER }),
            },
          ],
        };
      } catch (err) {
        // Resources have no isError envelope like tools do — log here, then let the SDK
        // turn the throw into a standard JSON-RPC resource error.
        console.error('[server] resource knowledge://card read failed:', err);
        throw err;
      }
    },
  );

  server.registerPrompt(
    'distill_project_knowledge',
    {
      title: 'Distill Project Knowledge',
      description:
        'Instructs the calling agent to read this project\'s docs, architecture decisions, git history, and story debug logs, then distill them into draft knowledge cards via save_learning_draft.',
      argsSchema: {
        project_path: z.string().optional().describe('Absolute path to the project to distill (defaults to the current working directory)'),
      },
    },
    (args) => buildDistillProjectKnowledgePrompt(args),
  );

  return server;
}

export async function startServer(): Promise<void> {
  // Initialize knowledge store (dirs + git)
  await initKnowledgeStore(config.knowledgeStorePath);

  // Initialize SQLite database
  const db = getDatabase(config.indexDbPath);
  console.error(`SQLite database ready at ${config.indexDbPath}`);

  // Reconcile index with files on disk
  await reconcileIndex(db, config.knowledgeStorePath);

  const server = createServer(db, config.knowledgeStorePath);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('cardloom-knowledge MCP server started on stdio');
}
