import type Database from 'better-sqlite3';
import { facetsIntersect, versionRangesIntersect, arraysIntersect, type FacetSet } from '../utils/facets-intersect.js';
import { computeTrust } from './trust-service.js';
import { computeCardLabels, computeCardFlags, type CardLabels } from './card-service.js';
import { daysSince } from '../utils/date.js';
import { config } from '../config/env.js';
import type { Card } from '../types/card-schema.js';

export interface SearchContext {
  stack?: string[];
  versions?: Record<string, string>;
}

export interface SearchOptions {
  context?: SearchContext;
  includeDrafts?: boolean;
  includeDeprecated?: boolean;
  includeRestricted?: boolean;
  limit?: number;
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
  version_range: string;
  sensitivity: 'normal' | 'restricted';
  last_verified: string | null;
  deprecation_reason: string | null;
  body: string;
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

  const escapedQuery = buildFtsQuery(query);

  const rows = db
    .prepare(
      `
      SELECT
        cards.id, cards.type, cards.status, cards.title, cards.domain, cards.stack, cards.applies_to,
        cards.task_type, cards.error_signature, cards.scope, cards.version_range, cards.sensitivity,
        cards.last_verified, cards.deprecation_reason, cards.body,
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
    .all({ query: escapedQuery }) as CardRow[];

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
      preview: row.body.slice(0, 200),
      flags,
      ...labels,
    };

    return { item, facetMatch, ftsRank: row.fts_rank };
  });

  results.sort((a, b) => {
    if (a.facetMatch !== b.facetMatch) return a.facetMatch ? -1 : 1;
    if (a.ftsRank !== b.ftsRank) return a.ftsRank - b.ftsRank;
    return b.item.trust - a.item.trust;
  });

  const limit = opts.limit !== undefined && opts.limit > 0 ? opts.limit : 10;
  return results.slice(0, limit).map((r) => r.item);
}
