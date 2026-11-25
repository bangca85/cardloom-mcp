import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { foldEvent } from '../../src/services/event-log-service.js';
import type { UsageOutcome } from '../../src/services/event-log-service.js';
import { buildReport } from '../../src/services/report-service.js';
import type { ReviewStats } from '../../src/types/review-stats.js';
import { config } from '../../src/config/env.js';

const NOW = new Date('2026-11-25T12:00:00Z');
const DAY = 86_400_000;
const ago = (days: number): string => new Date(NOW.getTime() - days * DAY).toISOString();

const REVIEW: ReviewStats = {
  pendingDrafts: 2,
  oldestDraftDays: 4,
  approvedByHuman: 0,
  approvedByMergePromotion: 0,
  rejectedByHuman: 0,
  retiredUnreviewed: 0,
  humanApprovalRate: null,
};

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  initializeSchema(db);
});
afterEach(() => {
  db.close();
});

function insertCard(id: string, opts: { status?: string; lastVerified?: string | null; title?: string } = {}): void {
  db.prepare(
    `INSERT INTO cards (
      id, type, status, title, stack, applies_to, scope, version_range, sensitivity,
      conflicts_with, source_commit, provenance, last_verified, body, created_at, updated_at, file_mtime
    ) VALUES (
      @id, 'pattern', @status, @title, '["node"]', '["api"]', 'project', '>=1.0.0', 'normal',
      '[]', 'abc123', 'agent-observation', @last_verified, 'Body', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ''
    )`,
  ).run({
    id,
    status: opts.status ?? 'verified',
    title: opts.title ?? `Title ${id}`,
    last_verified: opts.lastVerified === undefined ? null : opts.lastVerified,
  });
}

function event(card: string, outcome: UsageOutcome, at: string): void {
  foldEvent(db, { v: 1, card, outcome, at });
}

function report(days = 7) {
  return buildReport(db, { days, now: NOW, review: REVIEW });
}

describe('buildReport', () => {
  it('an empty store gives zeros and empty lists, carrying the review stats through', () => {
    expect(report()).toEqual({
      days: 7,
      confirmed: 0,
      refuted: 0,
      neutral: 0,
      topConfirmed: [],
      newlyNeedsReview: [],
      staleWithin30Days: [],
      review: REVIEW,
    });
  });

  it('counts only events inside the window, including the boundaries now-days and now', () => {
    insertCard('pattern-a');
    event('pattern-a', 'confirmed', ago(1));
    event('pattern-a', 'confirmed', ago(7)); // exactly at the start: inside
    event('pattern-a', 'confirmed', ago(7.001)); // just outside
    event('pattern-a', 'confirmed', ago(30)); // outside
    event('pattern-a', 'refuted', ago(2));
    event('pattern-a', 'neutral', NOW.toISOString()); // exactly now: inside
    event('pattern-a', 'neutral', ago(-1)); // future: outside
    const r = report();
    expect([r.confirmed, r.refuted, r.neutral]).toEqual([2, 1, 1]);
  });

  it('ignores events whose at cannot be parsed (and does not crash)', () => {
    insertCard('pattern-a');
    event('pattern-a', 'confirmed', 'garbage');
    event('pattern-a', 'confirmed', ago(1));
    const r = report();
    expect(r.confirmed).toBe(1);
    expect(r.topConfirmed).toEqual([{ id: 'pattern-a', title: 'Title pattern-a', count: 1 }]);
  });

  it('topConfirmed: top 5 by confirmed count in the window, ties by id, title from cards', () => {
    for (const id of ['c-a', 'c-b', 'c-c', 'c-d', 'c-e', 'c-f']) insertCard(id, { title: `T ${id}` });
    for (let i = 0; i < 3; i++) event('c-c', 'confirmed', ago(1));
    for (let i = 0; i < 2; i++) event('c-b', 'confirmed', ago(1));
    for (let i = 0; i < 2; i++) event('c-a', 'confirmed', ago(2));
    for (const id of ['c-f', 'c-e', 'c-d']) event(id, 'confirmed', ago(1));
    // outside the window: must not lift c-d
    for (let i = 0; i < 9; i++) event('c-d', 'confirmed', ago(20));
    // refuted/neutral do not count
    for (let i = 0; i < 9; i++) event('c-f', 'neutral', ago(1));
    const r = report();
    expect(r.topConfirmed).toEqual([
      { id: 'c-c', title: 'T c-c', count: 3 },
      { id: 'c-a', title: 'T c-a', count: 2 },
      { id: 'c-b', title: 'T c-b', count: 2 },
      { id: 'c-d', title: 'T c-d', count: 1 },
      { id: 'c-e', title: 'T c-e', count: 1 },
    ]);
  });

  it('an event for a missing card is counted in the totals and listed with its id as title', () => {
    event('gone-card', 'confirmed', ago(1));
    event('gone-card', 'refuted', ago(1));
    const r = report();
    expect(r.confirmed).toBe(1);
    expect(r.refuted).toBe(1);
    expect(r.topConfirmed).toEqual([{ id: 'gone-card', title: 'gone-card', count: 1 }]);
  });

  it('newlyNeedsReview: total failures >= threshold AND at least one refute inside the window', () => {
    const threshold = config.reviewFailureThreshold;
    expect(threshold).toBeGreaterThanOrEqual(2);
    for (const id of ['n-new', 'n-old', 'n-low', 'n-gone-quiet']) insertCard(id);
    // n-new: one old refute + one fresh refute -> total >= threshold, one in window
    for (let i = 0; i < threshold - 1; i++) event('n-new', 'refuted', ago(60));
    event('n-new', 'refuted', ago(1));
    // n-old: needs_review but all refutes outside the window
    for (let i = 0; i < threshold; i++) event('n-old', 'refuted', ago(60));
    // n-low: a fresh refute but total below threshold
    for (let i = 0; i < threshold - 1; i++) event('n-low', 'refuted', ago(1));
    // a deprecated card and a card missing from the index cannot be acted on, so they are not listed
    insertCard('n-retired', { status: 'deprecated' });
    for (let i = 0; i < threshold; i++) event('n-retired', 'refuted', ago(2));
    for (let i = 0; i < threshold; i++) event('n-missing', 'refuted', ago(2));
    const r = report();
    expect(r.newlyNeedsReview).toEqual(['n-new']);
  });

  it('staleWithin30Days: verified cards with age in (STALE-30, STALE], boundaries exact', () => {
    const stale = config.staleThresholdDays;
    insertCard('s-at-lower', { lastVerified: ago(stale - 30) }); // excluded (exclusive)
    insertCard('s-just-over-lower', { lastVerified: ago(stale - 30 + 0.01) }); // included
    insertCard('s-mid', { lastVerified: ago(stale - 10) }); // included
    insertCard('s-at-upper', { lastVerified: ago(stale) }); // included (inclusive)
    insertCard('s-over-upper', { lastVerified: ago(stale + 0.01) }); // already stale: excluded
    insertCard('s-fresh', { lastVerified: ago(5) });
    insertCard('s-null', { lastVerified: null });
    insertCard('s-draft', { status: 'draft', lastVerified: ago(stale - 10) });
    insertCard('s-deprecated', { status: 'deprecated', lastVerified: ago(stale - 10) });
    insertCard('s-bad-date', { lastVerified: 'nope' });
    expect(report().staleWithin30Days).toEqual(['s-at-upper', 's-just-over-lower', 's-mid']);
  });
});
