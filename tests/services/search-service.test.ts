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
