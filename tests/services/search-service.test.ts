import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { searchCards } from '../../src/services/search-service.js';

interface CardFixture {
  id: string;
  type?: string;
  status?: 'draft' | 'verified' | 'deprecated';
  title?: string;
  scope?: 'project' | 'stack' | 'global';
  stack?: string[];
  applies_to?: string[];
  version_range?: string;
  sensitivity?: 'normal' | 'restricted';
  error_signature?: string | null;
  last_verified?: string | null;
  body?: string;
}

function insertCard(db: Database.Database, fixture: CardFixture): void {
  db.prepare(
    `INSERT INTO cards (
      id, type, status, title, domain, stack, applies_to, task_type, error_signature,
      scope, version_range, sensitivity, supersedes, conflicts_with, source_commit, provenance,
      verified_by, verification_method, last_verified, deprecation_reason, deprecated_at, deprecated_by,
      body, created_at, updated_at, file_mtime
    ) VALUES (
      @id, @type, @status, @title, NULL, @stack, @applies_to, NULL, @error_signature,
      @scope, @version_range, @sensitivity, NULL, '[]', 'abc123', 'agent-observation',
      @verified_by, @verification_method, @last_verified, NULL, NULL, NULL,
      @body, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
    )`,
  ).run({
    id: fixture.id,
    type: fixture.type ?? 'pattern',
    status: fixture.status ?? 'verified',
    title: fixture.title ?? `Title for ${fixture.id}`,
    stack: JSON.stringify(fixture.stack ?? ['node']),
    applies_to: JSON.stringify(fixture.applies_to ?? ['api']),
    error_signature: fixture.error_signature ?? null,
    scope: fixture.scope ?? 'project',
    version_range: fixture.version_range ?? '>=1.0.0',
    sensitivity: fixture.sensitivity ?? 'normal',
    verified_by: fixture.status === 'deprecated' || fixture.status === undefined || fixture.status === 'verified' ? 'bradley' : null,
    verification_method: fixture.status === 'draft' ? null : 'manual-review',
    last_verified: fixture.status === 'draft' ? null : (fixture.last_verified ?? '2026-01-01T00:00:00Z'),
    body: fixture.body ?? `Body content for ${fixture.id} describing retry patterns.`,
  });
}

function insertCounters(db: Database.Database, cardId: string, usage: number, success: number, failure: number): void {
  db.prepare('INSERT INTO counters (card_id, usage, success, failure) VALUES (?, ?, ?, ?)').run(
    cardId,
    usage,
    success,
    failure,
  );
}

/**
 * Six cards with varied facets, ranks and trust, used by the Task 4 tests. The default-order
 * snapshots below were recorded against the pre-Task-4 search-service (AND query, facetMatch →
 * ftsRank → trust) and must never change while SEARCH_RANKING/SEARCH_FALLBACK stay at defaults.
 */
function seedSix(db: Database.Database): void {
  insertCard(db, { id: 'pattern-s1', stack: ['node'], scope: 'project', applies_to: ['api'], title: 'Backoff loops', body: 'retry retry retry patterns with backoff' });
  insertCard(db, { id: 'pattern-s2', stack: ['python'], scope: 'stack', title: 'Queue consumers', body: 'retry retry retry patterns patterns' });
  insertCard(db, { id: 'decision-s3', type: 'decision', stack: ['node'], scope: 'global', title: 'Retry patterns', body: 'Decision about retry patterns and jitter.' });
  insertCard(db, {
    id: 'gotcha-s4',
    type: 'gotcha',
    stack: ['node'],
    scope: 'project',
    applies_to: ['src/payments/'],
    version_range: '^18.0.0',
    title: 'Socket resets',
    error_signature: 'ConnectionResetError: socket hang up',
    body: 'retry patterns when the socket resets mid request',
  });
  insertCard(db, { id: 'pattern-s5', stack: ['node'], scope: 'project', title: 'Note five', body: 'Generic retry patterns note.' });
  insertCard(db, { id: 'pattern-s6', stack: ['node'], scope: 'project', title: 'Note six', body: 'Generic retry patterns note.' });
  insertCounters(db, 'pattern-s5', 5, 5, 0);
  insertCounters(db, 'pattern-s6', 3, 0, 1);
}

describe('searchCards', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('matches multiple words regardless of order (AND semantics, not phrase order)', () => {
    insertCard(db, { id: 'pattern-multi-word', body: 'Body about retries and backoff' });

    const results = searchCards(db, 'backoff retries', {});

    expect(results.map((r) => r.id)).toContain('pattern-multi-word');
  });

  it('ranks a facet-matching card above an FTS-only match (AC1)', () => {
    insertCard(db, { id: 'pattern-facet-match', stack: ['node'], body: 'Body about retries and backoff' });
    insertCard(db, { id: 'pattern-fts-only', stack: ['python'], body: 'Body about retries and backoff' });

    const results = searchCards(db, 'retries', { context: { stack: ['node'] } });

    expect(results[0]!.id).toBe('pattern-facet-match');
  });

  it('matches on error_signature verbatim (AC2)', () => {
    insertCard(db, {
      id: 'gotcha-crash',
      type: 'gotcha',
      error_signature: "TypeError: Cannot read property 'foo' of undefined",
      body: 'Explains the fix for this crash.',
    });
    insertCard(db, { id: 'pattern-unrelated', body: 'Nothing to do with the crash.' });

    const results = searchCards(db, "TypeError: Cannot read property 'foo' of undefined", {});

    expect(results.map((r) => r.id)).toContain('gotcha-crash');
  });

  it('flags drift when context version does not intersect the card version_range (AC3)', () => {
    insertCard(db, { id: 'pattern-drift', stack: ['node'], version_range: '^18.0.0', body: 'retry pattern body' });

    const results = searchCards(db, 'retry', { context: { stack: ['node'], versions: { node: '^20.0.0' } } });

    const card = results.find((r) => r.id === 'pattern-drift');
    expect(card?.flags.drift).toBe(true);
  });

  it('does not flag drift when context version intersects the card version_range', () => {
    insertCard(db, { id: 'pattern-no-drift', stack: ['node'], version_range: '>=18.0.0', body: 'retry pattern body' });

    const results = searchCards(db, 'retry', { context: { stack: ['node'], versions: { node: '^20.0.0' } } });

    const card = results.find((r) => r.id === 'pattern-no-drift');
    expect(card?.flags.drift).toBeUndefined();
  });

  it('flags stale when last_verified is older than STALE_THRESHOLD_DAYS', () => {
    const now = new Date('2026-07-05T00:00:00Z');
    const oldDate = new Date(now.getTime() - 200 * 24 * 60 * 60 * 1000).toISOString();
    insertCard(db, { id: 'pattern-stale', last_verified: oldDate, body: 'stale pattern body' });

    const results = searchCards(db, 'stale', {}, now);

    expect(results.find((r) => r.id === 'pattern-stale')?.flags.stale).toBe(true);
  });

  it('does not flag needs_review when counters are 0/0, flags it when failure crosses the threshold', () => {
    insertCard(db, { id: 'pattern-healthy', body: 'healthy pattern body' });
    insertCard(db, { id: 'pattern-failing', body: 'failing pattern body' });
    insertCounters(db, 'pattern-failing', 5, 0, 2);

    const results = searchCards(db, 'pattern', {});

    expect(results.find((r) => r.id === 'pattern-healthy')?.flags.needs_review).toBeUndefined();
    expect(results.find((r) => r.id === 'pattern-failing')?.flags.needs_review).toBe(true);
  });

  it('defaults to verified + normal sensitivity only (AC4)', () => {
    insertCard(db, { id: 'pattern-verified', body: 'shared searchable body text' });
    insertCard(db, { id: 'pattern-draft', status: 'draft', body: 'shared searchable body text' });
    insertCard(db, { id: 'pattern-deprecated', status: 'deprecated', body: 'shared searchable body text' });
    insertCard(db, { id: 'pattern-restricted', sensitivity: 'restricted', body: 'shared searchable body text' });

    const results = searchCards(db, 'searchable', {});

    expect(results.map((r) => r.id).sort()).toEqual(['pattern-verified']);
  });

  it('includes drafts with untrusted:true when include_drafts is set (AC4)', () => {
    insertCard(db, { id: 'pattern-draft-2', status: 'draft', body: 'draft searchable body' });

    const results = searchCards(db, 'searchable', { includeDrafts: true });

    const draft = results.find((r) => r.id === 'pattern-draft-2');
    expect(draft?.untrusted).toBe(true);
  });

  it('includes deprecated cards with deprecated:true when include_deprecated is set (AC4)', () => {
    insertCard(db, { id: 'pattern-deprecated-2', status: 'deprecated', body: 'deprecated searchable body' });

    const results = searchCards(db, 'searchable', { includeDeprecated: true });

    const card = results.find((r) => r.id === 'pattern-deprecated-2');
    expect(card?.deprecated).toBe(true);
  });

  it('includes restricted cards with restricted:true when include_restricted is set (AC4)', () => {
    insertCard(db, { id: 'pattern-restricted-2', sensitivity: 'restricted', body: 'restricted searchable body' });

    const results = searchCards(db, 'searchable', { includeRestricted: true });

    const card = results.find((r) => r.id === 'pattern-restricted-2');
    expect(card?.restricted).toBe(true);
  });
});

describe('searchCards — tiered fallback, ranking modes, scope layers (Task 4)', () => {
  let db: Database.Database;

  beforeEach(() => {
    delete process.env['SEARCH_RANKING'];
    delete process.env['SEARCH_FALLBACK'];
    db = new Database(':memory:');
    initializeSchema(db);
    seedSix(db);
  });

  afterEach(() => {
    delete process.env['SEARCH_RANKING'];
    delete process.env['SEARCH_FALLBACK'];
    db.close();
  });

  it('defaults reproduce the previous order exactly', () => {
    // Recorded against the pre-Task-4 search-service before any src/ change (see task-4-report.md).
    expect(searchCards(db, 'retry patterns', {}).map((r) => r.id)).toEqual([
      'pattern-s2',
      'decision-s3',
      'pattern-s1',
      'pattern-s5',
      'pattern-s6',
      'gotcha-s4',
    ]);
    expect(
      searchCards(db, 'retry patterns', { context: { stack: ['node'], versions: { node: '^20.0.0' } } }).map((r) => r.id),
    ).toEqual(['decision-s3', 'pattern-s1', 'pattern-s5', 'pattern-s6', 'pattern-s2', 'gotcha-s4']);
    expect(searchCards(db, 'retry patterns', { limit: 3 }).map((r) => r.id)).toEqual([
      'pattern-s2',
      'decision-s3',
      'pattern-s1',
    ]);
  });

  it('explicit baseline/off options match the defaults', () => {
    const ctx = { stack: ['node'], versions: { node: '^20.0.0' } };
    const defaults = searchCards(db, 'retry patterns', { context: ctx }).map((r) => r.id);
    const explicit = searchCards(db, 'retry patterns', { context: ctx, ranking: 'baseline', fallback: 'off' }).map((r) => r.id);
    expect(explicit).toEqual(defaults);
  });

  it('tiered fallback finds a card the AND query misses and labels it exact_signature', () => {
    insertCard(db, { id: 'gotcha-err42', type: 'gotcha', error_signature: 'ERR-42', title: 'Payment ERR-42' });
    expect(searchCards(db, 'Error: ERR-42 at line 8', {})).toEqual([]);
    const r = searchCards(db, 'Error: ERR-42 at line 8', { fallback: 'tiered' });
    expect(r[0]).toMatchObject({ id: 'gotcha-err42', match: 'exact_signature' });
  });

  it('tiered fallback labels partial matches as related', () => {
    const r = searchCards(db, 'zqxv7000 retry patterns in my project', { fallback: 'tiered' });
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((x) => x.match === 'related')).toBe(true);
  });

  it('fallback off only returns AND rows, so no result is ever related', () => {
    const r = searchCards(db, 'retry patterns', {});
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((x) => x.match === 'all_terms' || x.match.startsWith('exact_'))).toBe(true);
    expect(searchCards(db, 'zqxv7000 retry patterns', {})).toEqual([]);
  });

  it('tiered keeps the AND path when the AND set already fills the limit', () => {
    insertCard(db, { id: 'pattern-or-only', title: 'Jitter', body: 'jitter only, nothing else' });
    const r = searchCards(db, 'retry patterns jitter', { fallback: 'tiered', limit: 1 });
    expect(r.map((x) => x.id)).toEqual(['decision-s3']);
    expect(r[0]!.match).toBe('all_terms');
  });

  it.each(['***', 'C++', '"', '-', '   '])('punctuation-only query %j does not throw (Review Focus 3)', (q) => {
    expect(() => searchCards(db, q, { fallback: 'tiered' })).not.toThrow();
  });

  it('x ranks this_project above other_project; y lets an exact other-project card win', () => {
    insertCard(db, { id: 'decision-a', type: 'decision', scope: 'project', applies_to: ['proj-a'], title: 'Retry policy', body: 'retry policy body' });
    insertCard(db, { id: 'gotcha-b', type: 'gotcha', scope: 'project', applies_to: ['proj-b'], error_signature: 'RETRY_EXHAUSTED', body: 'retry policy body' });
    const ctx = { project: 'proj-a', stack: ['node'] };
    expect(searchCards(db, 'RETRY_EXHAUSTED retry policy', { context: ctx, fallback: 'tiered', ranking: 'x' })[0]!.id).toBe('decision-a');
    expect(searchCards(db, 'RETRY_EXHAUSTED retry policy', { context: ctx, fallback: 'tiered', ranking: 'y' })[0]!.id).toBe('gotcha-b');
  });

  it('x drops a drifted this_project card below shared and unknown-layer cards', () => {
    insertCard(db, {
      id: 'decision-drift',
      type: 'decision',
      stack: ['node'],
      scope: 'project',
      applies_to: ['proj-a'],
      version_range: '^18.0.0',
      title: 'Old retry patterns',
      body: 'retry retry retry patterns patterns',
    });
    const ctx = { project: 'proj-a', stack: ['node'], versions: { node: '^20.0.0' } };
    const ids = searchCards(db, 'retry patterns', { context: ctx, ranking: 'x' }).map((r) => r.id);
    expect(ids[0]).toBe('decision-s3'); // shared + facetMatch → 1
    expect(ids.indexOf('decision-drift')).toBeGreaterThan(ids.indexOf('pattern-s1')); // unknown → 2
  });

  it('x ranks shared guidance above other projects when the caller passes a project but no stack (R8)', () => {
    insertCard(db, { id: 'pattern-global', scope: 'global', title: 'Zebra quokka', body: 'zebra quokka body' });
    insertCard(db, { id: 'pattern-projb', scope: 'project', applies_to: ['proj-b'], title: 'Zebra quokka', body: 'zebra quokka body' });
    const r = searchCards(db, 'zebra quokka', { context: { project: 'proj-a' }, ranking: 'x', fallback: 'tiered' });
    const ids = r.map((x) => x.id);
    expect(r.find((x) => x.id === 'pattern-global')?.scope_layer).toBe('shared');
    expect(r.find((x) => x.id === 'pattern-projb')?.scope_layer).toBe('unknown');
    expect(ids.indexOf('pattern-global')).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf('pattern-global')).toBeLessThan(ids.indexOf('pattern-projb'));
  });

  it('tiered mode rethrows real database errors instead of returning []', () => {
    db.exec('DROP TABLE counters');
    expect(() => searchCards(db, 'retry patterns', { fallback: 'tiered' })).toThrow(/no such table/);
  });

  it('reads ranking and fallback from config when options are absent', () => {
    insertCard(db, { id: 'decision-a', type: 'decision', scope: 'project', applies_to: ['proj-a'], title: 'Retry policy', body: 'retry policy body' });
    insertCard(db, { id: 'gotcha-b', type: 'gotcha', scope: 'project', applies_to: ['proj-b'], error_signature: 'RETRY_EXHAUSTED', body: 'retry policy body' });
    const ctx = { project: 'proj-a', stack: ['node'] };
    process.env['SEARCH_FALLBACK'] = 'tiered';
    process.env['SEARCH_RANKING'] = 'y';
    expect(searchCards(db, 'RETRY_EXHAUSTED retry policy', { context: ctx })[0]!.id).toBe('gotcha-b');
    process.env['SEARCH_RANKING'] = 'x';
    expect(searchCards(db, 'RETRY_EXHAUSTED retry policy', { context: ctx })[0]!.id).toBe('decision-a');
  });

  it('scope_layer is null without a caller project and unknown for path-only legacy cards', () => {
    const noProject = searchCards(db, 'retry patterns', {});
    expect(noProject.length).toBeGreaterThan(0);
    expect(noProject.every((x) => x.scope_layer === null)).toBe(true);

    const withProject = searchCards(db, 'retry patterns', { context: { project: 'acme/billing-api' } });
    expect(withProject.find((x) => x.id === 'gotcha-s4')?.scope_layer).toBe('unknown');
    expect(withProject.find((x) => x.id === 'decision-s3')?.scope_layer).toBe('shared');
  });

  it('excerpt is an FTS snippet of the body, falling back to preview', () => {
    const r = searchCards(db, 'socket', {});
    const s4 = r.find((x) => x.id === 'gotcha-s4');
    expect(s4?.excerpt).toContain('socket');
    expect(s4?.excerpt.length).toBeGreaterThan(0);

    // Matches on the title only: the body snippet has no hit, but excerpt is never empty.
    const titleOnly = searchCards(db, 'Queue consumers', {});
    const s2 = titleOnly.find((x) => x.id === 'pattern-s2');
    expect(s2?.excerpt.length).toBeGreaterThan(0);
  });
});
