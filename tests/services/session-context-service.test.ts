import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { buildSessionContext, summarizeBody } from '../../src/services/session-context-service.js';
import { estimateToolJsonTokens } from '../../src/utils/token-estimate.js';

const NOW = new Date('2026-11-25T00:00:00Z');
const FRESH = '2026-11-01T00:00:00Z';

interface Seed {
  id: string;
  title?: string;
  status?: 'draft' | 'verified' | 'deprecated';
  sensitivity?: 'normal' | 'restricted';
  scope?: 'project' | 'stack' | 'global';
  project?: string | null;
  stack?: string[];
  version_range?: string;
  last_verified?: string | null;
  body?: string;
  usage?: number;
  success?: number;
  failure?: number;
}

let db: Database.Database;

function seed(s: Seed): void {
  db.prepare(
    `INSERT INTO cards (id, type, status, title, stack, applies_to, scope, project, version_range, sensitivity,
       conflicts_with, source_commit, provenance, verified_by, verification_method, last_verified, body, created_at, updated_at)
     VALUES (@id, 'pattern', @status, @title, @stack, '["api"]', @scope, @project, @version_range, @sensitivity,
       '[]', 'abc123', 'agent-observation', 'reviewer', 'manual-review', @last_verified, @body, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  ).run({
    id: s.id,
    status: s.status ?? 'verified',
    title: s.title ?? `Title of ${s.id}`,
    stack: JSON.stringify(s.stack ?? ['node']),
    scope: s.scope ?? 'project',
    project: s.project === undefined ? 'acme/api' : s.project,
    version_range: s.version_range ?? '*',
    sensitivity: s.sensitivity ?? 'normal',
    last_verified: s.last_verified === undefined ? FRESH : s.last_verified,
    body: s.body ?? `Rule of ${s.id}. More detail follows here.`,
  });
  if (s.usage !== undefined || s.success !== undefined || s.failure !== undefined) {
    db.prepare('INSERT INTO counters (card_id, usage, success, failure) VALUES (?, ?, ?, ?)').run(
      s.id,
      s.usage ?? 0,
      s.success ?? 0,
      s.failure ?? 0,
    );
  }
}

const ids = (r: { cards: Array<{ id: string }> }): string[] => r.cards.map((c) => c.id);
const base = { project: 'acme/api', maxCards: 5, maxEstimatedTokens: 800, now: NOW };

beforeEach(() => {
  db = new Database(':memory:');
  initializeSchema(db);
});
afterEach(() => {
  db.close();
});

describe('buildSessionContext eligibility', () => {
  it('prints verified, normal cards of the project, an alias and global scope; nothing else', () => {
    seed({ id: 'a-own' });
    seed({ id: 'b-alias', project: 'old-api' });
    seed({ id: 'c-global', scope: 'global', project: null });
    seed({ id: 'd-other', project: 'other/service' });
    seed({ id: 'e-draft', status: 'draft', last_verified: null });
    seed({ id: 'f-deprecated', status: 'deprecated' });
    seed({ id: 'g-restricted', sensitivity: 'restricted' });
    seed({ id: 'h-stale', last_verified: '2025-01-01T00:00:00Z' });
    seed({ id: 'i-review', failure: 2 });
    seed({ id: 'j-no-project', project: null });
    const r = buildSessionContext(db, { ...base, aliases: ['Old-API'] });
    expect(ids(r).sort()).toEqual(['a-own', 'b-alias', 'c-global']);
  });

  it('without aliases the alias card is left out', () => {
    seed({ id: 'a-own' });
    seed({ id: 'b-alias', project: 'old-api' });
    expect(ids(buildSessionContext(db, base))).toEqual(['a-own']);
  });

  it('normalises the project key it is given', () => {
    seed({ id: 'a-own' });
    expect(ids(buildSessionContext(db, { ...base, project: ' Acme/API ' }))).toEqual(['a-own']);
  });

  it('stack-scoped cards are eligible only with an intersecting stack', () => {
    seed({ id: 'a-own' });
    seed({ id: 's-node', scope: 'stack', project: null, stack: ['node'] });
    seed({ id: 's-python', scope: 'stack', project: null, stack: ['python'] });
    expect(ids(buildSessionContext(db, base))).toEqual(['a-own']);
    expect(ids(buildSessionContext(db, { ...base, stack: ['Node', 'react'] })).sort()).toEqual(['a-own', 's-node']);
  });

  it('a draft, deprecated, restricted or stale stack/global card is still never printed', () => {
    seed({ id: 'g-draft', scope: 'global', project: null, status: 'draft', last_verified: null });
    seed({ id: 'g-restricted', scope: 'global', project: null, sensitivity: 'restricted' });
    seed({ id: 'g-stale', scope: 'global', project: null, last_verified: '2025-01-01T00:00:00Z' });
    seed({ id: 's-dep', scope: 'stack', project: null, status: 'deprecated' });
    expect(buildSessionContext(db, { ...base, stack: ['node'] })).toEqual({ cards: [], text: '', estimatedTokens: 0 });
  });

  it('empty store and no project give nothing', () => {
    expect(buildSessionContext(db, base)).toEqual({ cards: [], text: '', estimatedTokens: 0 });
    seed({ id: 'c-global', scope: 'global', project: null });
    expect(buildSessionContext(db, { ...base, project: undefined })).toEqual({ cards: [], text: '', estimatedTokens: 0 });
    expect(buildSessionContext(db, { ...base, project: '  ' })).toEqual({ cards: [], text: '', estimatedTokens: 0 });
  });
});

describe('buildSessionContext ranking and budget', () => {
  it('ranks by trust, then usage, then id', () => {
    seed({ id: 'z-proven', success: 5 });
    seed({ id: 'm-plain' });
    seed({ id: 'a-doubted', failure: 1 });
    seed({ id: 'k-busy', usage: 9 });
    seed({ id: 'b-quiet', usage: 1 });
    // trust: z-proven (6/7) > the three with no signal (1/2), equal > a-doubted (1/3); among equals usage desc then id.
    expect(ids(buildSessionContext(db, base))).toEqual(['z-proven', 'k-busy', 'b-quiet', 'm-plain', 'a-doubted']);
  });

  it('an older verification ranks lower', () => {
    seed({ id: 'a-old', last_verified: '2026-06-01T00:00:00Z' });
    seed({ id: 'b-new', last_verified: '2026-11-20T00:00:00Z' });
    expect(ids(buildSessionContext(db, base))).toEqual(['b-new', 'a-old']);
  });

  it('cuts the list to maxCards', () => {
    for (const n of ['a', 'b', 'c', 'd']) seed({ id: `card-${n}` });
    expect(ids(buildSessionContext(db, { ...base, maxCards: 2 }))).toEqual(['card-a', 'card-b']);
  });

  it('drops the last cards until the estimated tokens fit the budget', () => {
    for (const n of ['a', 'b', 'c']) seed({ id: `card-${n}` });
    const all = buildSessionContext(db, base);
    const two = buildSessionContext(db, { ...base, maxCards: 2 });
    expect(all.cards).toHaveLength(3);
    const fitting = buildSessionContext(db, { ...base, maxEstimatedTokens: two.estimatedTokens });
    expect(ids(fitting)).toEqual(['card-a', 'card-b']);
    expect(fitting.estimatedTokens).toBe(estimateToolJsonTokens(fitting.text));
    expect(fitting.estimatedTokens).toBeLessThanOrEqual(two.estimatedTokens);
    const oneLess = buildSessionContext(db, { ...base, maxEstimatedTokens: two.estimatedTokens - 1 });
    expect(ids(oneLess)).toEqual(['card-a']);
  });

  it('prints nothing when not even one card fits', () => {
    seed({ id: 'card-a' });
    expect(buildSessionContext(db, { ...base, maxEstimatedTokens: 5 })).toEqual({ cards: [], text: '', estimatedTokens: 0 });
  });

  it('maxCards of 0 gives nothing', () => {
    seed({ id: 'card-a' });
    expect(buildSessionContext(db, { ...base, maxCards: 0 }).text).toBe('');
  });
});

describe('buildSessionContext text', () => {
  it('has the header, one line per card and the closing line', () => {
    seed({ id: 'pattern-retry', title: 'Retry payments twice', body: 'Retry a payment request at most twice. Never retry a 4xx.' });
    seed({ id: 'pattern-lock', title: 'Lock before write', body: 'Hold the write lock.', success: 3 });
    const r = buildSessionContext(db, base);
    expect(r.text).toBe(
      [
        '# Cardloom: verified cards for acme/api',
        '- Lock before write (pattern-lock): Hold the write lock.',
        '- Retry payments twice (pattern-retry): Retry a payment request at most twice.',
        'Use search_knowledge/get_card for details.',
      ].join('\n'),
    );
    expect(r.cards).toEqual([
      { id: 'pattern-lock', title: 'Lock before write', summary: 'Hold the write lock.' },
      { id: 'pattern-retry', title: 'Retry payments twice', summary: 'Retry a payment request at most twice.' },
    ]);
    expect(r.estimatedTokens).toBe(estimateToolJsonTokens(r.text));
  });

  it('keeps each card on one line even when the title has a line break', () => {
    seed({ id: 'a-card', title: 'Two\nlines', body: 'First line\nsecond line of the same sentence.' });
    const r = buildSessionContext(db, base);
    expect(r.text.split('\n')).toHaveLength(3);
    expect(r.text).toContain('- Two lines (a-card): First line second line of the same sentence.');
  });
});

describe('summarizeBody', () => {
  it('takes the first sentence', () => {
    expect(summarizeBody('Use retries. Then back off.')).toBe('Use retries.');
    expect(summarizeBody('Is it safe? Yes.')).toBe('Is it safe?');
  });

  it('a body without a sentence end is used whole', () => {
    expect(summarizeBody('No full stop here')).toBe('No full stop here');
  });

  it('does not end a sentence inside a version number or a file name', () => {
    expect(summarizeBody('Upgrade to 1.2.0 before Friday. Then relax.')).toBe('Upgrade to 1.2.0 before Friday.');
  });

  it('skips markdown headings and blank lines', () => {
    expect(summarizeBody('\n## Context\n\nRetry twice.\nMore.')).toBe('Retry twice.');
  });

  it('is at most 160 characters', () => {
    const long = summarizeBody('word '.repeat(100));
    expect(long).toHaveLength(160);
    expect(long.endsWith('…')).toBe(true);
    expect(summarizeBody('x'.repeat(160))).toHaveLength(160);
    expect(summarizeBody('x'.repeat(160))).toBe('x'.repeat(160));
    expect(summarizeBody('x'.repeat(161))).toHaveLength(160);
  });

  it('empty body gives an empty summary', () => {
    expect(summarizeBody('')).toBe('');
    expect(summarizeBody('# Only a heading')).toBe('Only a heading');
  });
});
