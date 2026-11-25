import type Database from 'better-sqlite3';
import {
  facetsIntersect,
  versionRangesIntersect,
  arraysIntersect,
  classifyScopeLayer,
  type FacetSet,
  type ScopeLayer,
} from '../utils/facets-intersect.js';
import { classifyMatch, TIER_RANK, type MatchTier } from '../utils/match-tier.js';
import { computeTrust } from './trust-service.js';
import { computeCardLabels, computeCardFlags, type CardLabels } from './card-service.js';
import { daysSince } from '../utils/date.js';
import { config } from '../config/env.js';
import type { Card } from '../types/card-schema.js';

export type SearchRanking = 'baseline' | 'x' | 'y';
export type SearchFallback = 'off' | 'tiered';

/**
 * Results returned when the caller gives no `limit` (also the tiered-fallback threshold). 5 since 2026-11-25
 * (was 10): measured on the reviewed benchmark set, 5 loses no recall and roughly halves the response size.
 */
export const DEFAULT_SEARCH_LIMIT = 5;

export interface SearchContext {
  stack?: string[];
  versions?: Record<string, string>;
  /** Caller's project key; enables scope layers. Never used to hide cards, only to rank/label them. */
  project?: string;
  aliases?: string[];
}

export interface SearchOptions {
  context?: SearchContext;
  includeDrafts?: boolean;
  includeDeprecated?: boolean;
  includeRestricted?: boolean;
  limit?: number;
  /** Overrides config.searchRanking (used by the benchmark). */
  ranking?: SearchRanking;
  /** Overrides config.searchFallback (used by the benchmark). */
  fallback?: SearchFallback;
}

export interface SearchResultFlags {
  drift?: boolean;
  stale?: boolean;
  needs_review?: boolean;
}

export interface SearchResultItem extends CardLabels {
  id: string;
  type: string;
  title: string;
  status: Card['status'];
  domain: string | null;
  stack: string[];
  applies_to: string[];
  task_type: string | null;
  error_signature: string | null;
  version_range: string;
  trust: number;
  preview: string;
  /** FTS5 snippet of the body around the hit; falls back to `preview` when empty. */
  excerpt: string;
  match: MatchTier;
  scope_layer: ScopeLayer | null;
  /** The card's own project key (scope: project cards only), else null. */
  project: string | null;
  flags: SearchResultFlags;
}

interface CardRow {
  id: string;
  type: string;
  status: Card['status'];
  title: string;
  domain: string | null;
  stack: string;
  applies_to: string;
  task_type: string | null;
  error_signature: string | null;
  scope: FacetSet['scope'];
  project: string | null;
  version_range: string;
  sensitivity: 'normal' | 'restricted';
  last_verified: string | null;
  deprecation_reason: string | null;
  body: string;
  excerpt: string | null;
  fts_rank: number;
  usage: number;
  success: number;
  failure: number;
}

// Quote each token individually so FTS5 syntax characters in the raw query (colons, parens, etc. —
// common in pasted error messages) can't be parsed as query operators, while preserving normal
// "all these words, any order" AND semantics (a single wrapping phrase-quote would force exact order).
function buildFtsQuery(rawQuery: string): string {
  return rawQuery
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(' ');
}

// OR query for the tiered fallback: every run of non-letter/non-digit chars becomes a separator, so
// no FTS5 syntax survives. Returns null when nothing searchable is left (e.g. `***`, `-`).
function buildOrFtsQuery(rawQuery: string): string | null {
  const tokens = rawQuery
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token}"`).join(' OR ');
}

function runFtsQuery(db: Database.Database, ftsQuery: string, statusList: string, sensitivityClause: string): CardRow[] {
  return db
    .prepare(
      `
      SELECT
        cards.id, cards.type, cards.status, cards.title, cards.domain, cards.stack, cards.applies_to,
        cards.task_type, cards.error_signature, cards.scope, cards.project, cards.version_range, cards.sensitivity,
        cards.last_verified, cards.deprecation_reason, cards.body,
        snippet(cards_fts, 1, '', '', '…', 16) as excerpt,
        cards_fts.rank as fts_rank,
        COALESCE(counters.usage, 0) as usage,
        COALESCE(counters.success, 0) as success,
        COALESCE(counters.failure, 0) as failure
      FROM cards_fts
      JOIN cards ON cards.rowid = cards_fts.rowid
      LEFT JOIN counters ON counters.card_id = cards.id
      WHERE cards_fts MATCH @query
        AND cards.status IN (${statusList})
        ${sensitivityClause}
      `,
    )
    .all({ query: ftsQuery }) as CardRow[];
}

// Only genuine FTS5 query-syntax errors. SQLITE_ERROR alone is SQLite's generic code (it also covers
// `no such table`, schema drift, ...), so the message must match too; anything else is rethrown.
const FTS_SYNTAX_ERROR = /fts5: syntax error|unterminated string|malformed MATCH/i;

// Tiered mode only: an FTS5 syntax error is treated as "no results" instead of escaping to the caller.
function runFtsQuerySafe(db: Database.Database, ftsQuery: string, statusList: string, sensitivityClause: string): CardRow[] {
  try {
    return runFtsQuery(db, ftsQuery, statusList, sensitivityClause);
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if ((err as { code?: unknown }).code === 'SQLITE_ERROR' && FTS_SYNTAX_ERROR.test(message)) {
      console.error(`[search-service] FTS query rejected, treating as no results: ${message}`);
      return [];
    }
    throw err;
  }
}

/**
 * Scope rank for ranking modes x/y (lower first). Without a caller project, scope layers are
 * unknown, so only facetMatch counts. Any drift drops a card to the last band. A shared card
 * ranks 1 when the caller gave no stack (facetMatch is then false for every card) or its facets
 * match (controller ruling R8), so global/stack guidance never falls below other projects' cards.
 */
function computeScopeRank(layer: ScopeLayer | null, facetMatch: boolean, drift: boolean, callerHasStack: boolean): number {
  if (layer === null) return facetMatch ? 1 : 3;
  if (drift) return 3;
  if (layer === 'this_project') return 0;
  if (layer === 'shared' && (!callerHasStack || facetMatch)) return 1;
  if (layer === 'other_project' || layer === 'unknown') return 2;
  return 3;
}

function computeDrift(card: CardRow, context?: SearchContext): boolean {
  if (card.status !== 'verified' || !context?.stack || !context.versions) return false;

  let cardStack: string[];
  try {
    const parsed = JSON.parse(card.stack);
    cardStack = Array.isArray(parsed) ? parsed : [];
  } catch {
    return false;
  }

  const relevantTags = cardStack.filter((tag) => {
    const norm = tag.toLowerCase().replace(/\s+/g, '-');
    return context.stack!.includes(norm) && context.versions![norm] !== undefined;
  });

  if (relevantTags.length === 0) return false;

  return relevantTags.some((tag) => {
    const norm = tag.toLowerCase().replace(/\s+/g, '-');
    return !versionRangesIntersect(card.version_range, context.versions![norm]);
  });
}

/** True when the index holds at least one verified card (used to explain an empty store). */
export function hasVerifiedCards(db: Database.Database): boolean {
  return db.prepare("SELECT 1 FROM cards WHERE status = 'verified' LIMIT 1").get() !== undefined;
}

export function searchCards(db: Database.Database, query: string, opts: SearchOptions = {}, now: Date = new Date()): SearchResultItem[] {
  if (typeof query !== 'string' || !query.trim()) {
    return [];
  }

  const normalizedContext: SearchContext = {
    stack: opts.context?.stack?.map((t) => t.toLowerCase().replace(/\s+/g, '-')) ?? [],
    versions: opts.context?.versions
      ? Object.fromEntries(
          Object.entries(opts.context.versions).map(([k, v]) => [
            k.toLowerCase().replace(/\s+/g, '-'),
            v,
          ]),
        )
      : {},
  };

  const statuses = ['verified'];
  if (opts.includeDrafts) statuses.push('draft');
  if (opts.includeDeprecated) statuses.push('deprecated');
  const statusList = statuses.map((s) => `'${s}'`).join(', ');

  const sensitivityClause = opts.includeRestricted ? '' : "AND cards.sensitivity = 'normal'";

  const ranking: SearchRanking = opts.ranking ?? config.searchRanking;
  const fallback: SearchFallback = opts.fallback ?? config.searchFallback;
  const limit = opts.limit !== undefined && opts.limit > 0 ? opts.limit : DEFAULT_SEARCH_LIMIT;

  const andQuery = buildFtsQuery(query);

  let rows: CardRow[];
  let allTermsIds: Set<string>;
  if (fallback === 'tiered') {
    const orQuery = buildOrFtsQuery(query);
    if (orQuery === null) return [];
    const andRows = runFtsQuerySafe(db, andQuery, statusList, sensitivityClause);
    allTermsIds = new Set(andRows.map((row) => row.id));
    rows = andRows.length >= limit ? andRows : runFtsQuerySafe(db, orQuery, statusList, sensitivityClause);
  } else {
    rows = runFtsQuery(db, andQuery, statusList, sensitivityClause);
    allTermsIds = new Set(rows.map((row) => row.id));
  }

  const caller = { project: opts.context?.project, aliases: opts.context?.aliases };

  const contextFacets: FacetSet = {
    scope: 'global',
    stack: normalizedContext.stack ?? [],
    applies_to: [],
    version_range: '*',
  };

  const results = rows.map((row) => {
    let stack: string[] = [];
    let appliesTo: string[] = [];
    try {
      const parsed = JSON.parse(row.stack);
      stack = Array.isArray(parsed) ? parsed : [];
    } catch {}
    try {
      const parsed = JSON.parse(row.applies_to);
      appliesTo = Array.isArray(parsed) ? parsed : [];
    } catch {}

    const cardFacets: FacetSet = {
      scope: row.scope,
      stack,
      applies_to: appliesTo,
      version_range: row.version_range,
    };

    const drift = computeDrift(row, normalizedContext);
    const facetMatch = contextFacets.stack.length > 0 && facetsIntersect(contextFacets, cardFacets) && !drift;

    const scopeLayer = classifyScopeLayer({ scope: row.scope, project: row.project ?? undefined, applies_to: appliesTo }, caller);
    const scopeRank = computeScopeRank(scopeLayer, facetMatch, drift, contextFacets.stack.length > 0);
    const match = classifyMatch(query, { title: row.title, error_signature: row.error_signature }, allTermsIds.has(row.id));

    const trust = computeTrust(
      { status: row.status, lastVerified: row.last_verified, success: row.success, failure: row.failure },
      now,
    );

    const flags: SearchResultFlags = computeCardFlags(
      { last_verified: row.last_verified, failure: row.failure },
      now,
    );
    if (drift) flags.drift = true;

    const labels = computeCardLabels({
      status: row.status,
      sensitivity: row.sensitivity,
      deprecationReason: row.deprecation_reason,
    });

    const preview = row.body.slice(0, 200);
    const item: SearchResultItem = {
      id: row.id,
      type: row.type,
      title: row.title,
      status: row.status,
      domain: row.domain,
      stack,
      applies_to: appliesTo,
      task_type: row.task_type,
      error_signature: row.error_signature,
      version_range: row.version_range,
      trust,
      preview,
      excerpt: row.excerpt ? row.excerpt : preview,
      match,
      scope_layer: scopeLayer,
      project: row.project,
      flags,
      ...labels,
    };

    return { item, facetMatch, ftsRank: row.fts_rank, tierRank: TIER_RANK[match], scopeRank };
  });

  if (ranking === 'baseline') {
    results.sort((a, b) => {
      if (a.facetMatch !== b.facetMatch) return a.facetMatch ? -1 : 1;
      if (a.ftsRank !== b.ftsRank) return a.ftsRank - b.ftsRank;
      return b.item.trust - a.item.trust;
    });
  } else {
    const primary = ranking === 'x' ? 'scopeRank' : 'tierRank';
    const secondary = ranking === 'x' ? 'tierRank' : 'scopeRank';
    results.sort((a, b) => {
      if (a[primary] !== b[primary]) return a[primary] - b[primary];
      if (a[secondary] !== b[secondary]) return a[secondary] - b[secondary];
      if (a.ftsRank !== b.ftsRank) return a.ftsRank - b.ftsRank;
      return b.item.trust - a.item.trust;
    });
  }

  return results.slice(0, limit).map((r) => r.item);
}
