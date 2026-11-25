import { describe, it, expect } from 'vitest';
import { scoreAnswer, summarize, p95 } from '../../eval/score.js';
import type { EvalResult, EvalTask } from '../../eval/types.js';

const task = (rubric: EvalTask['rubric']): EvalTask => ({
  id: 't',
  prompt: 'p',
  repo: 'fixture/ledger-api',
  required_cards: [],
  rubric,
});

describe('scoreAnswer', () => {
  it('passes when every must_include is present, case-insensitively', () => {
    const t = task([{ must_include: ['Amount_Minor', 'bigint'] }]);
    expect(scoreAnswer(t, 'Store it in a BIGINT column called amount_minor.')).toEqual({ pass: true, failed: [] });
  });

  it('fails and names each missing must_include', () => {
    const t = task([{ must_include: ['amount_minor', 'bigint'] }]);
    const r = scoreAnswer(t, 'use amount_minor');
    expect(r.pass).toBe(false);
    expect(r.failed).toEqual(['must_include: bigint']);
  });

  it('fails when a must_not_include substring is present, case-insensitively', () => {
    const t = task([{ must_not_include: ['?page='] }, { must_not_include: ['OFFSET'] }]);
    const r = scoreAnswer(t, 'Use limit/offset with ?page=2');
    expect(r.pass).toBe(false);
    expect(r.failed).toEqual(['must_not_include: ?page=', 'must_not_include: OFFSET']);
  });

  it('requires every rubric item to pass, and a mixed item to satisfy both halves', () => {
    const t = task([{ must_include: ['cursor'], must_not_include: ['?page='] }, { must_include: ['limit'] }]);
    expect(scoreAnswer(t, 'cursor and limit').pass).toBe(true);
    expect(scoreAnswer(t, 'cursor only').failed).toEqual(['must_include: limit']);
    expect(scoreAnswer(t, 'cursor limit ?page=').failed).toEqual(['must_not_include: ?page=']);
  });

  it('treats an empty rubric, or an empty item, as a pass', () => {
    expect(scoreAnswer(task([]), '')).toEqual({ pass: true, failed: [] });
    expect(scoreAnswer(task([{}]), '')).toEqual({ pass: true, failed: [] });
  });

  it('does not pass an empty answer when something must be included', () => {
    expect(scoreAnswer(task([{ must_include: ['x'] }]), '').pass).toBe(false);
  });
});

describe('p95', () => {
  it('is the nearest-rank value: ceil(0.95 * n)-th smallest', () => {
    expect(p95(Array.from({ length: 20 }, (_, i) => i + 1))).toBe(19);
    expect(p95([40, 10, 30, 20])).toBe(40);
    expect(p95([7])).toBe(7);
    expect(p95([])).toBe(0);
  });
});

const res = (over: Partial<EvalResult>): EvalResult => ({
  taskId: 't',
  mode: 'top5',
  run: 1,
  pass: true,
  failed: [],
  answer: '',
  tokens: 100,
  toolCalls: 1,
  latencyMs: 10,
  ...over,
});

describe('summarize', () => {
  it('computes runs, pass rate, mean tokens and nearest-rank p95 per mode from a fixed fixture', () => {
    const results: EvalResult[] = [
      res({ mode: 'top5', pass: true, tokens: 100, latencyMs: 10 }),
      res({ mode: 'top5', pass: true, tokens: 200, latencyMs: 20 }),
      res({ mode: 'top5', pass: false, tokens: 300, latencyMs: 30 }),
      res({ mode: 'top5', pass: false, tokens: 400, latencyMs: 40 }),
      res({ mode: 'read_all', pass: true, tokens: 1000, latencyMs: 5 }),
    ];
    const { byMode } = summarize(results);
    expect(byMode.top5).toMatchObject({ runs: 4, passRate: 0.5, meanTokens: 250, p95LatencyMs: 40, wrongOnRelatedOnly: 0 });
    expect(byMode.read_all).toMatchObject({ runs: 1, passRate: 1, meanTokens: 1000, p95LatencyMs: 5 });
  });

  it('always reports all three modes, zeroed when there are no runs', () => {
    const { byMode } = summarize([]);
    expect(Object.keys(byMode).sort()).toEqual(['read_all', 'search_then_get', 'top5']);
    expect(byMode.search_then_get).toMatchObject({ runs: 0, passRate: 0, meanTokens: 0, p95LatencyMs: 0, wrongOnRelatedOnly: 0 });
  });

  it('counts wrongOnRelatedOnly only for failed runs whose seen matches were all related', () => {
    const { byMode } = summarize([
      res({ pass: false, seenMatches: ['related', 'related'] }), // counts
      res({ pass: false, seenMatches: ['related', 'all_terms'] }), // saw a direct match
      res({ pass: true, seenMatches: ['related'] }), // answered right
      res({ pass: false, seenMatches: [] }), // saw nothing
      res({ pass: false }), // no tool results at all (read_all style)
    ]);
    expect(byMode.top5.wrongOnRelatedOnly).toBe(1);
    expect(byMode.top5.runs).toBe(5);
  });

  it('leaves errored runs out of the arithmetic and reports how many there were', () => {
    const { byMode } = summarize([res({ pass: true, tokens: 100 }), res({ pass: false, tokens: 0, error: 'API 500' })]);
    expect(byMode.top5).toMatchObject({ runs: 1, passRate: 1, meanTokens: 100, errors: 1 });
  });
});
