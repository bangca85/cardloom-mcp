import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { getDatabase, closeDatabase } from '../../src/db/database.js';
import { initKnowledgeStore } from '../../src/services/knowledge-store.js';
import { resetGit } from '../../src/services/git-service.js';
import { initializeSchema } from '../../src/db/schema.js';
import { renderCard, saveLearningDraft, updateCardStatus } from '../../src/services/card-service.js';
import { InvalidTransitionError } from '../../src/types/errors.js';
import { handleGetCard } from '../../src/tools/get-card.js';

interface CardFixture {
  id: string;
  status?: 'draft' | 'verified' | 'deprecated';
  sensitivity?: 'normal' | 'restricted';
  supersedes?: string | null;
  deprecation_reason?: string | null;
}

function insertCard(db: Database.Database, f: CardFixture): void {
  db.prepare(
    `INSERT INTO cards (
      id, type, status, title, stack, applies_to, scope, version_range, sensitivity,
      supersedes, conflicts_with, source_commit, provenance, deprecation_reason,
      body, created_at, updated_at, file_mtime
    ) VALUES (
      @id, 'pattern', @status, @title, '["node"]', '["api"]', 'project', '>=1.0.0', @sensitivity,
      @supersedes, '[]', 'abc123', 'agent-observation', @deprecation_reason,
      'Body', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
    )`,
  ).run({
    id: f.id,
    status: f.status ?? 'verified',
    title: `Title for ${f.id}`,
    sensitivity: f.sensitivity ?? 'normal',
    supersedes: f.supersedes ?? null,
    deprecation_reason: f.deprecation_reason ?? null,
  });
}

describe('renderCard replacement (fixtures)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });
  afterEach(() => db.close());

  it('(a) lists a pending draft that supersedes a verified card', () => {
    insertCard(db, { id: 'pattern-a' });
    insertCard(db, { id: 'pattern-b', status: 'draft', supersedes: 'pattern-a' });
    expect(renderCard(db, 'pattern-a').replacement).toEqual({ pending: ['pattern-b'] });
    expect(renderCard(db, 'pattern-b').replacement).toBeUndefined();
  });

  it('lists several pending drafts sorted by id', () => {
    insertCard(db, { id: 'pattern-a' });
    insertCard(db, { id: 'pattern-z', status: 'draft', supersedes: 'pattern-a' });
    insertCard(db, { id: 'pattern-c', status: 'draft', supersedes: 'pattern-a' });
    expect(renderCard(db, 'pattern-a').replacement).toEqual({ pending: ['pattern-c', 'pattern-z'] });
  });

  it('omits replacement entirely when there is nothing to report', () => {
    insertCard(db, { id: 'pattern-a' });
    expect(renderCard(db, 'pattern-a')).not.toHaveProperty('replacement');
  });

  it('(c) reports superseded_by along a chain A -> B -> C', () => {
    insertCard(db, { id: 'pattern-a', status: 'deprecated', deprecation_reason: 'superseded by pattern-b' });
    insertCard(db, { id: 'pattern-b', status: 'deprecated', supersedes: 'pattern-a', deprecation_reason: 'superseded by pattern-c' });
    insertCard(db, { id: 'pattern-c', supersedes: 'pattern-b' });
    expect(renderCard(db, 'pattern-a').replacement).toEqual({ superseded_by: 'pattern-b', pending: [] });
    expect(renderCard(db, 'pattern-b').replacement).toEqual({ superseded_by: 'pattern-c', pending: [] });
    expect(renderCard(db, 'pattern-c').replacement).toBeUndefined();
  });

  it('(d) never lists a restricted draft as pending on a normal card', () => {
    insertCard(db, { id: 'pattern-a' });
    insertCard(db, { id: 'pattern-r', status: 'draft', sensitivity: 'restricted', supersedes: 'pattern-a' });
    expect(renderCard(db, 'pattern-a')).not.toHaveProperty('replacement');
    insertCard(db, { id: 'pattern-b', status: 'draft', supersedes: 'pattern-a' });
    expect(renderCard(db, 'pattern-a').replacement).toEqual({ pending: ['pattern-b'] });
  });

  it('(e) does not throw when a draft supersedes a missing id', () => {
    insertCard(db, { id: 'pattern-a' });
    insertCard(db, { id: 'pattern-d', status: 'draft', supersedes: 'missing-id' });
    expect(() => renderCard(db, 'pattern-d')).not.toThrow();
    expect(() => renderCard(db, 'pattern-a')).not.toThrow();
    expect(renderCard(db, 'pattern-d').replacement).toBeUndefined();
  });

  it('(f) ignores a hand-written "superseded by X" when X does not declare supersedes', () => {
    insertCard(db, { id: 'pattern-a', status: 'deprecated', deprecation_reason: 'superseded by pattern-b' });
    insertCard(db, { id: 'pattern-b' });
    expect(renderCard(db, 'pattern-a')).not.toHaveProperty('replacement');
  });

  it('ignores a reason that only starts with "superseded by" but has extra text', () => {
    insertCard(db, { id: 'pattern-a', status: 'deprecated', deprecation_reason: 'superseded by pattern-b (typo)' });
    insertCard(db, { id: 'pattern-b', supersedes: 'pattern-a' });
    expect(renderCard(db, 'pattern-a')).not.toHaveProperty('replacement');
  });

  it('does not list pending drafts on a deprecated card', () => {
    insertCard(db, { id: 'pattern-a', status: 'deprecated', deprecation_reason: 'obsolete' });
    insertCard(db, { id: 'pattern-b', status: 'draft', supersedes: 'pattern-a' });
    expect(renderCard(db, 'pattern-a')).not.toHaveProperty('replacement');
  });

  it('keeps replacement in the get_card JSON response', () => {
    insertCard(db, { id: 'pattern-a' });
    insertCard(db, { id: 'pattern-b', status: 'draft', supersedes: 'pattern-a' });
    const parsed = JSON.parse(handleGetCard(db, { id: 'pattern-a' }).content[0]!.text) as {
      card: { replacement?: unknown };
    };
    expect(parsed.card.replacement).toEqual({ pending: ['pattern-b'] });
  });
});

describe('renderCard replacement (real supersede flow)', () => {
  let storePath: string;
  let db: Database.Database;

  beforeEach(async () => {
    storePath = fs.mkdtempSync(path.join(os.tmpdir(), 'cardloom-mcp-replacement-'));
    await initKnowledgeStore(storePath);
    db = getDatabase(path.join(storePath, '.metadata', 'index.db'));
  });

  afterEach(() => {
    closeDatabase();
    resetGit();
    fs.rmSync(storePath, { recursive: true, force: true });
  });

  const draft = (title: string, supersedes?: string, appliesTo: string[] = ['api']) =>
    saveLearningDraft(db, storePath, {
      title,
      type: 'pattern',
      scope: 'project',
      applies_to: appliesTo,
      stack: ['node'],
      version_range: '>=1.0.0',
      body: `Body of ${title}.`,
      source_commit: 'abc123',
      provenance: 'agent-observation',
      ...(supersedes ? { supersedes } : {}),
    });

  it('(b) completes on verify, and a second verify of a rival draft is refused and leaves superseded_by unchanged', async () => {
    const a = (await draft('Alpha retries')).id;
    await updateCardStatus(db, storePath, { id: a, action: 'verify' });
    const b = (await draft('Beta retries', a)).id;
    const c = (await draft('Gamma retries', a, ['worker'])).id;
    expect(renderCard(db, a).replacement).toEqual({ pending: [b, c].sort() });

    await updateCardStatus(db, storePath, { id: b, action: 'verify' });
    expect(renderCard(db, a).replacement).toEqual({ superseded_by: b, pending: [] });

    // D6 behaviour change (owner-approved 2026-11-25): this used to succeed silently and keep a dead
    // `supersedes` link. Verify now refuses a draft whose target was already replaced by another card.
    await expect(updateCardStatus(db, storePath, { id: c, action: 'verify' })).rejects.toThrow(InvalidTransitionError);
    expect(renderCard(db, a).replacement).toEqual({ superseded_by: b, pending: [] });
  });
});
