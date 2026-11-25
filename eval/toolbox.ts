import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { parse } from 'yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, mcpError } from '../src/server.js';
import { handleSearchKnowledge, type SearchKnowledgeArgs } from '../src/tools/search-knowledge.js';
import { handleGetCard } from '../src/tools/get-card.js';
import { renderCard } from '../src/services/card-service.js';
import type { SearchContext } from '../src/services/search-service.js';
import type { EvalMode, EvalTask, ToolBox, ToolBoxStats, ToolResult, ToolSpec } from './types.js';

/** Search results per call, in every tool mode. The brief's `top5` is the strictest; the other tool mode matches it. */
export const SEARCH_LIMIT = 5;

const TOOLS_BY_MODE: Record<EvalMode, readonly string[]> = {
  top5: ['search_knowledge'],
  search_then_get: ['search_knowledge', 'get_card'],
  read_all: [],
};

export class ToolNotAllowedError extends Error {
  constructor(
    readonly tool: string,
    readonly mode: EvalMode,
  ) {
    super(`Tool "${tool}" is not available in mode ${mode}. Available: ${TOOLS_BY_MODE[mode].join(', ') || 'none'}.`);
    this.name = 'ToolNotAllowedError';
  }
}

export interface RepoContext {
  project: string;
  /** Stack tags without versions, e.g. `node`. */
  stack: string[];
  versions: Record<string, string>;
  /** As written in the repo's .knowledge-map.yaml, e.g. `node@22`. */
  stackSpecs: string[];
}

/** Reads the `.knowledge-map.yaml` of the fixture repo whose `project` is `repoKey`. */
export function loadRepoContext(repoKey: string, reposDir: string): RepoContext {
  for (const entry of fs.readdirSync(reposDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(reposDir, entry.name, '.knowledge-map.yaml');
    if (!fs.existsSync(file)) continue;
    const map = parse(fs.readFileSync(file, 'utf-8')) as { project?: string; stack?: string[] };
    if (map.project !== repoKey) continue;
    const stackSpecs = map.stack ?? [];
    const versions: Record<string, string> = {};
    const stack = stackSpecs.map((spec) => {
      const [tag, version] = spec.split('@') as [string, string | undefined];
      if (version !== undefined) versions[tag] = /^\d+$/.test(version) ? `${version}.0.0` : version;
      return tag;
    });
    return { project: repoKey, stack, versions, stackSpecs };
  }
  throw new Error(`no fixture repo with project "${repoKey}" under ${reposDir}`);
}

/**
 * The tool definitions of the real server (`search_knowledge`, `get_card`), read through an in-memory MCP client, so
 * the agent sees exactly the names, descriptions and schemas a real client would. The `include_*` visibility
 * overrides are removed: this eval pins every mode to default visibility (verified, normal), see the README.
 */
export async function loadToolSpecs(db: Database.Database, storePath: string): Promise<ToolSpec[]> {
  const server = createServer(db, storePath);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'cardloom-eval', version: '0.0.0' });
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    return tools
      .filter((t) => t.name === 'search_knowledge' || t.name === 'get_card')
      .map((t) => {
        const { $schema: _ignored, ...schema } = t.inputSchema as Record<string, unknown>;
        const properties = Object.fromEntries(Object.entries((schema.properties ?? {}) as Record<string, unknown>).filter(([k]) => !k.startsWith('include_')));
        return { name: t.name, description: t.description ?? '', input_schema: { ...schema, properties } };
      });
  } finally {
    await client.close();
    await server.close();
  }
}

export interface ToolBoxOptions {
  mode: EvalMode;
  context: RepoContext;
  specs: ToolSpec[];
  /** What `get_card` does when the agent does not say: the full body, or `compact: true`. Default `full`. */
  getCardDefault?: 'full' | 'compact';
}

const asRecord = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

const validationError = (message: string): ToolResult => ({
  text: JSON.stringify({ error: { code: 'validation_error', message } }),
  isError: true,
});

export function createToolBox(db: Database.Database, options: ToolBoxOptions): ToolBox {
  const allowed = TOOLS_BY_MODE[options.mode];
  const specs = options.specs.filter((s) => allowed.includes(s.name));
  const stats: ToolBoxStats = { calls: 0, seenMatches: [], seenCards: [], getCardCalls: 0, refetchCalls: 0, refetchChars: 0 };
  const fetched = new Set<string>();
  const seen = new Set<string>();
  const searchContext: SearchContext = { stack: options.context.stack, versions: options.context.versions, project: options.context.project };

  const noteCard = (id: string): void => {
    if (!seen.has(id)) {
      seen.add(id);
      stats.seenCards.push(id);
    }
  };

  return {
    specs,
    stats: () => ({ ...stats, seenMatches: [...stats.seenMatches], seenCards: [...stats.seenCards] }),
    call(name, rawArgs) {
      if (!allowed.includes(name)) throw new ToolNotAllowedError(name, options.mode);
      stats.calls += 1;
      const args = asRecord(rawArgs);

      if (name === 'search_knowledge') {
        if (typeof args.query !== 'string' || args.query.trim() === '') return validationError('query must be a non-empty string');
        // Same read permissions in every mode: default visibility, fixed limit. The context is filled in when the
        // agent leaves it out, as a client that reads .knowledge-map.yaml would.
        const searchArgs: SearchKnowledgeArgs = {
          query: args.query,
          context: (typeof args.context === 'object' && args.context !== null ? args.context : searchContext) as SearchContext,
          limit: SEARCH_LIMIT,
        };
        try {
          const text = handleSearchKnowledge(db, searchArgs, { telemetry: false }).content[0]!.text;
          const parsed = JSON.parse(text) as { results: Array<{ id: string; match: string }> };
          for (const r of parsed.results) {
            stats.seenMatches.push(r.match);
            noteCard(r.id);
          }
          return { text, isError: false };
        } catch (err) {
          return { text: mcpError(err).content[0]!.text, isError: true };
        }
      }

      // get_card
      if (typeof args.id !== 'string' || args.id === '') return validationError('id must be a non-empty string');
      const compact = typeof args.compact === 'boolean' ? args.compact : options.getCardDefault === 'compact';
      stats.getCardCalls += 1;
      try {
        const text = handleGetCard(db, { id: args.id, compact }).content[0]!.text;
        if (fetched.has(args.id)) {
          stats.refetchCalls += 1;
          stats.refetchChars += text.length;
        }
        fetched.add(args.id);
        noteCard(args.id);
        return { text, isError: false };
      } catch (err) {
        return { text: mcpError(err).content[0]!.text, isError: true };
      }
    },
  };
}

/**
 * Ids (sorted) of the cards `read_all` puts in the prompt: default search visibility (verified, normal sensitivity),
 * and relevant to the repo, meaning a project card of the repo, or a global card, or a stack card sharing a stack tag.
 */
export function listEligibleCards(db: Database.Database, context: RepoContext): string[] {
  const rows = db
    .prepare("SELECT id, scope, project, stack FROM cards WHERE status = 'verified' AND sensitivity = 'normal' ORDER BY id")
    .all() as Array<{ id: string; scope: string; project: string | null; stack: string }>;
  return rows
    .filter((r) => {
      if (r.scope === 'project') return r.project === context.project;
      if (r.scope === 'global') return true;
      const tags = JSON.parse(r.stack) as string[];
      return tags.some((t) => context.stack.includes(t));
    })
    .map((r) => r.id);
}

/** One JSON line per card, rendered by the same `renderCard` that serves `get_card` (full body). */
export function renderEligibleCards(db: Database.Database, ids: string[]): string[] {
  return ids.map((id) => JSON.stringify(renderCard(db, id, new Date())));
}

export interface PromptInput {
  task: EvalTask;
  mode: EvalMode;
  context: RepoContext;
  /** read_all only: the rendered eligible cards. */
  cards?: string[];
  getCardDefault?: 'full' | 'compact';
}

export function buildPrompts(input: PromptInput): { system: string; prompt: string } {
  const lines = [
    'You are a coding assistant answering a question about a repository, using a team knowledge base of reviewed cards.',
    'Answer concisely, in a few sentences, and name any identifiers, settings or values the knowledge gives you.',
    'If the knowledge does not contain a direct answer, say that there is no direct answer instead of guessing from loosely related cards.',
    'Cards labelled untrusted or deprecated are not authoritative. Reporting card usage is not part of this exercise.',
  ];
  if (input.mode === 'search_then_get') {
    lines.push(
      input.getCardDefault === 'compact'
        ? 'Read a card with get_card using compact: true first; call get_card again without compact only if the shortened body (truncated: true) is not enough.'
        : 'Read a card in full with get_card when its snippet is not enough.',
    );
  }
  const header = `Repository: ${input.context.project} (stack: ${input.context.stackSpecs.join(', ')})`;
  const parts = [header, `Question: ${input.task.prompt}`];
  if (input.mode === 'read_all') {
    parts.push('', 'All knowledge cards that apply to this repository, one JSON object per line:', ...(input.cards ?? []));
  } else {
    parts.push(
      '',
      `Use the knowledge tools. Pass context {"project":"${input.context.project}","stack":${JSON.stringify(input.context.stack)}} to search_knowledge.`,
    );
  }
  return { system: lines.join('\n'), prompt: parts.join('\n') };
}
