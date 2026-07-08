import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { handleSearchKnowledge, WRITE_BACK_REMINDER } from '../../src/tools/search-knowledge.js';

interface CardFixture {
  id: string;
  status?: 'draft' | 'verified' | 'deprecated';
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
      @id, 'pattern', @status, @title, NULL, '["node"]', '["api"]', NULL, NULL,
      'project', '>=1.0.0', 'normal', NULL, '[]', 'abc123', 'agent-observation',
      @verified_by, @verification_method, @last_verified, NULL, NULL, NULL,
      @body, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
    )`,
  ).run({
    id: fixture.id,
    status: fixture.status ?? 'verified',
    title: `Title for ${fixture.id}`,
    verified_by: fixture.status === 'draft' ? null : 'bradley',
    verification_method: fixture.status === 'draft' ? null : 'manual-review',
    last_verified: fixture.status === 'draft' ? null : '2026-01-01T00:00:00Z',
    body: fixture.body ?? 'x'.repeat(500),
  });
}

function parseResponse(result: { content: Array<{ type: string; text: string }> }): {
  results: Array<Record<string, unknown>>;
  write_back_reminder: string;
} {
  return JSON.parse(result.content[0]!.text) as { results: Array<Record<string, unknown>>; write_back_reminder: string };
}

describe('handleSearchKnowledge', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns a compact item shape without the full card body (AC1, FR10)', () => {
    insertCard(db, { id: 'pattern-one', body: 'y'.repeat(1000) });

    const response = parseResponse(handleSearchKnowledge(db, { query: 'pattern' }));

    expect(response.results).toHaveLength(1);
    const item = response.results[0]!;
    expect(item).toMatchObject({ id: 'pattern-one', type: 'pattern', status: 'verified' });
    expect(typeof item['snippet']).toBe('string');
    expect((item['snippet'] as string).length).toBeLessThanOrEqual(200);
    expect(item['body']).toBeUndefined();
    expect(item['content']).toBeUndefined();
    expect(typeof item['trust']).toBe('number');
    expect(item['flags']).toBeDefined();
  });

  it('defaults limit to 10 when omitted', () => {
    for (let i = 0; i < 15; i++) {
      insertCard(db, { id: `pattern-${i}`, body: `shared searchable body number ${i}` });
    }

    const response = parseResponse(handleSearchKnowledge(db, { query: 'searchable' }));
    expect(response.results).toHaveLength(10);
  });

  it('includes write_back_reminder in every response, even with zero results', () => {
    const response = parseResponse(handleSearchKnowledge(db, { query: 'nothing-matches-this-at-all' }));

    expect(response.results).toHaveLength(0);
    expect(response.write_back_reminder).toBe(WRITE_BACK_REMINDER);
  });

  it('passes context through to the search service for facet ranking', () => {
    insertCard(db, { id: 'pattern-ctx', body: 'context aware body text' });

    const response = parseResponse(
      handleSearchKnowledge(db, { query: 'context', context: { stack: ['node'], versions: { node: '^20.0.0' } } }),
    );

    expect(response.results.map((r) => r['id'])).toContain('pattern-ctx');
  });
});
