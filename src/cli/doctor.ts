import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { config } from '../config/env.js';
import { EMPTY_STORE_HINT } from '../config/messages.js';
import { isMergePromotion, isRejectionReason } from '../utils/rejection.js';
import { buildFreshIndex, parseQueriesYaml } from './benchmark.js';

/** How drafts are being reviewed. A card is "ever approved" when `verified_by` is set (deprecation keeps it). */
export interface ReviewStats {
  pendingDrafts: number;
  /** Age in whole days of the oldest draft; `null` when there are no drafts. */
  oldestDraftDays: number | null;
  approvedByHuman: number;
  approvedByMergePromotion: number;
  /** Deprecated, never approved, reason starts with `rejected:`. */
  rejectedByHuman: number;
  /** Deprecated, never approved, not a rejection (e.g. superseded while still a draft). */
  retiredUnreviewed: number;
  /** approvedByHuman / (approvedByHuman + rejectedByHuman); `null` when that denominator is 0. */
  humanApprovalRate: number | null;
}

export interface DoctorReport {
  storePath: string;
  storeExists: boolean;
  isGitRepo: boolean;
  indexDbPath: string;
  cards: { draft: number; verified: number; deprecated: number };
  /** Number of entries in `benchmark/queries.yaml`; `null` when absent or unparseable. */
  benchmarkQueries: number | null;
  /** True when `benchmark/queries.yaml` exists but could not be parsed. */
  benchmarkQueriesInvalid?: boolean;
  review: ReviewStats;
}

const DAY_MS = 86_400_000;

function emptyReview(): ReviewStats {
  return {
    pendingDrafts: 0,
    oldestDraftDays: null,
    approvedByHuman: 0,
    approvedByMergePromotion: 0,
    rejectedByHuman: 0,
    retiredUnreviewed: 0,
    humanApprovalRate: null,
  };
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function computeReview(db: Database.Database, now: Date): ReviewStats {
  const review = emptyReview();
  const rows = db
    .prepare(
      'SELECT status, verified_by, verification_method, deprecation_reason, created_at FROM cards',
    )
    .all() as Array<{
    status: string;
    verified_by: string | null;
    verification_method: string | null;
    deprecation_reason: string | null;
    created_at: string;
  }>;
  let oldestMs: number | null = null;
  for (const row of rows) {
    if (row.status === 'draft') {
      review.pendingDrafts++;
      const created = Date.parse(row.created_at);
      if (!Number.isNaN(created) && (oldestMs === null || created < oldestMs)) oldestMs = created;
    }
    if (row.verified_by) {
      if (isMergePromotion(row.verification_method)) review.approvedByMergePromotion++;
      else review.approvedByHuman++;
    } else if (row.status === 'deprecated') {
      if (isRejectionReason(row.deprecation_reason)) review.rejectedByHuman++;
      else review.retiredUnreviewed++;
    }
  }
  if (oldestMs !== null) review.oldestDraftDays = Math.max(0, Math.floor((now.getTime() - oldestMs) / DAY_MS));
  const decided = review.approvedByHuman + review.rejectedByHuman;
  review.humanApprovalRate = decided === 0 ? null : review.approvedByHuman / decided;
  return review;
}

/**
 * Read-only health check: never creates directories or files and never touches the real index.db
 * (counts come from a throwaway in-memory index built from the card files, AD-2).
 */
export async function runDoctor(
  storePath: string,
  indexDbPath: string,
  now: Date = new Date(),
): Promise<DoctorReport> {
  const storeExists = isDirectory(storePath);
  const report: DoctorReport = {
    storePath,
    storeExists,
    isGitRepo: storeExists && fs.existsSync(path.join(storePath, '.git')),
    indexDbPath,
    cards: { draft: 0, verified: 0, deprecated: 0 },
    benchmarkQueries: null,
    review: emptyReview(),
  };
  if (!storeExists) return report;

  const db = await buildFreshIndex(storePath);
  try {
    const rows = db.prepare('SELECT status, COUNT(*) AS c FROM cards GROUP BY status').all() as Array<{
      status: string;
      c: number;
    }>;
    for (const row of rows) {
      if (row.status === 'draft' || row.status === 'verified' || row.status === 'deprecated') {
        report.cards[row.status] = row.c;
      }
    }
    report.review = computeReview(db, now);
  } finally {
    db.close();
  }

  const queriesPath = path.join(storePath, 'benchmark', 'queries.yaml');
  if (fs.existsSync(queriesPath)) {
    try {
      report.benchmarkQueries = parseQueriesYaml(fs.readFileSync(queriesPath, 'utf-8')).length;
    } catch {
      report.benchmarkQueriesInvalid = true;
    }
  }
  return report;
}

export function formatDoctorReport(r: DoctorReport): string {
  const lines = [
    `Knowledge store: ${r.storePath} (${r.storeExists ? 'found' : 'not found — created on first server start'})`,
    `Git repository:  ${r.isGitRepo ? 'yes' : 'no'}`,
    `Index database:  ${r.indexDbPath}`,
    'Cards:',
    `  draft:      ${r.cards.draft}`,
    `  verified:   ${r.cards.verified}`,
    `  deprecated: ${r.cards.deprecated}`,
    `Benchmark queries: ${r.benchmarkQueries === null ? 'none' : r.benchmarkQueries}`,
  ];
  const v = r.review;
  const age = v.oldestDraftDays === null ? '' : ` (oldest ${v.oldestDraftDays} ${v.oldestDraftDays === 1 ? 'day' : 'days'})`;
  lines.push(
    `Review: ${v.pendingDrafts} ${v.pendingDrafts === 1 ? 'draft' : 'drafts'} waiting${age}`,
    `Approved by a human: ${v.approvedByHuman} · by merge promotion: ${v.approvedByMergePromotion} · rejected: ${v.rejectedByHuman} · retired before review: ${v.retiredUnreviewed}`,
  );
  if (v.humanApprovalRate !== null) {
    lines.push(
      `Human approval rate: ${Math.round(v.humanApprovalRate * 100)}% of drafts a human approved or rejected (${v.approvedByHuman} of ${v.approvedByHuman + v.rejectedByHuman})`,
    );
  }
  if (r.benchmarkQueriesInvalid) {
    lines.push('Warning: benchmark/queries.yaml is invalid (could not be parsed).');
  }
  if (r.cards.verified === 0) lines.push(EMPTY_STORE_HINT);
  return lines.join('\n');
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runDoctor(config.knowledgeStorePath, config.indexDbPath)
    .then((report) => {
      console.log(formatDoctorReport(report));
    })
    .catch((err: unknown) => {
      console.error('[doctor] failed:', err);
      process.exit(1);
    });
}
