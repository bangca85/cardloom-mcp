import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { handleGetCard } from '../../src/tools/get-card.js';
import { WRITE_BACK_REMINDER } from '../../src/config/messages.js';

function insertCard(
  db: Database.Database,
  id: string,
  overrides: { status?: string; sensitivity?: string } = {},
): void {
  db.prepare(
    `INSERT INTO cards (
      id, type, status, title, domain, stack, applies_to, task_type, error_signature,
      scope, version_range, sensitivity, supersedes, conflicts_with, source_commit, provenance,
      verified_by, verification_method, last_verified, deprecation_reason, deprecated_at, deprecated_by,
      body, created_at, updated_at, file_mtime
    ) VALUES (
      @id, 'pattern', @status, @title, NULL, '["node"]', '["api"]', NULL, NULL,
      'project', '>=1.0.0', @sensitivity, NULL, '[]', 'abc123', 'agent-observation',
      'bradley', 'manual-review', '2026-01-01T00:00:00Z', NULL, NULL, NULL,
      'Full card body here.', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
    )`,
  ).run({
    id,
    status: overrides.status ?? 'verified',
    title: `Title for ${id}`,
    sensitivity: overrides.sensitivity ?? 'normal',
  });
}

function parseResponse(result: { content: Array<{ type: string; text: string }> }): {
  card: Record<string, unknown>;
  write_back_reminder: string;
} {
  return JSON.parse(result.content[0]!.text) as { card: Record<string, unknown>; write_back_reminder: string };
}

describe('handleGetCard', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns the full card body and metadata plus the write_back_reminder (happy path)', () => {
    insertCard(db, 'pattern-happy');

    const response = parseResponse(handleGetCard(db, { id: 'pattern-happy' }));

    expect(response.card['id']).toBe('pattern-happy');
    expect(response.card['body']).toBe('Full card body here.');
    expect(response.write_back_reminder).toBe(WRITE_BACK_REMINDER);
  });

  it('carries source (repo, 7-character commit, approval date) in the rendered card', () => {
    insertCard(db, 'pattern-sourced');
    db.prepare("UPDATE cards SET source_repo = 'acme/billing', source_commit = '9f1c2ab0 (story 5.26)' WHERE id = ?").run(
      'pattern-sourced',
    );

    const response = parseResponse(handleGetCard(db, { id: 'pattern-sourced' }));

    expect(response.card['source']).toEqual({ repo: 'acme/billing', commit: '9f1c2ab', approved_at: '2026-01-01' });
  });

  it('propagates not_found for an id that does not exist (mapped to code not_found at the server boundary)', () => {
    expect(() => handleGetCard(db, { id: 'pattern-missing' })).toThrow();
  });

  it('returns a restricted card with restricted:true (hidden-from-search-only, get_card is direct-access)', () => {
    insertCard(db, 'pattern-restricted', { sensitivity: 'restricted' });

    const response = parseResponse(handleGetCard(db, { id: 'pattern-restricted' }));

    expect(response.card['restricted']).toBe(true);
    expect(response.card['body']).toBe('Full card body here.');
  });
});
