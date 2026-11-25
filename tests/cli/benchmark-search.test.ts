import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  buildFreshIndex,
  compareLimits,
  compareLimitsByRanking,
  formatLimitComparison,
  runBenchmarkCli,
  findMissingExpected,
  corpusFingerprint,
  findInvisibleExpected,
  formatReport,
  parseQueriesYaml,
  runBenchmark,
  syntheticQueries,
} from '../../src/cli/benchmark.js';
import { handleSearchKnowledge } from '../../src/tools/search-knowledge.js';

// A pass-through spy so one test can change what the tool serialises; every other test sees the real handler.
vi.mock('../../src/tools/search-knowledge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/tools/search-knowledge.js')>();
  return { ...actual, handleSearchKnowledge: vi.fn(actual.handleSearchKnowledge) };
});

const FIXTURE_STORE = fileURLToPath(new URL('../fixtures/benchmark-store', import.meta.url));

function card(type: string, title: string): string {
  return `---
type: ${type}
scope: project
applies_to: [api]
stack: [node]
version_range: ">=1.0.0"
sensitivity: normal
source_commit: abc123
provenance: agent-observation
title: ${title}
${type === 'gotcha' ? 'error_signature: "TypeError: boom"\n' : ''}status: verified
verified_by: tester
verification_method: manual-review
verified_at: "2026-01-01T00:00:00.000Z"
last_verified: "2026-01-01T00:00:00.000Z"
---
Body for ${title}.
`;
}

describe('benchmark against a fresh index', () => {
  let store: string;

  beforeEach(() => {
    store = fs.mkdtempSync(path.join(os.tmpdir(), 'cardloom-mcp-bench-'));
    const cardsDir = path.join(store, 'cards');
    fs.mkdirSync(cardsDir, { recursive: true });
    fs.writeFileSync(path.join(cardsDir, 'pattern-a.md'), card('pattern', 'Pattern A'));
    fs.writeFileSync(path.join(cardsDir, 'gotcha-b.md'), card('gotcha', 'Gotcha B'));
  });

  afterEach(() => {
    fs.rmSync(store, { recursive: true, force: true });
  });

  it('buildFreshIndex indexes every card file in the store', async () => {
    const db = await buildFreshIndex(store);
    expect(db.prepare('SELECT count(*) c FROM cards').get()).toEqual({ c: 2 });
    db.close();
  });

  it('findMissingExpected lists expected ids that are not in the index', async () => {
    const db = await buildFreshIndex(store);
    expect(
      findMissingExpected(db, [
        { query: 'x', expected: 'pattern-a' },
        { query: 'y', expected: 'gone-1' },
        { query: 'z', expected: 'gone-1' },
      ]),
    ).toEqual(['gone-1']);
    expect(findMissingExpected(db, [{ query: 'x', expected: 'pattern-a' }])).toEqual([]);
    db.close();
  });

  it('findMissingExpected returns ids sorted', async () => {
    const db = await buildFreshIndex(store);
    expect(
      findMissingExpected(db, [
        { query: 'x', expected: 'zeta' },
        { query: 'y', expected: 'alpha' },
      ]),
    ).toEqual(['alpha', 'zeta']);
    db.close();
  });

  it('corpusFingerprint counts cards and changes when a card status changes', async () => {
    const db = await buildFreshIndex(store);
    const before = corpusFingerprint(db);
    expect(before.cards).toBe(2);
    expect(before.verified).toBe(2);
    expect(before.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(corpusFingerprint(db).sha256).toBe(before.sha256);

    db.prepare("UPDATE cards SET status = 'deprecated' WHERE id = 'gotcha-b'").run();
    const after = corpusFingerprint(db);
    expect(after.verified).toBe(1);
    expect(after.sha256).not.toBe(before.sha256);
    db.close();
  });
});

interface CardOpts {
  type?: string;
  title: string;
  status?: 'verified' | 'draft' | 'deprecated';
  sensitivity?: 'normal' | 'restricted';
  appliesTo?: string;
  signature?: string;
  body?: string;
  stack?: string;
  versionRange?: string;
  lastVerified?: string;
  supersedes?: string;
  deprecationReason?: string;
}

function cardFile(o: CardOpts): string {
  const type = o.type ?? 'pattern';
  const status = o.status ?? 'verified';
  const verified = status === 'verified';
  const lastVerified = o.lastVerified ?? '2026-01-01T00:00:00.000Z';
  return `---
type: ${type}
scope: project
applies_to: [${o.appliesTo ?? 'api'}]
stack: [${o.stack ?? 'node'}]
version_range: "${o.versionRange ?? '>=1.0.0'}"
${o.supersedes ? `supersedes: ${o.supersedes}\n` : ''}sensitivity: ${o.sensitivity ?? 'normal'}
source_commit: abc123
provenance: agent-observation
title: ${o.title}
${o.signature ? `error_signature: "${o.signature}"\n` : ''}status: ${status}
${verified ? `verified_by: tester
verification_method: manual-review
verified_at: "2026-01-01T00:00:00.000Z"
last_verified: "${lastVerified}"
` : ''}${status === 'deprecated' ? `deprecation_reason: ${o.deprecationReason ?? 'superseded'}
deprecated_at: "2026-02-01T00:00:00.000Z"
deprecated_by: tester
` : ''}---
${o.body ?? `Body for ${o.title}.`}
`;
}

describe('benchmark v2', () => {
  let store: string;

  function writeCards(cards: Record<string, CardOpts>): void {
    const cardsDir = path.join(store, 'cards');
    fs.mkdirSync(cardsDir, { recursive: true });
    for (const [id, o] of Object.entries(cards)) fs.writeFileSync(path.join(cardsDir, `${id}.md`), cardFile(o));
  }

  beforeEach(() => {
    store = fs.mkdtempSync(path.join(os.tmpdir(), 'cardloom-mcp-bench2-'));
  });

  afterEach(() => {
    fs.rmSync(store, { recursive: true, force: true });
  });

  it('missing queries: tiered returns a related result, never a confident false answer (R1)', async () => {
    writeCards({
      'pattern-alpha': { title: 'Alpha retry policy' },
      'pattern-beta': { title: 'Beta cache layer' },
      'pattern-gamma': { title: 'Gamma queue workers' },
      'pattern-delta': { title: 'Delta index rebuild' },
    });
    const db = await buildFreshIndex(store);
    const queries = [{ query: 'zqxv7000 queue', kind: 'missing' as const }];

    const off = runBenchmark(db, queries, { ranking: 'baseline', fallback: 'off' });
    const tiered = runBenchmark(db, queries, { ranking: 'baseline', fallback: 'tiered' });

    expect(off.byKind.missing).toMatchObject({ n: 1, falseAnswerRate: 0, anyResultRate: 0 });
    expect(tiered.byKind.missing).toMatchObject({ n: 1, falseAnswerRate: 0, anyResultRate: 1 });
    db.close();
  });

  it('missing queries: a top-1 that is not labelled related counts as a false answer', async () => {
    writeCards({ 'pattern-alpha': { title: 'Alpha retry policy' } });
    const db = await buildFreshIndex(store);
    const report = runBenchmark(db, [{ query: 'Alpha retry policy', kind: 'missing' }]);
    expect(report.byKind.missing).toMatchObject({ falseAnswerRate: 1, anyResultRate: 1 });
    expect(report.misses).toHaveLength(1);
    db.close();
  });

  it('wrongProjectTop1Rate differs between ranking x and y', async () => {
    writeCards({
      'decision-a': { type: 'decision', title: 'Retry policy', appliesTo: 'proj-a', body: 'retry policy body' },
      'gotcha-b': { type: 'gotcha', title: 'Title for gotcha-b', appliesTo: 'proj-b', signature: 'RETRY_EXHAUSTED', body: 'retry policy body' },
    });
    const db = await buildFreshIndex(store);
    const queries = [
      {
        query: 'RETRY_EXHAUSTED retry policy',
        kind: 'project_decision' as const,
        expected: 'decision-a',
        forbidden: ['gotcha-b'],
        context: { project: 'proj-a', stack: ['node'] },
      },
    ];
    const x = runBenchmark(db, queries, { ranking: 'x', fallback: 'tiered' });
    const y = runBenchmark(db, queries, { ranking: 'y', fallback: 'tiered' });
    expect(x.byKind.project_decision).toMatchObject({ n: 1, hit1: 1, wrongProjectTop1Rate: 0 });
    expect(y.byKind.project_decision).toMatchObject({ n: 1, hit1: 0, wrongProjectTop1Rate: 1 });
    db.close();
  });

  it('known and cross_project report hit1, mrr5 and recall5 (any id in expected)', async () => {
    writeCards({
      'pattern-alpha': { title: 'Alpha retry policy', body: 'alpha body shared words' },
      'pattern-beta': { title: 'Beta cache layer', body: 'beta body shared words' },
    });
    const db = await buildFreshIndex(store);
    // Both cards match 'shared words'; whichever ranks first, the other is rank 2 -> hit1 0.5, mrr5 0.75.
    const report = runBenchmark(db, [
      { query: 'shared words', expected: 'pattern-alpha' },
      { query: 'shared words', expected: 'pattern-beta' },
      { query: 'shared words', kind: 'cross_project', expected: ['pattern-alpha', 'pattern-beta'] },
      { query: 'Beta cache layer', kind: 'cross_project', expected: 'pattern-alpha' },
    ]);
    expect(report.byKind.known).toMatchObject({ n: 2, hit1: 0.5, recall5: 1 });
    expect(report.byKind.known!.mrr5).toBeCloseTo(0.75);
    expect(report.byKind.cross_project).toMatchObject({ n: 2, hit1: 0.5, recall5: 0.5 });
    expect(report.byKind.cross_project!.mrr5).toBeCloseTo(0.5);
    db.close();
  });

  it('syntheticQueries emits 100 missing queries and one title query per verified normal card', async () => {
    writeCards({
      'pattern-alpha': { title: 'Alpha retry policy for flaky upstream calls in production services' },
      'gotcha-beta': { type: 'gotcha', title: 'Beta cache layer', signature: 'TypeError: boom' },
      'pattern-draft': { title: 'Draft card', status: 'draft' },
      'pattern-secret': { title: 'Secret card', sensitivity: 'restricted' },
    });
    const db = await buildFreshIndex(store);
    const qs = syntheticQueries(db);
    expect(qs.filter((q) => q.kind === 'missing')).toHaveLength(100);
    expect(qs.filter((q) => q.group === 'title').map((q) => q.expected).sort()).toEqual(['gotcha-beta', 'pattern-alpha']);
    expect(qs.filter((q) => q.group === 'title_nl')).toHaveLength(2);
    expect(qs.find((q) => q.group === 'title_nl' && q.expected === 'pattern-alpha')!.query).toBe(
      'how do I fix Alpha retry policy for flaky upstream calls problem in my project',
    );
    const sig = qs.filter((q) => q.group === 'sig_noisy');
    expect(sig.map((q) => q.query)).toEqual(['Error: TypeError: boom at line 42 (node:12345)']);
    expect(qs.find((q) => q.kind === 'missing')!.query).toBe('zqxv7000 error');
    expect(qs.filter((q) => q.kind === 'missing')[1]!.query).toBe('zqxv7013 error');
    db.close();
  });

  it('syntheticQueries throws when a fabricated missing token actually has FTS hits', async () => {
    writeCards({ 'pattern-collide': { title: 'Collide', body: 'mentions zqxv7013 explicitly' } });
    const db = await buildFreshIndex(store);
    expect(() => syntheticQueries(db)).toThrow(/zqxv7013/);
    db.close();
  });

  it('findMissingExpected checks expected lists and forbidden ids', async () => {
    writeCards({ 'pattern-alpha': { title: 'Alpha' } });
    const db = await buildFreshIndex(store);
    expect(
      findMissingExpected(db, [
        { query: 'x', expected: ['pattern-alpha', 'gone-2'], forbidden: ['gone-1'] },
        { query: 'y', kind: 'missing', forbidden: ['pattern-alpha'] },
      ]),
    ).toEqual(['gone-1', 'gone-2']);
    db.close();
  });

  it('findInvisibleExpected lists expected ids that default search would never return', async () => {
    writeCards({
      'pattern-alpha': { title: 'Alpha' },
      'pattern-draft': { title: 'Draft card', status: 'draft' },
      'pattern-secret': { title: 'Secret card', sensitivity: 'restricted' },
    });
    const db = await buildFreshIndex(store);
    expect(
      findInvisibleExpected(db, [
        { query: 'x', expected: ['pattern-alpha', 'pattern-draft'] },
        { query: 'y', expected: 'pattern-secret' },
      ]),
    ).toEqual(['pattern-draft', 'pattern-secret']);
    db.close();
  });

  it('parseQueriesYaml keeps legacy entries as kind known and accepts the new fields', () => {
    const parsed = parseQueriesYaml(`
- query: "a"
  expected: card-a
- query: "b"
  kind: project_decision
  expected: [card-b, card-c]
  forbidden: [card-d]
- query: "c"
  kind: missing
`);
    expect(parsed[0]).toMatchObject({ query: 'a', expected: 'card-a' });
    expect(parsed[0]!.kind ?? 'known').toBe('known');
    expect(parsed[1]).toMatchObject({ kind: 'project_decision', expected: ['card-b', 'card-c'], forbidden: ['card-d'] });
    expect(parsed[2]).toMatchObject({ kind: 'missing' });
    expect(() => parseQueriesYaml('- query: "z"\n')).toThrow(/expected/);
    expect(() => parseQueriesYaml('- query: "z"\n  kind: nope\n  expected: a\n')).toThrow(/kind/);
  });

  it('parseQueriesYaml rejects kind-specific field misuse', () => {
    expect(() => parseQueriesYaml('- query: "z"\n  kind: project_decision\n  expected: a\n')).toThrow(/forbidden/);
    expect(() => parseQueriesYaml('- query: "z"\n  kind: missing\n  expected: a\n')).toThrow(/missing.*expected|expected.*missing/);
    expect(() => parseQueriesYaml('- query: "z"\n  expected: a\n  forbidden: [b]\n')).toThrow(/forbidden/);
    expect(() => parseQueriesYaml('- query: "z"\n  kind: cross_project\n  expected: a\n  forbidden: [b]\n')).toThrow(/forbidden/);
    expect(() =>
      parseQueriesYaml('- query: "z"\n  kind: project_decision\n  expected: a\n  forbidden: [b]\n'),
    ).not.toThrow();
  });

  it('headline uses scored queries (those with expected) as the denominator, not all queries', async () => {
    writeCards({ 'pattern-alpha': { title: 'Alpha retry policy' } });
    const db = await buildFreshIndex(store);
    const report = runBenchmark(db, [
      { query: 'Alpha retry policy', expected: 'pattern-alpha' },
      { query: 'zqxv7000 error', kind: 'missing' },
      { query: 'zqxv7013 error', kind: 'missing' },
    ]);
    expect(report.total).toBe(3);
    expect(report.scored).toBe(1);
    expect(formatReport(report).split('\n')[0]).toBe('[benchmark] 1/1 top-1 hits (100.0%) across 1 scored of 3 queries');
    db.close();
  });
  describe('failure-type kinds', () => {
    const NOW = new Date('2026-06-01T00:00:00.000Z');

    it('superseded: replacedVisibleRate is 0 when the replaced card is deprecated, 1 when it was left verified', async () => {
      writeCards({
        'decision-retry-old': {
          type: 'decision',
          title: 'Retry policy v1',
          status: 'deprecated',
          deprecationReason: 'superseded by decision-retry-new',
          body: 'retry policy fixed delay',
        },
        'decision-retry-new': {
          type: 'decision',
          title: 'Retry policy v2',
          supersedes: 'decision-retry-old',
          body: 'retry policy exponential backoff',
        },
      });
      const db = await buildFreshIndex(store);
      const q = {
        query: 'retry policy',
        kind: 'superseded' as const,
        expected: 'decision-retry-new',
        replaced: 'decision-retry-old',
      };
      const good = runBenchmark(db, [q], { now: NOW });
      expect(good.byKind.superseded).toEqual({ n: 1, hit1: 1, mrr5: 1, replacedVisibleRate: 0 });
      db.close();

      // As after a hand edit: the new card declares `supersedes`, the old one was left verified.
      fs.rmSync(path.join(store, 'cards'), { recursive: true });
      writeCards({
        'decision-retry-old': { type: 'decision', title: 'Retry policy v1', body: 'retry policy fixed delay' },
        'decision-retry-new': {
          type: 'decision',
          title: 'Retry policy v2',
          supersedes: 'decision-retry-old',
          body: 'retry policy exponential backoff',
        },
      });
      const db2 = await buildFreshIndex(store);
      const bad = runBenchmark(db2, [q], { now: NOW });
      expect(bad.byKind.superseded).toMatchObject({ n: 1, replacedVisibleRate: 1 });
      db2.close();
    });

    it('stale: retrievedRate counts expected in top 5, flagAccuracy only the retrieved ones carrying flags.stale', async () => {
      writeCards({
        'pattern-old-cache': {
          title: 'Cache invalidation old',
          body: 'invalidate cache entries',
          lastVerified: '2025-04-27T00:00:00.000Z', // 400 days before NOW
        },
        'pattern-fresh-cache': { title: 'Cache invalidation fresh', body: 'invalidate cache entries' },
        'pattern-unrelated': { title: 'Queue workers', body: 'sharding workers' },
      });
      const db = await buildFreshIndex(store);
      const report = runBenchmark(
        db,
        [
          { query: 'invalidate cache entries', kind: 'stale', expected: 'pattern-old-cache' }, // retrieved + flagged
          { query: 'invalidate cache entries', kind: 'stale', expected: 'pattern-fresh-cache' }, // retrieved, not flagged
          { query: 'invalidate cache entries', kind: 'stale', expected: 'pattern-unrelated' }, // not retrieved
        ],
        { now: NOW },
      );
      expect(report.byKind.stale).toEqual({ n: 3, retrievedRate: 2 / 3, flagAccuracy: 0.5 });
      db.close();
    });

    it('drift: flagAccuracy is the share of retrieved cards flagged drift for the caller versions', async () => {
      writeCards({
        'pattern-api-v2': { title: 'Api pagination v2', versionRange: '>=2 <3', body: 'pagination cursor' },
        'pattern-api-v3': { title: 'Api pagination v3', versionRange: '>=3 <4', body: 'pagination cursor' },
      });
      const db = await buildFreshIndex(store);
      const context = { stack: ['node'], versions: { node: '3.1.0' } };
      const report = runBenchmark(db, [
        { query: 'pagination cursor', kind: 'drift', expected: 'pattern-api-v2', context }, // drifted: flagged
        { query: 'pagination cursor', kind: 'drift', expected: 'pattern-api-v3', context }, // in range: not flagged
      ]);
      expect(report.byKind.drift).toEqual({ n: 2, retrievedRate: 1, flagAccuracy: 0.5 });
      db.close();
    });

    it('wrong_scope: wrongScopeTop1Rate counts a forbidden top-1 flagged or not, wrongTop1FlaggedRate only the drift-flagged ones', async () => {
      writeCards({
        // Drifts for node 3.1.0; most keyword hits, and no caller-stack match for either card, so it ranks first.
        'pattern-node-v2': {
          title: 'Lookup cache',
          versionRange: '>=2 <3',
          body: 'lookup cache lookup cache lookup cache lookup cache',
        },
        'pattern-python-cache': { title: 'Lookup cache python', stack: 'python', versionRange: '>=3', body: 'lookup cache' },
      });
      const db = await buildFreshIndex(store);
      const withVersions = { stack: ['node'], versions: { node: '3.1.0' } };
      const forbidden = ['pattern-node-v2'];
      const base = { kind: 'wrong_scope' as const, expected: 'pattern-python-cache', forbidden };
      const report = runBenchmark(db, [
        { ...base, query: 'lookup cache', context: withVersions }, // forbidden first, flagged drift
        { ...base, query: 'lookup cache', context: { stack: ['node'] } }, // forbidden first, not flagged
        { ...base, query: 'python', context: withVersions }, // only the expected card matches
      ]);
      expect(report.byKind.wrong_scope).toMatchObject({
        n: 3,
        hit1: 1 / 3,
        wrongScopeTop1Rate: 2 / 3,
        wrongTop1FlaggedRate: 0.5,
      });
      db.close();
    });

    it('parseQueriesYaml names the query and the missing field for each new kind', () => {
      expect(() => parseQueriesYaml('- query: "q1"\n  kind: superseded\n  expected: a\n')).toThrow(/index 0.*"replaced"/);
      expect(() => parseQueriesYaml('- query: "q1"\n  kind: drift\n  expected: a\n')).toThrow(/index 0.*context\.versions/);
      expect(() =>
        parseQueriesYaml('- query: "q1"\n  kind: drift\n  expected: a\n  context: {stack: [node]}\n'),
      ).toThrow(/context\.versions/);
      expect(() => parseQueriesYaml('- query: "q1"\n  kind: wrong_scope\n  expected: a\n')).toThrow(/index 0.*"forbidden"/);
      expect(() => parseQueriesYaml('- query: "q1"\n  kind: wrong_scope\n  expected: a\n  forbidden: []\n')).toThrow(/"forbidden"/);
      expect(() => parseQueriesYaml('- query: "q1"\n  kind: stale\n  expected: a\n  replaced: b\n')).toThrow(/"replaced".*superseded/);
      const ok = parseQueriesYaml(`
- query: "q1"
  kind: superseded
  expected: a
  replaced: b
- query: "q2"
  kind: stale
  expected: a
- query: "q3"
  kind: drift
  expected: a
  context: {stack: [node], versions: {node: "3.1.0"}}
- query: "q4"
  kind: wrong_scope
  expected: a
  forbidden: [b]
`);
      expect(ok.map((q) => q.kind)).toEqual(['superseded', 'stale', 'drift', 'wrong_scope']);
    });

    it('findMissingExpected also checks the replaced id', async () => {
      writeCards({ 'pattern-alpha': { title: 'Alpha' } });
      const db = await buildFreshIndex(store);
      expect(
        findMissingExpected(db, [{ query: 'x', kind: 'superseded', expected: 'pattern-alpha', replaced: 'gone-1' }]),
      ).toEqual(['gone-1']);
      db.close();
    });

    it('formatReport prints visible, retrieved, flag acc and wrong@1 for the new kinds', () => {
      const text = formatReport({
        total: 4,
        scored: 4,
        hits: 0,
        hitRatePercent: 0,
        byKind: {},
        byGroup: {
          superseded: { kind: 'superseded', n: 1, hit1: 1, mrr5: 1, replacedVisibleRate: 0.25 },
          stale: { kind: 'stale', n: 1, retrievedRate: 0.5, flagAccuracy: 0.75 },
          wrong_scope: { kind: 'wrong_scope', n: 1, hit1: 0, wrongScopeTop1Rate: 1, wrongTop1FlaggedRate: 0.5 },
        },
        p50Ms: 0,
        p95Ms: 0,
        estimatedResponseTokens: { mean: 0, p95: 0 },
        misses: [],
      });
      expect(text).toContain('visible=25.0%');
      expect(text).toContain('retrieved=50.0% flag acc=75.0%');
      expect(text).toContain('wrong@1=100.0% flagged@1=50.0%');
    });
  });
});

describe('compare limits on the committed fixture store', () => {
  let db: Awaited<ReturnType<typeof buildFreshIndex>>;
  let queries: ReturnType<typeof parseQueriesYaml>;
  const round1 = (): typeof queries => queries.filter((q) => q.group === 'round1');

  beforeEach(async () => {
    db = await buildFreshIndex(FIXTURE_STORE);
    queries = parseQueriesYaml(fs.readFileSync(path.join(FIXTURE_STORE, 'benchmark', 'queries.yaml'), 'utf-8'));
  });

  afterEach(async () => {
    db.close();
    const actual = await vi.importActual<typeof import('../../src/tools/search-knowledge.js')>('../../src/tools/search-knowledge.js');
    vi.mocked(handleSearchKnowledge).mockImplementation(actual.handleSearchKnowledge);
    vi.mocked(handleSearchKnowledge).mockClear();
  });

  it('the fixture is self-consistent: every expected id exists and is visible by default', () => {
    expect(queries.length).toBeGreaterThanOrEqual(20);
    expect(findMissingExpected(db, queries)).toEqual([]);
    expect(findInvisibleExpected(db, queries)).toEqual([]);
  });

  it('ranking x with the caller project: limit 10 puts the OR-tier acme/app card first, limit 5 never returns it', () => {
    const { at5, at10 } = compareLimits(db, round1(), { ranking: 'x', fallback: 'tiered' });
    expect(at10.byKind.known).toMatchObject({ n: 1, hit1: 1, recall5: 1, recall10: 1 });
    expect(at5.byKind.known).toMatchObject({ n: 1, hit1: 0, recall5: 0 });
    expect(at5.byKind.known?.recall10).toBeUndefined();
    expect(at5.misses).toEqual([
      expect.objectContaining({ query: 'webhook retry backoff', expected: 'decision-webhook-retry-limit-acme' }),
    ]);
    expect(at5.misses[0]!.actual_top1).toMatch(/^pattern-webhook-retry-backoff-/);
  });

  it('runs the search twice, once per limit, through handleSearchKnowledge', () => {
    compareLimits(db, round1(), { ranking: 'x', fallback: 'tiered' });
    const limits = vi.mocked(handleSearchKnowledge).mock.calls.map(([, args]) => args.limit);
    expect(limits).toEqual([5, 10]);
  });

  it('recall10 is reported only for runs with limit >= 10', () => {
    const { at5, at10 } = compareLimits(db, queries, { ranking: 'baseline' });
    expect(at5.byKind.known?.recall10).toBeUndefined();
    expect(at10.byKind.known?.recall10).toBeGreaterThanOrEqual(at10.byKind.known!.recall5!);
    expect(runBenchmark(db, queries, { limit: 5 }).byKind.known?.recall10).toBeUndefined();
    expect(runBenchmark(db, queries, { limit: 10 }).byKind.known?.recall10).toBeDefined();
  });

  it('estimated response tokens are smaller at limit 5 than at limit 10', () => {
    const { at5, at10 } = compareLimits(db, queries, { ranking: 'baseline' });
    expect(at5.estimatedResponseTokens.mean).toBeGreaterThan(0);
    expect(at5.estimatedResponseTokens.mean).toBeLessThan(at10.estimatedResponseTokens.mean);
    expect(at5.estimatedResponseTokens.p95).toBeLessThanOrEqual(at10.estimatedResponseTokens.p95);
  });

  it('the token estimate is computed from the tool JSON: a field added by the serializer changes it', async () => {
    const actual = await vi.importActual<typeof import('../../src/tools/search-knowledge.js')>('../../src/tools/search-knowledge.js');
    const before = runBenchmark(db, queries, { limit: 5 }).estimatedResponseTokens;

    vi.mocked(handleSearchKnowledge).mockImplementation((d, args, overrides) => {
      const response = actual.handleSearchKnowledge(d, args, overrides);
      const parsed = JSON.parse(response.content[0].text) as Record<string, unknown>;
      parsed['extra_field'] = 'x'.repeat(400);
      return { content: [{ type: 'text' as const, text: JSON.stringify(parsed) }] };
    });
    const after = runBenchmark(db, queries, { limit: 5 }).estimatedResponseTokens;

    // ',"extra_field":"' + 400 chars + '"' is about 417 chars, so about 104 tokens per response.
    expect(after.mean - before.mean).toBeGreaterThan(100);
    expect(after.mean - before.mean).toBeLessThan(110);
    expect(after.p95).toBeGreaterThan(before.p95);
  });

  it('compareLimitsByRanking covers baseline, x and y with an independent real run each', () => {
    vi.mocked(handleSearchKnowledge).mockClear();
    const byRanking = compareLimitsByRanking(db, round1());
    expect(Object.keys(byRanking)).toEqual(['baseline', 'x', 'y']);
    expect(vi.mocked(handleSearchKnowledge)).toHaveBeenCalledTimes(6);
    expect(byRanking.x.at10.byKind.known?.hit1).toBe(1);
  });

  it('measures tokens at the scored run\'s clock: a card stale only at the pinned now is flagged in both runs', () => {
    const staleQuery = {
      query: 'invalidate cache entries inside the write transaction',
      kind: 'stale' as const,
      expected: 'pattern-cache-invalidation-write',
    };
    const fresh = new Date('2026-11-25T00:00:00.000Z'); // 24 days after last_verified
    const stale = new Date('2028-01-01T00:00:00.000Z'); // well past the 180-day threshold

    const staleHandlerFlags = (now: Date): boolean[] => {
      vi.mocked(handleSearchKnowledge).mockClear();
      const report = runBenchmark(db, [staleQuery], { limit: 5, now });
      const [[, , overrides]] = vi.mocked(handleSearchKnowledge).mock.calls as unknown as [[unknown, unknown, { now?: Date }]];
      expect(overrides.now).toBe(now);
      const text = (vi.mocked(handleSearchKnowledge).mock.results[0]!.value as { content: Array<{ text: string }> }).content[0]!.text;
      const flags = (JSON.parse(text) as { results: Array<{ id: string; flags: { stale?: boolean } }> }).results
        .filter((r) => r.id === staleQuery.expected)
        .map((r) => r.flags.stale === true);
      // The scored run and the measured run agree on the flag.
      expect(report.byKind.stale).toMatchObject({ retrievedRate: 1, flagAccuracy: flags[0] ? 1 : 0 });
      return flags;
    };

    expect(staleHandlerFlags(fresh)).toEqual([false]);
    expect(staleHandlerFlags(stale)).toEqual([true]);
  });

  it('compareLimitsByRanking pins the tiered fallback: SEARCH_FALLBACK=off in the environment changes nothing', () => {
    const strip = (c: ReturnType<typeof compareLimitsByRanking>) =>
      Object.fromEntries(
        Object.entries(c).map(([ranking, { at5, at10 }]) => [
          ranking,
          [at5, at10].map(({ p50Ms: _a, p95Ms: _b, ...rest }) => rest),
        ]),
      );
    const previous = process.env['SEARCH_FALLBACK'];
    try {
      delete process.env['SEARCH_FALLBACK'];
      const unset = strip(compareLimitsByRanking(db, queries));
      process.env['SEARCH_FALLBACK'] = 'off';
      const off = strip(compareLimitsByRanking(db, queries));
      expect(off).toEqual(unset);
      // and the tier effect is still there: with the OR tier, limit 10 finds the acme/app card under x
      expect(compareLimitsByRanking(db, round1()).x.at10.byKind.known).toMatchObject({ hit1: 1 });
    } finally {
      if (previous === undefined) delete process.env['SEARCH_FALLBACK'];
      else process.env['SEARCH_FALLBACK'] = previous;
    }
  });

  it('formatLimitComparison labels token figures as estimated and shows recall per kind', () => {
    const text = formatLimitComparison(compareLimitsByRanking(db, queries));
    expect(text).toContain('ranking baseline');
    expect(text).toContain('ranking x');
    expect(text).toContain('ranking y');
    expect(text).toContain('recall@5 (limit 5)');
    expect(text).toContain('recall@10 (limit 10)');
    expect(text).toContain('estimated response tokens');
  });

  describe('CLI flags', () => {
    let logged: string[];
    let previousStore: string | undefined;

    beforeEach(() => {
      logged = [];
      previousStore = process.env['KNOWLEDGE_STORE_PATH'];
      process.env['KNOWLEDGE_STORE_PATH'] = FIXTURE_STORE;
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        logged.push(args.join(' '));
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
      if (previousStore === undefined) delete process.env['KNOWLEDGE_STORE_PATH'];
      else process.env['KNOWLEDGE_STORE_PATH'] = previousStore;
    });

    it('--compare-limits prints one table per ranking', async () => {
      await runBenchmarkCli(['--compare-limits']);
      const out = logged.join('\n');
      expect(out).toContain('ranking baseline');
      expect(out).toContain('ranking x');
      expect(out).toContain('ranking y');
      expect(out).toContain('estimated response tokens');
    });

    it('--limit N runs a single benchmark at that limit', async () => {
      await runBenchmarkCli(['--limit', '5']);
      const out = logged.join('\n');
      expect(out).toContain('top-1 hits');
      expect(out).not.toContain('recall@10');
      expect(out).toContain('estimated response tokens');
      logged.length = 0;
      await runBenchmarkCli(['--limit', '10']);
      expect(logged.join('\n')).toContain('recall@10');
    });

    it('--limit rejects a value that is not a positive integer', async () => {
      await expect(runBenchmarkCli(['--limit', 'abc'])).rejects.toThrow(/--limit/);
      await expect(runBenchmarkCli(['--limit'])).rejects.toThrow(/--limit/);
    });
  });
});
