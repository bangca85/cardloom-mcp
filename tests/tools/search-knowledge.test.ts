import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { handleSearchKnowledge, WRITE_BACK_REMINDER } from '../../src/tools/search-knowledge.js';
import { EMPTY_STORE_HINT } from '../../src/config/messages.js';

interface CardFixture {
  id: string;
  status?: 'draft' | 'verified' | 'deprecated';
  body?: string;
  title?: string;
  appliesTo?: string[];
  project?: string;
}

function insertCard(db: Database.Database, fixture: CardFixture): void {
  db.prepare(
    `INSERT INTO cards (
      id, type, status, title, domain, stack, applies_to, task_type, error_signature,
      scope, version_range, sensitivity, supersedes, conflicts_with, source_commit, provenance,
      verified_by, verification_method, last_verified, deprecation_reason, deprecated_at, deprecated_by,
      body, created_at, updated_at, file_mtime, project
    ) VALUES (
      @id, 'pattern', @status, @title, NULL, '["node"]', @applies_to, NULL, NULL,
      'project', '>=1.0.0', 'normal', NULL, '[]', 'abc123', 'agent-observation',
      @verified_by, @verification_method, @last_verified, NULL, NULL, NULL,
      @body, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', @project
    )`,
  ).run({
    id: fixture.id,
    project: fixture.project ?? null,
    status: fixture.status ?? 'verified',
    title: fixture.title ?? `Title for ${fixture.id}`,
    applies_to: JSON.stringify(fixture.appliesTo ?? ['api']),
    verified_by: fixture.status === 'draft' ? null : 'bradley',
    verification_method: fixture.status === 'draft' ? null : 'manual-review',
    last_verified: fixture.status === 'draft' ? null : '2026-01-01T00:00:00Z',
    body: fixture.body ?? 'x'.repeat(500),
  });
}

function parseResponse(result: { content: Array<{ type: string; text: string }> }): {
  results: Array<Record<string, unknown>>;
  write_back_reminder: string;
  no_direct_match?: boolean;
  hint?: string;
} {
  return JSON.parse(result.content[0]!.text) as {
    results: Array<Record<string, unknown>>;
    write_back_reminder: string;
    no_direct_match?: boolean;
    hint?: string;
  };
}

describe('handleSearchKnowledge', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });

  afterEach(() => {
    delete process.env.SEARCH_FALLBACK;
    delete process.env.SEARCH_RANKING;
    db.close();
  });

  it('returns a compact item shape without the full card body (AC1, FR10)', () => {
    insertCard(db, { id: 'pattern-one', body: 'y'.repeat(1000) });

    const response = parseResponse(handleSearchKnowledge(db, { query: 'pattern' }));

    expect(response.results).toHaveLength(1);
    const item = response.results[0]!;
    expect(item).toMatchObject({
      id: 'pattern-one',
      type: 'pattern',
      status: 'verified',
      title: 'Title for pattern-one',
      match: expect.any(String),
    });
    expect(Object.keys(item).sort()).toEqual(['flags', 'id', 'match', 'snippet', 'status', 'title', 'trust', 'type']);
    expect(typeof item['snippet']).toBe('string');
    expect((item['snippet'] as string).length).toBeLessThanOrEqual(200);
    expect(item['body']).toBeUndefined();
    // `source` is get_card-only: in search results it cost +17% response tokens at limit 5 (Task W4 measurement).
    expect(item['source']).toBeUndefined();
    expect(item['content']).toBeUndefined();
    expect(typeof item['trust']).toBe('number');
    expect(item['flags']).toBeDefined();
  });

  it('defaults limit to 5 when omitted (was 10 until 2026-11-25)', () => {
    for (let i = 0; i < 15; i++) {
      insertCard(db, { id: `pattern-${i}`, body: `shared searchable body number ${i}` });
    }

    const response = parseResponse(handleSearchKnowledge(db, { query: 'searchable' }));
    expect(response.results).toHaveLength(5);
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

  it('returns title, rounded trust and match label', () => {
    insertCard(db, { id: 'pattern-retry', body: 'retry with backoff' });

    const item = parseResponse(handleSearchKnowledge(db, { query: 'retry' })).results[0]!;

    expect(item).toMatchObject({ title: expect.any(String), match: expect.any(String) });
    expect(String(item['trust']).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(2);
  });

  it('sets no_direct_match when only related results come back', () => {
    process.env.SEARCH_FALLBACK = 'tiered';
    insertCard(db, { id: 'pattern-alpha', body: 'alpha content only' });

    const response = parseResponse(handleSearchKnowledge(db, { query: 'alpha zzzmissing' }));

    expect(response.results.map((r) => r['match'])).toEqual(['related']);
    expect(response.no_direct_match).toBe(true);
  });

  it('omits no_direct_match when a result is a direct match or there are no results', () => {
    process.env.SEARCH_FALLBACK = 'tiered';
    insertCard(db, { id: 'pattern-alpha', body: 'alpha beta content' });

    const direct = parseResponse(handleSearchKnowledge(db, { query: 'alpha beta' }));
    expect(direct.results[0]!['match']).not.toBe('related');
    expect(direct.no_direct_match).toBeUndefined();

    const none = parseResponse(handleSearchKnowledge(db, { query: 'qqqqnothing' }));
    expect(none.results).toHaveLength(0);
    expect(none.no_direct_match).toBeUndefined();
  });

  it('adds the empty-store hint when no verified card exists', () => {
    const empty = new Database(':memory:');
    initializeSchema(empty);
    try {
      expect(parseResponse(handleSearchKnowledge(empty, { query: 'x' })).hint).toBe(EMPTY_STORE_HINT);
    } finally {
      empty.close();
    }
  });

  it('omits the hint once a verified card exists, but not for a draft-only store', () => {
    insertCard(db, { id: 'pattern-draft', status: 'draft' });
    expect(parseResponse(handleSearchKnowledge(db, { query: 'x' })).hint).toBe(EMPTY_STORE_HINT);

    insertCard(db, { id: 'pattern-verified' });
    expect(parseResponse(handleSearchKnowledge(db, { query: 'x' })).hint).toBeUndefined();
  });

  it('includes scope_layer only when the caller gave a project, and applies_to only for unknown', () => {
    insertCard(db, { id: 'pattern-unknown', body: 'layered content', appliesTo: ['api'] });
    insertCard(db, { id: 'pattern-mine', body: 'layered content', appliesTo: ['acme/billing-api'] });

    const without = parseResponse(handleSearchKnowledge(db, { query: 'layered' }));
    for (const item of without.results) {
      expect(item['scope_layer']).toBeUndefined();
      expect(item['applies_to']).toBeUndefined();
    }

    const withProject = parseResponse(
      handleSearchKnowledge(db, { query: 'layered', context: { project: 'acme/billing-api', aliases: [] } }),
    );
    const byId = Object.fromEntries(withProject.results.map((r) => [r['id'] as string, r]));
    expect(byId['pattern-mine']!['scope_layer']).toBe('this_project');
    expect(byId['pattern-mine']!['applies_to']).toBeUndefined();
    expect(byId['pattern-unknown']!['scope_layer']).toBe('unknown');
    expect(byId['pattern-unknown']!['applies_to']).toEqual(['api']);
  });

  it('search uses cards.project: explicit other key → other_project + applies_to_project', () => {
    insertCard(db, { id: 'pattern-mine', body: 'projected content', appliesTo: ['api'], project: 'acme/billing-api' });
    insertCard(db, { id: 'pattern-other', body: 'projected content', appliesTo: ['api'], project: 'acme/other-svc' });
    insertCard(db, { id: 'pattern-legacy', body: 'projected content', appliesTo: ['api'] });

    const withProject = parseResponse(
      handleSearchKnowledge(db, { query: 'projected', context: { project: 'acme/billing-api', aliases: [] } }),
    );
    const byId = Object.fromEntries(withProject.results.map((r) => [r['id'] as string, r]));
    expect(byId['pattern-mine']!['scope_layer']).toBe('this_project');
    expect(byId['pattern-mine']!['applies_to_project']).toBeUndefined();
    expect(byId['pattern-other']!['scope_layer']).toBe('other_project');
    expect(byId['pattern-other']!['applies_to_project']).toBe('acme/other-svc');
    expect(byId['pattern-legacy']!['scope_layer']).toBe('unknown');
    expect(byId['pattern-legacy']!['applies_to_project']).toBeUndefined();

    const without = parseResponse(handleSearchKnowledge(db, { query: 'projected' }));
    for (const item of without.results) expect(item['applies_to_project']).toBeUndefined();
  });

  it('returns 5 of 8 matching cards without limit, and 8 with limit: 10 (default limit 5)', () => {
    for (let i = 1; i <= 8; i++) {
      insertCard(db, { id: `pattern-lim${i}`, title: `Limit probe ${i}`, body: 'zebracrossing handling notes' });
    }

    expect(parseResponse(handleSearchKnowledge(db, { query: 'zebracrossing' })).results).toHaveLength(5);
    expect(parseResponse(handleSearchKnowledge(db, { query: 'zebracrossing', limit: 10 })).results).toHaveLength(8);
  });
});
