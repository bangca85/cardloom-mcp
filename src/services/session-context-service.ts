import type Database from 'better-sqlite3';
import { facetsIntersect, normalizeProjectKey } from '../utils/facets-intersect.js';
import { estimateToolJsonTokens } from '../utils/token-estimate.js';
import { computeTrust } from './trust-service.js';
import { computeCardFlags, renderCard } from './card-service.js';

export interface ContextCard {
  id: string;
  title: string;
  summary: string;
}

export interface SessionContextOptions {
  project?: string;
  aliases?: string[];
  /** Tech names of the repo's stack; lets `scope: stack` cards that intersect it in. */
  stack?: string[];
  maxCards: number;
  maxEstimatedTokens: number;
  now?: Date;
}

export interface SessionContext {
  cards: ContextCard[];
  text: string;
  estimatedTokens: number;
}

const SUMMARY_MAX = 160;
const empty = (): SessionContext => ({ cards: [], text: '', estimatedTokens: 0 });

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** First sentence of a card body (markdown headings skipped), on one line, at most 160 characters. */
export function summarizeBody(body: string): string {
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const prose = lines.filter((l) => !/^#{1,6}(\s|$)/.test(l));
  const source = prose.length > 0 ? prose : lines.map((l) => l.replace(/^#{1,6}\s*/, ''));
  const text = oneLine(source.join(' '));
  const sentence = /^(.*?[.!?])(?:\s|$)/.exec(text)?.[1] ?? text;
  return sentence.length > SUMMARY_MAX ? `${sentence.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : sentence;
}

interface Row {
  id: string;
  title: string;
  scope: 'project' | 'stack' | 'global';
  project: string | null;
  stack: string;
  applies_to: string;
  version_range: string;
  last_verified: string | null;
  usage: number;
  success: number;
  failure: number;
}

function parseList(json: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : null;
  } catch {
    return null;
  }
}

function format(project: string, cards: ContextCard[]): string {
  return [
    `# Cardloom: verified cards for ${project}`,
    ...cards.map((c) => `- ${c.title} (${c.id}): ${c.summary}`),
    'Use search_knowledge/get_card for details.',
  ].join('\n');
}

/**
 * The verified, normal-sensitivity cards a SessionStart hook prints for one project: its own (project key or
 * an alias), global ones, and stack-scoped ones that intersect `opts.stack` (AD-6, `facetsIntersect`). Ranked
 * by trust, then usage, then id; stale and needs-review cards are skipped (the flags of `computeCardFlags`,
 * as search computes them). The list is cut to `maxCards`, then to the estimated-token budget. Read-only; it
 * throws when the index lacks a column or table it needs (the caller prints nothing then).
 */
export function buildSessionContext(db: Database.Database, opts: SessionContextOptions): SessionContext {
  const now = opts.now ?? new Date();
  const project = typeof opts.project === 'string' ? normalizeProjectKey(opts.project) : '';
  if (project === '' || opts.maxCards <= 0) return empty();

  const keys = new Set<string>([project]);
  for (const alias of opts.aliases ?? []) {
    const key = normalizeProjectKey(alias);
    if (key !== '') keys.add(key);
  }
  const stackWanted = (opts.stack ?? []).length > 0;
  const placeholders = [...keys].map(() => '?').join(', ');

  const rows = db
    .prepare(
      `SELECT cards.id, cards.title, cards.scope, cards.project, cards.stack, cards.applies_to, cards.version_range,
              cards.last_verified,
              COALESCE(counters.usage, 0) AS usage, COALESCE(counters.success, 0) AS success, COALESCE(counters.failure, 0) AS failure
         FROM cards LEFT JOIN counters ON counters.card_id = cards.id
        WHERE cards.status = 'verified' AND cards.sensitivity = 'normal'
          AND (cards.scope = 'global'${stackWanted ? " OR cards.scope = 'stack'" : ''} OR lower(trim(cards.project)) IN (${placeholders}))`,
    )
    .all(...keys) as Row[];

  const caller = { scope: 'stack' as const, stack: opts.stack ?? [], applies_to: [], version_range: '*' };
  const ranked: Array<{ row: Row; trust: number }> = [];
  for (const row of rows) {
    const own = row.project !== null && keys.has(normalizeProjectKey(row.project));
    if (!own && row.scope !== 'global') {
      if (row.scope !== 'stack') continue;
      const stack = parseList(row.stack);
      if (stack === null || !facetsIntersect(caller, { scope: 'stack', stack, applies_to: parseList(row.applies_to) ?? [], version_range: row.version_range })) continue;
    }
    const flags = computeCardFlags({ last_verified: row.last_verified, failure: row.failure }, now);
    if (flags.stale || flags.needs_review) continue;
    ranked.push({ row, trust: computeTrust({ status: 'verified', lastVerified: row.last_verified, success: row.success, failure: row.failure }, now) });
  }
  ranked.sort((a, b) => b.trust - a.trust || b.row.usage - a.row.usage || (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0));

  // The body goes through the one renderer (AD-15), for the few cards that are printed only.
  const cards: ContextCard[] = [];
  for (const { row } of ranked) {
    if (cards.length >= opts.maxCards) break;
    let body: string;
    try {
      body = renderCard(db, row.id, now).body;
    } catch {
      continue;
    }
    cards.push({ id: row.id, title: oneLine(row.title), summary: summarizeBody(body) });
  }

  let text = format(project, cards);
  while (cards.length > 0 && estimateToolJsonTokens(text) > opts.maxEstimatedTokens) {
    cards.pop();
    text = format(project, cards);
  }
  if (cards.length === 0) return empty();
  return { cards, text, estimatedTokens: estimateToolJsonTokens(text) };
}
