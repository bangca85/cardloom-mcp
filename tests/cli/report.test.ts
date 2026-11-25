import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { formatReport, parseReportArgs, runReport } from '../../src/cli/report.js';
import type { UsageReport } from '../../src/services/report-service.js';

const REVIEW: UsageReport['review'] = {
  pendingDrafts: 0,
  oldestDraftDays: null,
  approvedByHuman: 0,
  approvedByMergePromotion: 0,
  rejectedByHuman: 0,
  retiredUnreviewed: 0,
  humanApprovalRate: null,
};

function base(over: Partial<UsageReport> = {}): UsageReport {
  return {
    days: 7,
    confirmed: 0,
    refuted: 0,
    neutral: 0,
    topConfirmed: [],
    newlyNeedsReview: [],
    staleWithin30Days: [],
    review: REVIEW,
    ...over,
  };
}

describe('parseReportArgs', () => {
  it('defaults to 7 days, no json', () => {
    expect(parseReportArgs([])).toEqual({ days: 7, json: false });
  });
  it('accepts --days N and --json', () => {
    expect(parseReportArgs(['--days', '30', '--json'])).toEqual({ days: 30, json: true });
  });
  it.each([[['--days', '0']], [['--days', 'x']], [['--days', '-3']], [['--days', '1.5']], [['--days']], [['--bogus']]])(
    '%j is rejected',
    (argv) => {
      expect(parseReportArgs(argv as string[])).toBeNull();
    },
  );
  it('--help and -h set help', () => {
    expect(parseReportArgs(['--help'])?.help).toBe(true);
    expect(parseReportArgs(['-h'])?.help).toBe(true);
  });
});

describe('formatReport', () => {
  it('prints one "No activity" line instead of the counts when nothing happened', () => {
    const out = formatReport(base());
    expect(out).toContain('No activity in the last 7 days.');
    expect(out).not.toContain('Confirmed');
    expect(out).toContain('Drafts waiting: 0');
  });

  it('prints counts and every section when there is activity', () => {
    const out = formatReport(
      base({
        days: 14,
        confirmed: 5,
        refuted: 1,
        neutral: 2,
        topConfirmed: [{ id: 'pattern-a', title: 'Alpha rule', count: 3 }],
        newlyNeedsReview: ['pattern-b'],
        staleWithin30Days: ['pattern-c'],
        review: { ...REVIEW, pendingDrafts: 2, oldestDraftDays: 4 },
      }),
    );
    expect(out).not.toContain('No activity');
    expect(out).toContain('Last 14 days: 5 confirmed · 1 refuted · 2 neutral');
    expect(out).toContain('Cards that helped most');
    expect(out).toContain('pattern-a · Alpha rule (3)');
    expect(out).toContain('Cards that need a look');
    expect(out).toContain('pattern-b');
    expect(out).toContain('Cards going stale within 30 days');
    expect(out).toContain('pattern-c');
    expect(out).toContain('Drafts waiting: 2 (oldest 4 days)');
  });

  it('shows "none" under empty lists when there is activity', () => {
    const out = formatReport(base({ confirmed: 1 }));
    expect(out).toContain('Cards that need a look\n  none');
  });
});

describe('runReport', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cardloom-mcp-report-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('a missing store gives zeros and the no-activity line, and creates nothing', async () => {
    const store = path.join(tmp, 'does-not-exist');
    const out = await runReport(store, { days: 7, json: false });
    expect(out).toContain('No activity in the last 7 days.');
    expect(fs.existsSync(store)).toBe(false);
  });

  it('an empty store directory gives zeros and writes nothing into it', async () => {
    const store = path.join(tmp, 'store');
    fs.mkdirSync(store);
    const out = await runReport(store, { days: 7, json: false });
    expect(out).toContain('No activity in the last 7 days.');
    expect(fs.readdirSync(store)).toEqual([]);
  });

  it('reads usage from events/*.jsonl through the fold and prints it; --json is parseable', async () => {
    const store = path.join(tmp, 'store');
    fs.mkdirSync(path.join(store, 'cards'), { recursive: true });
    fs.mkdirSync(path.join(store, 'events'));
    fs.writeFileSync(
      path.join(store, 'cards', 'pattern-a.md'),
      `---
type: pattern
scope: project
applies_to: [api]
stack: [node]
version_range: ">=1.0.0"
sensitivity: normal
source_commit: abc123
provenance: agent-observation
title: Alpha rule
status: verified
verified_by: reviewer
verification_method: manual-review
last_verified: "2026-01-01T00:00:00Z"
---
Body.
`,
    );
    const at = new Date(Date.now() - 3_600_000).toISOString();
    fs.writeFileSync(
      path.join(store, 'events', 'laptop.jsonl'),
      `${JSON.stringify({ v: 1, card: 'pattern-a', outcome: 'confirmed', at })}\n${JSON.stringify({ v: 1, card: 'pattern-a', outcome: 'neutral', at })}\n`,
    );
    const text = await runReport(store, { days: 7, json: false });
    expect(text).toContain('Last 7 days: 1 confirmed · 0 refuted · 1 neutral');
    expect(text).toContain('pattern-a · Alpha rule (1)');
    const json = JSON.parse(await runReport(store, { days: 7, json: true })) as UsageReport;
    expect(json.confirmed).toBe(1);
    expect(json.topConfirmed).toEqual([{ id: 'pattern-a', title: 'Alpha rule', count: 1 }]);
    // read-only: no index.db, no .metadata created
    expect(fs.readdirSync(store).sort()).toEqual(['cards', 'events']);
  });
});
