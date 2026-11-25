import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { triageDrafts } from '../../src/services/triage-service.js';

interface CardFixture {
  id: string;
  type?: string;
  status?: 'draft' | 'verified' | 'deprecated';
  title?: string;
  scope?: 'project' | 'stack' | 'global';
  stack?: string[];
  applies_to?: string[];
  project?: string | null;
  version_range?: string;
  supersedes?: string | null;
  deprecation_reason?: string | null;
  created_at?: string;
}

function insertCard(db: Database.Database, f: CardFixture): void {
  db.prepare(
    `INSERT INTO cards (
      id, type, status, title, stack, applies_to, scope, project, version_range, sensitivity,
      supersedes, conflicts_with, source_commit, provenance, deprecation_reason,
      body, created_at, updated_at, file_mtime
    ) VALUES (
      @id, @type, @status, @title, @stack, @applies_to, @scope, @project, @version_range, 'normal',
      @supersedes, '[]', 'abc123', 'agent-observation', @deprecation_reason,
      'Body', @created_at, @created_at, @created_at
    )`,
  ).run({
    id: f.id,
    type: f.type ?? 'pattern',
    status: f.status ?? 'verified',
    title: f.title ?? `Title for ${f.id}`,
    stack: JSON.stringify(f.stack ?? ['node']),
    applies_to: JSON.stringify(f.applies_to ?? ['api']),
    scope: f.scope ?? 'project',
    project: f.project ?? null,
    version_range: f.version_range ?? '>=1.0.0',
    supersedes: f.supersedes ?? null,
    deprecation_reason: f.deprecation_reason ?? null,
    created_at: f.created_at ?? '2026-01-01T00:00:00Z',
  });
}

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  initializeSchema(db);
});
afterEach(() => db.close());

const NOW = new Date('2026-01-11T00:00:00Z');

describe('triageDrafts', () => {
  it('reports checked 0 for an empty store', () => {
    expect(triageDrafts(db, { now: NOW })).toEqual({ checked: 0, withRelated: [], withoutRelated: [] });
  });

  it('puts a lone draft under withoutRelated, with its age in days', () => {
    insertCard(db, { id: 'pattern-alone', status: 'draft', title: 'Lonely idea', stack: ['go'] });
    const report = triageDrafts(db, { now: NOW });
    expect(report.checked).toBe(1);
    expect(report.withRelated).toEqual([]);
    expect(report.withoutRelated).toHaveLength(1);
    expect(report.withoutRelated[0]).toMatchObject({
      id: 'pattern-alone',
      title: 'Lonely idea',
      type: 'pattern',
      ageDays: 10,
      supersedes: null,
      related: [],
    });
  });

  it('shows an opposite-meaning title as related evidence with similarity 0.67 and no judgement', () => {
    insertCard(db, { id: 'pattern-enable', status: 'draft', title: 'Enable retries for payment requests', stack: ['go'], applies_to: ['x'] });
    insertCard(db, { id: 'pattern-disable', status: 'verified', title: 'Disable retries for payment requests', stack: ['rust'], applies_to: ['y'] });
    const report = triageDrafts(db, { now: NOW });
    expect(report.withRelated).toHaveLength(1);
    const rel = report.withRelated[0]!.related;
    expect(rel).toEqual([
      {
        id: 'pattern-disable',
        status: 'verified',
        title: 'Disable retries for payment requests',
        titleSimilarity: 0.67,
        facetsOverlap: false,
        sameProject: null,
        isSupersedeTarget: false,
      },
    ]);
  });

  it('relates by overlapping facets even when the titles differ, and only for the same type', () => {
    insertCard(db, { id: 'pattern-d', status: 'draft', title: 'Alpha beta', stack: ['node'], applies_to: ['api'] });
    insertCard(db, { id: 'pattern-v', title: 'Gamma delta', stack: ['node'], applies_to: ['api'] });
    insertCard(db, { id: 'gotcha-v', type: 'gotcha', title: 'Alpha beta', stack: ['node'], applies_to: ['api'] });
    const report = triageDrafts(db, { now: NOW });
    const ids = report.withRelated[0]!.related.map((r) => r.id);
    expect(ids).toEqual(['pattern-v']);
    expect(report.withRelated[0]!.related[0]).toMatchObject({ facetsOverlap: true, titleSimilarity: 0 });
  });

  it('flags a related card that was rejected, with its reason', () => {
    insertCard(db, { id: 'pattern-d', status: 'draft', title: 'Cache the token', stack: ['go'] });
    insertCard(db, {
      id: 'pattern-rej',
      status: 'deprecated',
      title: 'Cache the token',
      stack: ['rust'],
      deprecation_reason: 'rejected: duplicate of pattern-foo',
    });
    const rel = triageDrafts(db, { now: NOW }).withRelated[0]!.related[0]!;
    expect(rel.status).toBe('deprecated');
    expect(rel.rejectionReason).toBe('rejected: duplicate of pattern-foo');
    expect(rel.alreadySupersededBy).toBeUndefined();
  });

  it('shows the supersede target first, in any type, and what already replaced it', () => {
    insertCard(db, { id: 'pattern-x', status: 'deprecated', type: 'gotcha', title: 'Totally unrelated words', stack: ['rust'], deprecation_reason: 'superseded by pattern-y' });
    insertCard(db, { id: 'pattern-y', title: 'Other thing', stack: ['rust'], supersedes: 'pattern-x' });
    insertCard(db, { id: 'pattern-d', status: 'draft', title: 'Cache the token', supersedes: 'pattern-x', stack: ['node'] });
    insertCard(db, { id: 'pattern-sim', title: 'Cache the token', stack: ['go'] });
    const entry = triageDrafts(db, { now: NOW }).withRelated[0]!;
    expect(entry.supersedes).toBe('pattern-x');
    expect(entry.related.map((r) => r.id)).toEqual(['pattern-x', 'pattern-sim']);
    expect(entry.related[0]).toMatchObject({ isSupersedeTarget: true, alreadySupersededBy: 'pattern-y' });
    expect(entry.related[0]!.rejectionReason).toBeUndefined();
  });

  it('does not report alreadySupersededBy when the named successor does not declare supersedes', () => {
    insertCard(db, { id: 'pattern-x', status: 'deprecated', title: 'Cache the token', stack: ['rust'], deprecation_reason: ' superseded by pattern-y ' });
    insertCard(db, { id: 'pattern-y', title: 'Other thing', stack: ['rust'] });
    insertCard(db, { id: 'pattern-d', status: 'draft', title: 'Cache the token', stack: ['node'] });
    const rel = triageDrafts(db, { now: NOW }).withRelated[0]!.related.find((r) => r.id === 'pattern-x')!;
    expect(rel.alreadySupersededBy).toBeUndefined();
  });

  it('does not report alreadySupersededBy when the named successor does not exist', () => {
    insertCard(db, { id: 'pattern-x', status: 'deprecated', title: 'Cache the token', stack: ['rust'], deprecation_reason: 'superseded by pattern-gone' });
    insertCard(db, { id: 'pattern-d', status: 'draft', title: 'Cache the token', stack: ['node'] });
    const rel = triageDrafts(db, { now: NOW }).withRelated[0]!.related.find((r) => r.id === 'pattern-x')!;
    expect(rel.alreadySupersededBy).toBeUndefined();
  });

  it('reports sameProject true/false/null from normalized project keys', () => {
    insertCard(db, { id: 'pattern-d', status: 'draft', title: 'Shared words here', project: 'Acme/API', stack: ['node'] });
    insertCard(db, { id: 'pattern-same', title: 'Shared words here', project: 'acme/api', stack: ['node'] });
    insertCard(db, { id: 'pattern-other', title: 'Shared words here', project: 'beta', stack: ['node'] });
    insertCard(db, { id: 'pattern-none', title: 'Shared words here', project: null, stack: ['node'] });
    const rel = triageDrafts(db, { now: NOW }).withRelated[0]!.related;
    const by = Object.fromEntries(rel.map((r) => [r.id, r.sameProject]));
    expect(by).toEqual({ 'pattern-same': true, 'pattern-other': false, 'pattern-none': null });
  });

  it('caps related cards at 5, most similar first', () => {
    insertCard(db, { id: 'pattern-d', status: 'draft', title: 'one two three four', stack: ['go'] });
    for (let i = 0; i < 7; i++) {
      insertCard(db, { id: `pattern-c${i}`, title: i === 6 ? 'one two three four' : `one two three four filler${i}`, stack: ['rust'] });
    }
    const rel = triageDrafts(db, { now: NOW }).withRelated[0]!.related;
    expect(rel).toHaveLength(5);
    expect(rel[0]!.id).toBe('pattern-c6');
    expect(rel[0]!.titleSimilarity).toBe(1);
  });

  it('limits how many drafts are examined, oldest first', () => {
    insertCard(db, { id: 'pattern-new', status: 'draft', title: 'New one', stack: ['go'], created_at: '2026-01-10T00:00:00Z' });
    insertCard(db, { id: 'pattern-old', status: 'draft', title: 'Old one', stack: ['go'], created_at: '2026-01-02T00:00:00Z' });
    const report = triageDrafts(db, { now: NOW, limit: 1 });
    expect(report.checked).toBe(1);
    expect([...report.withRelated, ...report.withoutRelated].map((e) => e.id)).toEqual(['pattern-old']);
  });

  it('triages 1,000 synthetic cards in under 2 seconds', () => {
    const stacks = ['typescript', 'javascript', 'node', 'react', 'sqlite', 'docker', 'go', 'python'];
    const types = ['decision', 'pattern', 'snippet', 'gotcha', 'playbook'];
    const tx = db.transaction(() => {
      for (let i = 1; i <= 1000; i++) {
        insertCard(db, {
          id: `${types[i % types.length]}-dummy-${i}`,
          type: types[i % types.length]!,
          status: i % 5 === 0 ? 'draft' : 'verified',
          title: `Dummy Card ${i}`,
          stack: [stacks[i % stacks.length]!, stacks[(i + 1) % stacks.length]!],
          applies_to: ['api'],
          version_range: '*',
          supersedes: i > 1 ? `decision-dummy-${i - 1}` : null,
        });
      }
    });
    tx();
    const start = performance.now();
    const report = triageDrafts(db, { now: NOW });
    const elapsed = performance.now() - start;
    expect(report.checked).toBe(200);
    expect(elapsed).toBeLessThan(2000);
  });
});
