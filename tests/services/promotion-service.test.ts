import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import matter from 'gray-matter';
import type Database from 'better-sqlite3';
import { getDatabase, closeDatabase } from '../../src/db/database.js';
import { initKnowledgeStore } from '../../src/services/knowledge-store.js';
import { resetGit } from '../../src/services/git-service.js';
import { saveLearningDraft, type SaveLearningDraftInput } from '../../src/services/card-service.js';
import {
  extractSha,
  repoCandidates,
  defaultRunner,
  runPromotion,
  type CommandRunner,
  type PromotionOptions,
} from '../../src/services/promotion-service.js';

const PAST = '2020-01-01T00:00:00Z';
const FUTURE = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

function gitIn(cwd: string, args: string[], date = PAST): string {
  // core.hooksPath and commit.gpgsign: a user's global hooks or signing must not affect the test.
  const hermetic = ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];
  return execFileSync('git', [...hermetic, ...args], {
    cwd,
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    encoding: 'utf-8',
  }).trim();
}

function commit(repo: string, file: string, date = PAST): string {
  // Fixed content, identity and dates keep every commit hash identical from run to run. A random
  // payload made the hashes random, and extractSha once rejected an abbreviation without both a digit
  // and a letter (about 2.4% of 8-character prefixes), which made this suite fail now and then in CI.
  fs.writeFileSync(path.join(repo, file), `${file}\n`);
  gitIn(repo, ['add', file], date);
  gitIn(repo, ['commit', '-q', '-m', file], date);
  return gitIn(repo, ['rev-parse', 'HEAD']);
}

let stackSeq = 0;
function draft(overrides: Partial<SaveLearningDraftInput>): SaveLearningDraftInput {
  stackSeq++;
  return {
    title: `Card ${stackSeq}`,
    type: 'pattern',
    scope: 'project',
    applies_to: ['demo-repo'],
    // A distinct stack per card keeps the conflict engine (AD-6) out of these tests.
    stack: [`stack-${stackSeq}`],
    version_range: '*',
    body: 'Body.',
    source_commit: 'abc1234',
    provenance: 'test',
    ...overrides,
  };
}

function statusOf(storePath: string, id: string): Record<string, unknown> {
  return matter(fs.readFileSync(path.join(storePath, 'cards', `${id}.md`), 'utf-8')).data;
}

describe('extractSha / repoCandidates', () => {
  it('takes the first sha-shaped token and ignores hex-only words', () => {
    expect(extractSha('d33d8a34')).toBe('d33d8a34');
    expect(extractSha("'9f1c2ab0 (story 5.26, epic/5)'")).toBe('9f1c2ab0');
    expect(extractSha('ticket 12345678 then 0a1b2c3d')).toBe('0a1b2c3d');
    expect(extractSha('defaced decade')).toBeNull();
    expect(extractSha('working tree')).toBeNull();
  });

  it('falls back to an all-digit token (a real abbreviation can be all digits), after any mixed token', () => {
    expect(extractSha('1234567')).toBe('1234567');
    expect(extractSha('commit 20261124 on main')).toBe('20261124');
    expect(extractSha('1234567 and 12345678')).toBe('1234567');
    expect(extractSha('1234567 then 0a1b2c3d')).toBe('0a1b2c3d');
    expect(extractSha('123456')).toBeNull(); // shorter than 7
  });

  it('treats source_repo as authoritative and falls back to applies_to', () => {
    expect(repoCandidates({ source_repo: 'acme/billing-api', applies_to: ['other'] })).toEqual([
      { full: 'acme/billing-api', name: 'billing-api' },
    ]);
    expect(repoCandidates({ applies_to: ['acme/billing-api', 'billing-api', 'not a repo!'] })).toEqual([
      { full: 'acme/billing-api', name: 'billing-api' },
      { name: 'billing-api' },
    ]);
  });
});

describe('runPromotion', () => {
  let tmp: string;
  let storePath: string;
  let repo: string;
  let db: Database.Database;
  let ghCalls: string[][];
  let ghReplies: Record<string, string>;
  let runner: CommandRunner;

  // Real git for both the knowledge store and the demo repo; only `gh` is stubbed.
  const opts = (o: Partial<PromotionOptions> = {}): PromotionOptions => ({
    mode: 'auto',
    autoTypes: ['decision', 'pattern'],
    repoRoots: [],
    fetch: false,
    botName: 'merge-bot',
    dryRun: false,
    runner,
    clones: new Map([['demo-repo', [repo]]]),
    ...o,
  });

  let base: string;
  let feature: string;
  let unmerged: string;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cardloom-promotion-'));
    storePath = path.join(tmp, 'store');
    repo = path.join(tmp, 'demo-repo');
    fs.mkdirSync(storePath);
    fs.mkdirSync(repo);
    await initKnowledgeStore(storePath);
    db = getDatabase(path.join(storePath, '.metadata', 'index.db'));

    gitIn(repo, ['init', '-q', '-b', 'main']);
    base = commit(repo, 'base.txt');
    gitIn(repo, ['checkout', '-q', '-b', 'feature']);
    feature = commit(repo, 'feature.txt');
    // Fixture invariant: the abbreviations the tests below take from this hash must be accepted as a sha.
    for (const n of [8, 10]) expect(extractSha(feature.slice(0, n))).not.toBeNull();
    gitIn(repo, ['checkout', '-q', '-b', 'wip', 'main']);
    unmerged = commit(repo, 'wip.txt');
    gitIn(repo, ['checkout', '-q', 'main']);

    ghCalls = [];
    ghReplies = {};
    const real = defaultRunner();
    runner = {
      git: real.git,
      gh: async (args) => {
        ghCalls.push(args);
        const key = args.slice(0, 2).join(' ');
        return key in ghReplies ? { code: 0, stdout: ghReplies[key]!, stderr: '' } : { code: 1, stdout: '', stderr: 'stub' };
      },
    };
  });

  afterEach(() => {
    closeDatabase();
    resetGit();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** Merge `feature` into main with a merge commit dated after the cards were written. */
  const mergeFeatureLater = () => gitIn(repo, ['merge', '-q', '--no-ff', '-m', 'merge feature', 'feature'], FUTURE);

  it('auto-verifies a pattern whose commit was merged after the card was written', async () => {
    const { id } = await saveLearningDraft(db, storePath, draft({ source_commit: feature.slice(0, 10) }));
    mergeFeatureLater();

    const report = await runPromotion(db, storePath, opts());

    expect(report.entries.map((e) => [e.id, e.decision])).toEqual([[id, 'verified']]);
    const fm = statusOf(storePath, id);
    expect(fm['status']).toBe('verified');
    expect(fm['verified_by']).toBe('merge-bot');
    expect(fm['verification_method']).toMatch(new RegExp(`^merged:demo-repo@${feature.slice(0, 12)} \\(merge-commit `));
  });

  it('dates a commit made straight on the default branch by its own date (first-parent)', async () => {
    const { id } = await saveLearningDraft(db, storePath, draft({}));
    const direct = commit(repo, 'direct.txt', FUTURE);
    fs.writeFileSync(
      path.join(storePath, 'cards', `${id}.md`),
      fs.readFileSync(path.join(storePath, 'cards', `${id}.md`), 'utf-8').replace(/source_commit: .*/, `source_commit: ${direct}`),
    );

    const report = await runPromotion(db, storePath, opts({ dryRun: true }));

    expect(report.entries[0]).toMatchObject({ decision: 'would_verify' });
    expect(report.entries[0]!.resolution?.via).toBe('first-parent');
  });

  it('promotes a commit whose abbreviation is made only of digits', async () => {
    // Hashes are deterministic here, so this search always stops at the same commit.
    let digits = '';
    for (let i = 0; i < 400 && !digits; i++) {
      const h = commit(repo, `digits-${i}.txt`, FUTURE);
      if (/^[0-9]{7}$/.test(h.slice(0, 7))) digits = h.slice(0, 7);
    }
    expect(digits).not.toBe('');
    const { id } = await saveLearningDraft(db, storePath, draft({ source_commit: digits }));

    const report = await runPromotion(db, storePath, opts({ dryRun: true }));

    expect(report.entries.map((e) => [e.id, e.decision])).toEqual([[id, 'would_verify']]);
  });

  it('skips a ticket number that is not a commit in the repo as unresolvable, not as "no sha"', async () => {
    await saveLearningDraft(db, storePath, draft({ source_commit: 'ticket 1234567' }));
    const report = await runPromotion(db, storePath, opts({ dryRun: true }));
    expect(report.entries[0]).toMatchObject({ decision: 'skipped' });
    expect(report.entries[0]!.reason).toMatch(/^unresolvable:/);
  });

  it('skips a card about code that was already on main when it was written', async () => {
    await saveLearningDraft(db, storePath, draft({ source_commit: base }));
    const report = await runPromotion(db, storePath, opts());
    expect(report.entries[0]).toMatchObject({ decision: 'skipped', reason: 'commit was already on the default branch when the card was written' });
  });

  it('skips an unmerged commit and a learning from uncommitted work', async () => {
    await saveLearningDraft(db, storePath, draft({ title: 'A unmerged', source_commit: unmerged }));
    await saveLearningDraft(db, storePath, draft({ title: 'B wip', source_commit: `${feature.slice(0, 8)} working tree 2026-10-16` }));
    mergeFeatureLater();

    const report = await runPromotion(db, storePath, opts());

    expect(report.entries.map((e) => e.reason)).toEqual([
      'not merged yet',
      'learning came from uncommitted work on top of the sha',
    ]);
  });

  it('leaves non-auto types, restricted cards and superseding cards as candidates, still draft', async () => {
    const gotcha = await saveLearningDraft(db, storePath, draft({ title: 'A gotcha', type: 'gotcha', error_signature: 'boom', source_commit: feature }));
    const restricted = await saveLearningDraft(db, storePath, draft({ title: 'B restricted', sensitivity: 'restricted', source_commit: feature }));
    const old = await saveLearningDraft(db, storePath, draft({ title: 'Old', source_commit: 'no sha here' }));
    const sup = await saveLearningDraft(db, storePath, draft({ title: 'C sup', supersedes: old.id, source_commit: feature }));
    mergeFeatureLater();

    const report = await runPromotion(db, storePath, opts());
    const mine = new Set([gotcha.id, restricted.id, sup.id]);

    expect(report.entries.filter((e) => mine.has(e.id)).map((e) => [e.decision, e.reason])).toEqual([
      ['candidate', 'type "gotcha" is not in PROMOTION_AUTO_TYPES'],
      ['candidate', 'restricted card'],
      ['candidate', `supersedes ${old.id}`],
    ]);
    for (const { id } of [gotcha, restricted, sup]) expect(statusOf(storePath, id)['status']).toBe('draft');
  });

  it('review mode lists the card and writes nothing; off mode looks at nothing', async () => {
    const { id } = await saveLearningDraft(db, storePath, draft({ source_commit: feature }));
    mergeFeatureLater();

    const review = await runPromotion(db, storePath, opts({ mode: 'review' }));
    expect(review.entries[0]).toMatchObject({ decision: 'candidate', reason: 'mode is review' });
    expect(statusOf(storePath, id)['status']).toBe('draft');

    const off = await runPromotion(db, storePath, opts({ mode: 'off' }));
    expect(off).toMatchObject({ checked: 0, entries: [] });
  });

  it('finds a squash-merged commit through the pull request when the clone never had it', async () => {
    gitIn(repo, ['remote', 'add', 'origin', 'https://github.com/acme/demo-repo.git']);
    const sha = 'f00dfeed1234567890abcdef1234567890abcdef';
    const { id } = await saveLearningDraft(db, storePath, draft({ source_commit: sha, source_repo: 'acme/demo-repo' }));
    ghReplies[`api repos/acme/demo-repo/commits/${sha}`] = `${sha}\t${PAST}`;
    ghReplies['api repos/acme/demo-repo'] = 'main';
    ghReplies[`api repos/acme/demo-repo/commits/${sha}/pulls`] = JSON.stringify([
      { merged_at: null, base: { ref: 'main' } },
      { merged_at: FUTURE, base: { ref: 'main' } },
    ]);

    const report = await runPromotion(db, storePath, opts());

    expect(report.entries[0]).toMatchObject({ id, decision: 'verified' });
    expect(report.entries[0]!.resolution?.via).toBe('pull-request');
  });

  it('does not let a clone with a different GitHub remote answer for source_repo', async () => {
    gitIn(repo, ['remote', 'add', 'origin', 'https://github.com/someone-else/demo-repo.git']);
    mergeFeatureLater();
    await saveLearningDraft(db, storePath, draft({ source_commit: feature, source_repo: 'acme/demo-repo' }));

    const report = await runPromotion(db, storePath, opts());

    expect(report.entries[0]!.decision).toBe('skipped');
    expect(ghCalls.some((a) => a[1]?.startsWith('repos/acme/demo-repo'))).toBe(true);
  });
});
