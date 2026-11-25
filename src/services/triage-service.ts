import type Database from 'better-sqlite3';
import { facetsIntersect, normalizeProjectKey, type FacetSet } from '../utils/facets-intersect.js';
import { isRejectionReason } from '../utils/rejection.js';
import { jaccard, titleTokens } from '../utils/title-similarity.js';

export interface RelatedEvidence {
  id: string;
  status: 'draft' | 'verified' | 'deprecated';
  title: string;
  /** Rounded to 2 decimals. */
  titleSimilarity: number;
  /** `facetsIntersect(draft, card)`. Reports overlap only; it does not predict what verify will do. */
  facetsOverlap: boolean;
  /** `null` when either side has no project key. */
  sameProject: boolean | null;
  /** The draft's `supersedes` points at this card. */
  isSupersedeTarget: boolean;
  /** The card is deprecated with the reason `superseded by <id>` (AD-13). */
  alreadySupersededBy?: string;
  /** The card is deprecated with a `rejected:` reason. */
  rejectionReason?: string;
}

export interface TriageEntry {
  id: string;
  title: string;
  type: string;
  ageDays: number;
  supersedes: string | null;
  related: RelatedEvidence[];
}

export interface TriageReport {
  /** Drafts examined. */
  checked: number;
  withRelated: TriageEntry[];
  withoutRelated: TriageEntry[];
}

export interface TriageOptions {
  /** Examine at most this many drafts, oldest first. */
  limit?: number;
  now?: Date;
  /** Card id to epoch seconds it was first committed (preferred over `created_at` for age). */
  addedAt?: ReadonlyMap<string, number>;
}

const MAX_RELATED = 5;
const SIMILARITY_THRESHOLD = 0.5;
const DAY_MS = 86_400_000;
const SUPERSEDED_BY_RE = /^superseded by (\S+)$/;

interface Row {
  id: string;
  type: string;
  title: string;
  status: 'draft' | 'verified' | 'deprecated';
  stack: string;
  applies_to: string;
  scope: FacetSet['scope'];
  project: string | null;
  version_range: string;
  supersedes: string | null;
  deprecation_reason: string | null;
  created_at: string;
}

interface Prepared {
  row: Row;
  tokens: Set<string>;
  facets: FacetSet;
  project: string;
  createdMs: number;
}

function parseList(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function prepare(row: Row, addedAt: ReadonlyMap<string, number> | undefined): Prepared {
  const committed = addedAt?.get(row.id);
  return {
    row,
    tokens: titleTokens(row.title),
    facets: {
      scope: row.scope,
      stack: parseList(row.stack),
      applies_to: parseList(row.applies_to),
      version_range: row.version_range,
    },
    project: typeof row.project === 'string' ? normalizeProjectKey(row.project) : '',
    createdMs: committed !== undefined ? committed * 1000 : Date.parse(row.created_at),
  };
}

function evidence(draft: Prepared, card: Prepared, similarity: number, facetsOverlap: boolean): RelatedEvidence {
  const reason = card.row.status === 'deprecated' ? card.row.deprecation_reason : null;
  const out: RelatedEvidence = {
    id: card.row.id,
    status: card.row.status,
    title: card.row.title,
    titleSimilarity: Math.round(similarity * 100) / 100,
    facetsOverlap,
    sameProject: draft.project === '' || card.project === '' ? null : draft.project === card.project,
    isSupersedeTarget: draft.row.supersedes === card.row.id,
  };
  const replacedBy = reason !== null ? SUPERSEDED_BY_RE.exec(reason.trim())?.[1] : undefined;
  if (replacedBy !== undefined) out.alreadySupersededBy = replacedBy;
  if (reason !== null && isRejectionReason(reason)) out.rejectionReason = reason;
  return out;
}

/**
 * For each draft, the cards a human may want to compare it with before deciding. Evidence only: it reports
 * title overlap, facet overlap and supersede/rejection history; it never says what to do (AD-6: overlap comes
 * from `facetsIntersect` alone). Read-only over the derived index.
 */
export function triageDrafts(db: Database.Database, opts: TriageOptions = {}): TriageReport {
  const now = (opts.now ?? new Date()).getTime();
  const rows = db
    .prepare(
      `SELECT id, type, title, status, stack, applies_to, scope, project, version_range,
              supersedes, deprecation_reason, created_at FROM cards`,
    )
    .all() as Row[];
  const cards = rows.map((row) => prepare(row, opts.addedAt));

  let drafts = cards.filter((c) => c.row.status === 'draft');
  // Oldest first (unparseable dates last), then id, so output and --limit are deterministic.
  drafts.sort((a, b) => {
    const am = Number.isNaN(a.createdMs) ? Infinity : a.createdMs;
    const bm = Number.isNaN(b.createdMs) ? Infinity : b.createdMs;
    return am !== bm ? am - bm : a.row.id.localeCompare(b.row.id);
  });
  if (opts.limit !== undefined && opts.limit >= 0) drafts = drafts.slice(0, opts.limit);

  const byType = new Map<string, Prepared[]>();
  for (const card of cards) {
    const list = byType.get(card.row.type);
    if (list) list.push(card);
    else byType.set(card.row.type, [card]);
  }
  const byId = new Map(cards.map((c) => [c.row.id, c]));

  const report: TriageReport = { checked: drafts.length, withRelated: [], withoutRelated: [] };
  for (const draft of drafts) {
    const related: RelatedEvidence[] = [];
    const target = draft.row.supersedes !== null ? byId.get(draft.row.supersedes) : undefined;
    if (target && target !== draft) {
      related.push(
        evidence(draft, target, jaccard(draft.tokens, target.tokens), facetsIntersect(draft.facets, target.facets)),
      );
    }
    const found: RelatedEvidence[] = [];
    for (const card of byType.get(draft.row.type) ?? []) {
      if (card === draft || card === target) continue;
      const similarity = jaccard(draft.tokens, card.tokens);
      const similar = similarity >= SIMILARITY_THRESHOLD;
      const overlap = facetsIntersect(draft.facets, card.facets);
      if (similar || overlap) found.push(evidence(draft, card, similarity, overlap));
    }
    found.sort((a, b) => b.titleSimilarity - a.titleSimilarity || a.id.localeCompare(b.id));
    related.push(...found.slice(0, MAX_RELATED - related.length));

    const entry: TriageEntry = {
      id: draft.row.id,
      title: draft.row.title,
      type: draft.row.type,
      ageDays: Number.isNaN(draft.createdMs) ? 0 : Math.max(0, Math.floor((now - draft.createdMs) / DAY_MS)),
      supersedes: draft.row.supersedes,
      related,
    };
    (related.length > 0 ? report.withRelated : report.withoutRelated).push(entry);
  }
  return report;
}
