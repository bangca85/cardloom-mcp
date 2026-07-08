import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { checkConflict } from '../../src/services/conflict-engine.js';
import { validateCardStrict, type Card } from '../../src/types/card-schema.js';
import { ConflictError, type ConflictPayload } from '../../src/types/errors.js';

interface ActiveCardFixture {
  id: string;
  type?: string;
  status?: 'draft' | 'verified' | 'deprecated';
  scope?: 'project' | 'stack' | 'global';
  stack?: string[];
  applies_to?: string[];
  version_range?: string;
}

function insertActiveCard(db: Database.Database, fixture: ActiveCardFixture): void {
  db.prepare(
    `INSERT INTO cards (
      id, type, status, title, domain, stack, applies_to, task_type, error_signature,
      scope, version_range, sensitivity, supersedes, conflicts_with, source_commit, provenance,
      verified_by, verification_method, last_verified, deprecation_reason, deprecated_at, deprecated_by,
      body, created_at, updated_at, file_mtime
    ) VALUES (
      @id, @type, @status, @title, NULL, @stack, @applies_to, NULL, NULL,
      @scope, @version_range, 'normal', NULL, '[]', 'abc123', 'agent-observation',
      @verified_by, @verification_method, @last_verified, NULL, NULL, NULL,
      'body', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z'
    )`
  ).run({
    id: fixture.id,
    type: fixture.type ?? 'pattern',
    status: fixture.status ?? 'draft',
    title: `Title for ${fixture.id}`,
    stack: JSON.stringify(fixture.stack ?? ['node']),
    applies_to: JSON.stringify(fixture.applies_to ?? ['api']),
    scope: fixture.scope ?? 'project',
    version_range: fixture.version_range ?? '>=1.0.0',
    verified_by: fixture.status === 'verified' ? 'bradley' : null,
    verification_method: fixture.status === 'verified' ? 'manual-review' : null,
    last_verified: fixture.status === 'verified' ? '2026-07-01T00:00:00Z' : null,
  });
}

function newCard(overrides: Record<string, unknown> = {}): Card {
  return validateCardStrict({
    type: 'pattern',
    scope: 'project',
    applies_to: ['api'],
    stack: ['node'],
    version_range: '>=1.0.0',
    sensitivity: 'normal',
    source_commit: 'abc123',
    provenance: 'agent-observation',
    title: 'New pattern card',
    status: 'draft',
    ...overrides,
  });
}

describe('checkConflict', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('throws ConflictError with the expected payload shape when facets overlap', () => {
    insertActiveCard(db, { id: 'pattern-existing' });

    let error: ConflictError | undefined;
    try {
      checkConflict(db, newCard(), 'pattern-new');
    } catch (e) {
      error = e as ConflictError;
    }

    expect(error).toBeInstanceOf(ConflictError);
    const details = error!.details as ConflictPayload;
    expect(details.conflicting_card_id).toBe('pattern-existing');
    expect(details.options).toEqual(['supersede', 'scope-split']);
    expect(details.diff_summary).toContain('pattern');
  });

  it('does not conflict when types differ', () => {
    insertActiveCard(db, { id: 'gotcha-existing', type: 'gotcha' });
    expect(() => checkConflict(db, newCard({ type: 'pattern' }), 'pattern-new')).not.toThrow();
  });

  it('does not conflict when stack does not overlap', () => {
    insertActiveCard(db, { id: 'pattern-existing', stack: ['python'] });
    expect(() => checkConflict(db, newCard({ stack: ['node'] }), 'pattern-new')).not.toThrow();
  });

  it('does not conflict when applies_to does not overlap under project scope', () => {
    insertActiveCard(db, { id: 'pattern-existing', scope: 'project', applies_to: ['app-b'] });
    expect(() => checkConflict(db, newCard({ scope: 'project', applies_to: ['app-a'] }), 'pattern-new')).not.toThrow();
  });

  it('does not conflict when version_range does not overlap', () => {
    insertActiveCard(db, { id: 'pattern-existing', version_range: '^2.0.0' });
    expect(() => checkConflict(db, newCard({ version_range: '^1.0.0' }), 'pattern-new')).not.toThrow();
  });

  it('excludes deprecated cards from the active set', () => {
    insertActiveCard(db, { id: 'pattern-existing', status: 'deprecated' });
    expect(() => checkConflict(db, newCard(), 'pattern-new')).not.toThrow();
  });

  it('excludes the card named in supersedes from the active set', () => {
    insertActiveCard(db, { id: 'pattern-old' });
    expect(() => checkConflict(db, newCard({ supersedes: 'pattern-old' }), 'pattern-new')).not.toThrow();
  });

  it('throws when the new card explicitly declares conflicts_with an active card', () => {
    insertActiveCard(db, { id: 'pattern-unrelated', stack: ['python'] });

    let error: ConflictError | undefined;
    try {
      checkConflict(db, newCard({ conflicts_with: ['pattern-unrelated'] }), 'pattern-new');
    } catch (e) {
      error = e as ConflictError;
    }

    expect(error).toBeInstanceOf(ConflictError);
    expect((error!.details as ConflictPayload).conflicting_card_id).toBe('pattern-unrelated');
  });
});
