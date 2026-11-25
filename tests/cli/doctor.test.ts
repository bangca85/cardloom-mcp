import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { runDoctor, formatDoctorReport, parseDoctorArgs } from '../../src/cli/doctor.js';
import { EMPTY_STORE_HINT } from '../../src/config/messages.js';

const DRAFT_CARD = `---
type: pattern
scope: project
applies_to: [api]
stack: [node]
version_range: ">=1.0.0"
sensitivity: normal
source_commit: abc123
provenance: agent-observation
title: Doctor draft card
status: draft
---
Body of the doctor draft card.
`;

const VERIFIED_CARD = `---
type: pattern
scope: project
applies_to: [api]
stack: [node]
version_range: ">=1.0.0"
status: verified
sensitivity: normal
source_commit: abc123
provenance: agent-observation
title: Doctor verified card
verified_by: reviewer
verification_method: manual-review
last_verified: "2026-01-01T00:00:00Z"
---
Body of the doctor verified card.
`;

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cardloom-mcp-doctor-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeCard(store: string, name: string, content: string): void {
  fs.mkdirSync(path.join(store, 'cards'), { recursive: true });
  fs.writeFileSync(path.join(store, 'cards', name), content);
}

describe('runDoctor', () => {
  it('reports a missing store with zero counts and creates nothing', async () => {
    const store = path.join(tmp, 'missing-store');
    const report = await runDoctor(store, path.join(tmp, 'index.db'));
    expect(report.storeExists).toBe(false);
    expect(report.isGitRepo).toBe(false);
    expect(report.cards).toEqual({ draft: 0, verified: 0, deprecated: 0 });
    expect(report.benchmarkQueries).toBeNull();
    expect(fs.existsSync(store)).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'index.db'))).toBe(false);
  });

  it('reports an empty existing directory as existing with zero counts', async () => {
    const report = await runDoctor(tmp, path.join(tmp, 'index.db'));
    expect(report.storeExists).toBe(true);
    expect(report.isGitRepo).toBe(false);
    expect(report.cards).toEqual({ draft: 0, verified: 0, deprecated: 0 });
  });

  it('counts a draft card and detects a git repo', async () => {
    writeCard(tmp, 'pattern-doctor-draft.md', DRAFT_CARD);
    execFileSync('git', ['init', '-q'], { cwd: tmp });
    const report = await runDoctor(tmp, path.join(tmp, 'index.db'));
    expect(report.storeExists).toBe(true);
    expect(report.isGitRepo).toBe(true);
    expect(report.cards).toEqual({ draft: 1, verified: 0, deprecated: 0 });
    expect(fs.existsSync(path.join(tmp, 'index.db'))).toBe(false);
  });

  it('counts benchmark queries when queries.yaml is valid', async () => {
    fs.mkdirSync(path.join(tmp, 'benchmark'));
    fs.writeFileSync(
      path.join(tmp, 'benchmark', 'queries.yaml'),
      '- query: first\n  expected: a\n- query: second\n  expected: b\n',
    );
    const report = await runDoctor(tmp, path.join(tmp, 'index.db'));
    expect(report.benchmarkQueries).toBe(2);
  });

  it('reports null and flags an invalid queries.yaml without crashing', async () => {
    fs.mkdirSync(path.join(tmp, 'benchmark'));
    fs.writeFileSync(path.join(tmp, 'benchmark', 'queries.yaml'), 'not: a list\n');
    const report = await runDoctor(tmp, path.join(tmp, 'index.db'));
    expect(report.benchmarkQueries).toBeNull();
    expect(formatDoctorReport(report)).toContain('benchmark/queries.yaml is invalid');
  });
});

function cardFile(opts: {
  title: string;
  status: 'draft' | 'verified' | 'deprecated';
  verifiedBy?: string;
  method?: string;
  deprecationReason?: string;
}): string {
  const lines = [
    '---',
    'type: pattern',
    'scope: project',
    'applies_to: [api]',
    'stack: [node]',
    'version_range: ">=1.0.0"',
    'sensitivity: normal',
    'source_commit: abc123',
    'provenance: agent-observation',
    `title: ${opts.title}`,
    `status: ${opts.status}`,
  ];
  if (opts.verifiedBy) {
    lines.push(
      `verified_by: ${opts.verifiedBy}`,
      `verification_method: "${opts.method}"`,
      'last_verified: "2026-01-01T00:00:00Z"',
    );
  }
  if (opts.status === 'deprecated') {
    lines.push(
      `deprecation_reason: "${opts.deprecationReason}"`,
      'deprecated_at: "2026-02-01T00:00:00Z"',
      'deprecated_by: reviewer',
    );
  }
  lines.push('---', `Body of ${opts.title}.`, '');
  return lines.join('\n');
}

const NOW = new Date('2026-11-25T00:00:00Z');
const DAY_MS = 86_400_000;

function writeAged(store: string, name: string, content: string, ageDays: number): void {
  writeCard(store, name, content);
  const when = new Date(NOW.getTime() - ageDays * DAY_MS);
  fs.utimesSync(path.join(store, 'cards', name), when, when);
}

describe('runDoctor review stats', () => {
  it('splits drafts, approvals, rejections and retired drafts', async () => {
    writeAged(tmp, 'pattern-draft-new.md', cardFile({ title: 'Draft new', status: 'draft' }), 10);
    writeAged(tmp, 'pattern-draft-old.md', cardFile({ title: 'Draft old', status: 'draft' }), 40);
    writeAged(
      tmp,
      'pattern-a.md',
      cardFile({ title: 'A', status: 'verified', verifiedBy: 'alice', method: 'chat-approval' }),
      5,
    );
    writeAged(
      tmp,
      'pattern-b.md',
      cardFile({
        title: 'B',
        status: 'verified',
        verifiedBy: 'release-bot',
        method: 'merged:acme/app@abc1234 (pr #1 merged)',
      }),
      5,
    );
    writeAged(
      tmp,
      'pattern-c.md',
      cardFile({
        title: 'C',
        status: 'deprecated',
        verifiedBy: 'alice',
        method: 'chat-approval',
        deprecationReason: 'outdated',
      }),
      5,
    );
    writeAged(
      tmp,
      'pattern-d.md',
      cardFile({ title: 'D', status: 'deprecated', deprecationReason: 'rejected: duplicate of A' }),
      5,
    );
    writeAged(
      tmp,
      'pattern-e.md',
      cardFile({ title: 'E', status: 'deprecated', deprecationReason: 'superseded by A' }),
      5,
    );

    const report = await runDoctor(tmp, path.join(tmp, 'index.db'), NOW);
    expect(report.review).toEqual({
      pendingDrafts: 2,
      oldestDraftDays: 40,
      approvedByHuman: 2,
      approvedByMergePromotion: 1,
      rejectedByHuman: 1,
      retiredUnreviewed: 1,
      humanApprovalRate: 2 / 3,
    });

    const text = formatDoctorReport(report);
    expect(text).toContain('Review: 2 drafts waiting (oldest 40 days)');
    expect(text).toContain(
      'Approved by a human: 2 · by merge promotion: 1 · rejected: 1 · retired before review: 1',
    );
    expect(text).toContain('Human approval rate: 67% of drafts a human approved or rejected (2 of 3)');
  });

  it('counts a human approval in review mode (merged evidence plus +chat-approval) as approved by a human', async () => {
    writeAged(
      tmp,
      'pattern-f.md',
      cardFile({
        title: 'F',
        status: 'verified',
        verifiedBy: 'alice',
        method: 'merged:acme/app@abc1234 (pr #1 merged)+chat-approval',
      }),
      5,
    );
    const report = await runDoctor(tmp, path.join(tmp, 'index.db'), NOW);
    expect(report.review.approvedByHuman).toBe(1);
    expect(report.review.approvedByMergePromotion).toBe(0);
    expect(report.review.humanApprovalRate).toBe(1);
  });

  it('reports no drafts and a null approval rate for an empty store', async () => {
    const report = await runDoctor(tmp, path.join(tmp, 'index.db'), NOW);
    expect(report.review).toEqual({
      pendingDrafts: 0,
      oldestDraftDays: null,
      approvedByHuman: 0,
      approvedByMergePromotion: 0,
      rejectedByHuman: 0,
      retiredUnreviewed: 0,
      humanApprovalRate: null,
    });
    const text = formatDoctorReport(report);
    expect(text).toContain('Review: 0 drafts waiting');
    expect(text).not.toContain('Human approval rate');
  });

  it('uses the singular for one draft', async () => {
    writeAged(tmp, 'pattern-draft-one.md', cardFile({ title: 'One', status: 'draft' }), 1);
    const text = formatDoctorReport(await runDoctor(tmp, path.join(tmp, 'index.db'), NOW));
    expect(text).toContain('Review: 1 draft waiting (oldest 1 day)');
  });
});

function gitCommitAll(store: string, message: string, daysAgo: number): void {
  const date = new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString();
  const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  execFileSync('git', ['add', '-A'], { cwd: store, env });
  execFileSync(
    'git',
    [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
      // Hermetic: a user's global hooks or signing must not affect the test.
      '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null',
      'commit', '-q', '-m', message,
    ],
    { cwd: store, env },
  );
}

describe('runDoctor draft age source', () => {
  it('counts age from the commit that added the card, not the file mtime', async () => {
    execFileSync('git', ['init', '-q'], { cwd: tmp });
    writeAged(tmp, 'pattern-draft-old.md', cardFile({ title: 'Draft old', status: 'draft' }), 0);
    gitCommitAll(tmp, 'add old', 40);
    writeAged(tmp, 'pattern-draft-new.md', cardFile({ title: 'Draft new', status: 'draft' }), 0);
    gitCommitAll(tmp, 'add new', 10);
    // A later edit must not reset the age.
    writeAged(tmp, 'pattern-draft-old.md', cardFile({ title: 'Draft old edited', status: 'draft' }), 0);
    gitCommitAll(tmp, 'edit old', 1);

    const report = await runDoctor(tmp, path.join(tmp, 'index.db'), NOW);
    expect(report.review.pendingDrafts).toBe(2);
    expect(report.review.oldestDraftDays).toBe(40);
  });

  it('falls back to the file mtime when the store is not a git repo', async () => {
    writeAged(tmp, 'pattern-draft-old.md', cardFile({ title: 'Draft old', status: 'draft' }), 25);
    const report = await runDoctor(tmp, path.join(tmp, 'index.db'), NOW);
    expect(report.isGitRepo).toBe(false);
    expect(report.review.oldestDraftDays).toBe(25);
  });

  it('falls back to the mtime for a draft with no commit yet', async () => {
    execFileSync('git', ['init', '-q'], { cwd: tmp });
    writeAged(tmp, 'pattern-committed.md', cardFile({ title: 'Committed', status: 'draft' }), 0);
    gitCommitAll(tmp, 'add committed', 10);
    writeAged(tmp, 'pattern-untracked.md', cardFile({ title: 'Untracked', status: 'draft' }), 30);
    const report = await runDoctor(tmp, path.join(tmp, 'index.db'), NOW);
    expect(report.review.oldestDraftDays).toBe(30);
  });
});

describe('formatDoctorReport', () => {
  it('omits the review block when the store does not exist', async () => {
    const text = formatDoctorReport(await runDoctor(path.join(tmp, 'missing-store'), path.join(tmp, 'index.db')));
    expect(text).not.toContain('Review:');
    expect(text).not.toContain('Approved by a human');
  });

  it('says a missing store is created on first server start', async () => {
    const text = formatDoctorReport(await runDoctor(path.join(tmp, 'missing-store'), path.join(tmp, 'index.db')));
    expect(text.split('\n')[0]).toContain('(not found — created on first server start)');
  });

  it('ends with the empty-store hint when there are no verified cards', async () => {
    writeCard(tmp, 'pattern-doctor-draft.md', DRAFT_CARD);
    const text = formatDoctorReport(await runDoctor(tmp, path.join(tmp, 'index.db')));
    expect(text.trimEnd().split('\n').at(-1)).toBe(EMPTY_STORE_HINT);
  });

  it('omits the hint when a verified card exists', async () => {
    writeCard(tmp, 'pattern-doctor-verified.md', VERIFIED_CARD);
    const report = await runDoctor(tmp, path.join(tmp, 'index.db'));
    expect(report.cards.verified).toBe(1);
    expect(formatDoctorReport(report)).not.toContain(EMPTY_STORE_HINT);
  });

  it('prints the paths and counts', async () => {
    const report = await runDoctor(tmp, path.join(tmp, 'index.db'));
    const text = formatDoctorReport(report);
    expect(text).toContain(tmp);
    expect(text).toContain(path.join(tmp, 'index.db'));
    expect(text).toMatch(/draft:\s+0/);
  });
});

describe('parseDoctorArgs', () => {
  it('no arguments run doctor, --help and -h ask for the usage', () => {
    expect(parseDoctorArgs([])).toEqual({});
    expect(parseDoctorArgs(['--help'])).toEqual({ help: true });
    expect(parseDoctorArgs(['-h'])).toEqual({ help: true });
  });
  it.each([[['--bogus']], [['--help', 'x']], [['x']]])('%j is rejected', (argv) => {
    expect(parseDoctorArgs(argv as string[])).toBeNull();
  });
});
