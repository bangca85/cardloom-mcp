import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  buildFreshIndex,
  findMissingExpected,
  corpusFingerprint,
  findInvisibleExpected,
  parseQueriesYaml,
  runBenchmark,
  syntheticQueries,
} from '../../src/cli/benchmark.js';

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
  status?: 'verified' | 'draft';
  sensitivity?: 'normal' | 'restricted';
  appliesTo?: string;
  signature?: string;
  body?: string;
}

function cardFile(o: CardOpts): string {
  const type = o.type ?? 'pattern';
  const verified = (o.status ?? 'verified') === 'verified';
  return `---
type: ${type}
scope: project
applies_to: [${o.appliesTo ?? 'api'}]
stack: [node]
version_range: ">=1.0.0"
sensitivity: ${o.sensitivity ?? 'normal'}
source_commit: abc123
provenance: agent-observation
title: ${o.title}
${o.signature ? `error_signature: "${o.signature}"\n` : ''}status: ${o.status ?? 'verified'}
${verified ? `verified_by: tester
verification_method: manual-review
verified_at: "2026-01-01T00:00:00.000Z"
last_verified: "2026-01-01T00:00:00.000Z"
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
});
