import type Database from 'better-sqlite3';
import { computeCardFlags, updateCardStatus } from './card-service.js';
import { cardFileHash } from '../utils/card-file-hash.js';
import { daysSince } from '../utils/date.js';

export { cardFileHash };

export interface StaleCard {
  id: string;
  title: string;
  lastVerified: string;
  ageDays: number;
  hash: string;
  needsReview: boolean;
}

export interface ReconfirmResult {
  reconfirmed: string[];
  refused: Array<{ id: string; reason: string }>;
}

interface StaleRow {
  id: string;
  title: string;
  last_verified: string;
  failure: number | null;
}

/**
 * Verified cards (normal and restricted) whose `stale` flag is set by `computeCardFlags` — the one rule search and
 * `get_card` use — oldest first. `needsReview` comes from the same function. Read-only.
 */
export function listStaleCards(db: Database.Database, storePath: string, now: Date = new Date()): StaleCard[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.title, c.last_verified, k.failure
         FROM cards c LEFT JOIN counters k ON k.card_id = c.id
        WHERE c.status = 'verified' AND c.last_verified IS NOT NULL`,
    )
    .all() as StaleRow[];

  const stale: StaleCard[] = [];
  for (const row of rows) {
    const flags = computeCardFlags({ last_verified: row.last_verified, failure: row.failure ?? 0 }, now);
    if (!flags.stale) continue;
    stale.push({
      id: row.id,
      title: row.title,
      lastVerified: row.last_verified,
      ageDays: Math.floor(daysSince(row.last_verified, now)),
      hash: cardFileHash(storePath, row.id),
      needsReview: flags.needs_review === true,
    });
  }
  return stale.sort((a, b) => a.lastVerified.localeCompare(b.lastVerified) || a.id.localeCompare(b.id));
}

/**
 * One `updateCardStatus('reconfirm')` per entry, in order, each guarded by the hash it was listed with.
 * A failure (changed file, needs review, unknown id, anything else) is collected, never thrown, and
 * does not stop the entries after it. `by` is the actor named in the commit message (`knowledge: reconfirm <id> (by <actor>)`); the card file does not carry it.
 */
export async function reconfirmCards(
  db: Database.Database,
  storePath: string,
  entries: Array<{ id: string; hash: string }>,
  by: string,
): Promise<ReconfirmResult> {
  const result: ReconfirmResult = { reconfirmed: [], refused: [] };
  for (const entry of entries) {
    try {
      await updateCardStatus(db, storePath, { id: entry.id, action: 'reconfirm', by, expected_hash: entry.hash });
      result.reconfirmed.push(entry.id);
    } catch (err) {
      result.refused.push({ id: entry.id, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
