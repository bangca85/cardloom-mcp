import type Database from 'better-sqlite3';
import { config } from '../config/env.js';
import { daysSince } from '../utils/date.js';
import type { DoctorReport } from '../cli/doctor.js';

const TOP_LIMIT = 5;

export interface UsageReport {
  days: number;
  confirmed: number;
  refuted: number;
  neutral: number;
  topConfirmed: Array<{ id: string; title: string; count: number }>;
  newlyNeedsReview: string[];
  staleWithin30Days: string[];
  review: DoctorReport['review'];
}

/**
 * What the store did in the last `days` days. Reads only SQLite: usage comes from `usage_events` and `counters`,
 * which the one fold function filled from the event log (AD-4); the JSONL files are never read here.
 * Window = `now - days` .. `now`, both ends inclusive; events whose `at` cannot be parsed are ignored.
 */
export function buildReport(
  db: Database.Database,
  opts: { days: number; now: Date; review: DoctorReport['review'] },
): UsageReport {
  const { days, now, review } = opts;
  const windowEnd = now.toISOString();
  const windowStart = new Date(now.getTime() - days * 86_400_000).toISOString();
  // julianday() is NULL for an unparseable `at`, so such rows fail both comparisons.
  const windowOf = (col: string): string =>
    `julianday(${col}) >= julianday(@windowStart) AND julianday(${col}) <= julianday(@windowEnd)`;
  const params = { windowStart, windowEnd };

  const totals = { confirmed: 0, refuted: 0, neutral: 0 };
  const byOutcome = db
    .prepare(`SELECT outcome, COUNT(*) AS c FROM usage_events WHERE ${windowOf('at')} GROUP BY outcome`)
    .all(params) as Array<{ outcome: string; c: number }>;
  for (const row of byOutcome) {
    if (row.outcome === 'confirmed' || row.outcome === 'refuted' || row.outcome === 'neutral') totals[row.outcome] = row.c;
  }

  const top = db
    .prepare(
      `SELECT e.card_id AS id, COALESCE(c.title, e.card_id) AS title, COUNT(*) AS count
       FROM usage_events e LEFT JOIN cards c ON c.id = e.card_id
       WHERE e.outcome = 'confirmed' AND ${windowOf('e.at')}
       GROUP BY e.card_id ORDER BY count DESC, e.card_id ASC LIMIT ${TOP_LIMIT}`,
    )
    .all(params) as UsageReport['topConfirmed'];

  const newlyNeedsReview = (
    db
      .prepare(
        `SELECT k.card_id AS id FROM counters k JOIN cards c ON c.id = k.card_id
         WHERE c.status != 'deprecated' AND k.failure >= @threshold AND EXISTS (
           SELECT 1 FROM usage_events e
           WHERE e.card_id = k.card_id AND e.outcome = 'refuted' AND ${windowOf('e.at')}
         ) ORDER BY k.card_id`,
      )
      .all({ ...params, threshold: config.reviewFailureThreshold }) as Array<{ id: string }>
  ).map((r) => r.id);

  const stale = config.staleThresholdDays;
  const staleWithin30Days = (
    db.prepare("SELECT id, last_verified FROM cards WHERE status = 'verified' AND last_verified IS NOT NULL ORDER BY id").all() as Array<{
      id: string;
      last_verified: string;
    }>
  )
    .filter((row) => {
      const age = daysSince(row.last_verified, now);
      return age > stale - 30 && age <= stale;
    })
    .map((row) => row.id);

  return { days, ...totals, topConfirmed: top, newlyNeedsReview, staleWithin30Days, review };
}
