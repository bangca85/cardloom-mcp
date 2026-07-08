import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import matter from 'gray-matter';
import Database from 'better-sqlite3';
import { getDatabase, closeDatabase } from '../../src/db/database.js';
import { initKnowledgeStore } from '../../src/services/knowledge-store.js';
import { resetGit, getGit } from '../../src/services/git-service.js';
import { initializeSchema } from '../../src/db/schema.js';
import { saveLearningDraft, renderCard, updateCardStatus, type SaveLearningDraftInput } from '../../src/services/card-service.js';
import { searchCards } from '../../src/services/search-service.js';
import { ConflictError, ValidationError, SecretDetectedError, NotFoundError, InvalidTransitionError } from '../../src/types/errors.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cardloom-mcp-card-service-'));
}

function baseInput(overrides: Partial<SaveLearningDraftInput> = {}): SaveLearningDraftInput {
  return {
    title: 'Use X pattern for retries',
    type: 'pattern',
    scope: 'project',
    applies_to: ['api'],
    stack: ['node'],
    version_range: '>=1.0.0',
    body: 'Body describing the retry pattern in detail.',
    source_commit: 'abc123',
    provenance: 'agent-observation',
    ...overrides,
  };
}

describe('saveLearningDraft', () => {
  let storePath: string;
  let db: Database.Database;

  beforeEach(async () => {
    storePath = tmpDir();
    await initKnowledgeStore(storePath);
    db = getDatabase(path.join(storePath, '.metadata', 'index.db'));
  });

  afterEach(() => {
    closeDatabase();
    resetGit();
    fs.rmSync(storePath, { recursive: true, force: true });
  });

  it('saves a valid card as draft: file, git commit, index row, and response shape (AC1)', async () => {
    const result = await saveLearningDraft(db, storePath, baseInput());

    expect(result).toEqual({
      id: 'pattern-use-x-pattern-for-retries',
      status: 'draft',
      git_committed: true,
      git_error: undefined,
    });

    const cardPath = path.join(storePath, 'cards', 'pattern-use-x-pattern-for-retries.md');
    expect(fs.existsSync(cardPath)).toBe(true);

    const parsed = matter(fs.readFileSync(cardPath, 'utf-8'));
    expect(parsed.data['status']).toBe('draft');
    expect(parsed.data['type']).toBe('pattern');
    expect(parsed.content.trim()).toBe('Body describing the retry pattern in detail.');

    const git = getGit(storePath);
    const log = await git.log();
    expect(log.all.some((c) => c.message.includes('knowledge: add pattern-use-x-pattern-for-retries'))).toBe(true);

    const row = db.prepare('SELECT id, status FROM cards WHERE id = ?').get('pattern-use-x-pattern-for-retries') as
      | { id: string; status: string }
      | undefined;
    expect(row).toEqual({ id: 'pattern-use-x-pattern-for-retries', status: 'draft' });
  });

  it('records supersedes as a pending marker only — the old card is left untouched (AC2, AD-13)', async () => {
    await saveLearningDraft(db, storePath, baseInput({ title: 'Old retry pattern' }));
    const oldId = 'pattern-old-retry-pattern';
    const oldCardPath = path.join(storePath, 'cards', `${oldId}.md`);
    const oldFileBefore = fs.readFileSync(oldCardPath, 'utf-8');
    const oldRowBefore = db.prepare('SELECT status FROM cards WHERE id = ?').get(oldId);

    const result = await saveLearningDraft(
      db,
      storePath,
      baseInput({ title: 'New retry pattern v2', supersedes: oldId }),
    );

    expect(result.status).toBe('draft');

    const newCard = matter(fs.readFileSync(path.join(storePath, 'cards', `${result.id}.md`), 'utf-8'));
    expect(newCard.data['supersedes']).toBe(oldId);

    const oldFileAfter = fs.readFileSync(oldCardPath, 'utf-8');
    const oldRowAfter = db.prepare('SELECT status FROM cards WHERE id = ?').get(oldId);
    expect(oldFileAfter).toBe(oldFileBefore);
    expect(oldRowAfter).toEqual(oldRowBefore);
  });

  it('throws not_found when supersedes references a card that does not exist', async () => {
    await expect(
      saveLearningDraft(db, storePath, baseInput({ supersedes: 'pattern-does-not-exist' })),
    ).rejects.toThrow(NotFoundError);
  });

  it('rejects content containing a secret pattern and writes no file (AC3)', async () => {
    await expect(
      saveLearningDraft(db, storePath, baseInput({ body: 'API_KEY=sk-abc123defghijklmnop456' })),
    ).rejects.toThrow(SecretDetectedError);

    expect(fs.readdirSync(path.join(storePath, 'cards'))).toHaveLength(0);
  });

  it('rejects a schema-invalid card (AC3)', async () => {
    const invalidInput = baseInput({ type: 'gotcha' });
    // gotcha requires error_signature — omitted here on purpose.
    await expect(saveLearningDraft(db, storePath, invalidInput)).rejects.toThrow(ValidationError);
  });

  it('rejects with a facet conflict against an existing active card (AC3)', async () => {
    await saveLearningDraft(db, storePath, baseInput({ title: 'First retry pattern' }));

    await expect(
      saveLearningDraft(db, storePath, baseInput({ title: 'Second retry pattern' })),
    ).rejects.toThrow(ConflictError);
  });

  it('rejects an id collision from a duplicate slug and leaves the original file intact (AC4)', async () => {
    await saveLearningDraft(db, storePath, baseInput());
    const cardPath = path.join(storePath, 'cards', 'pattern-use-x-pattern-for-retries.md');
    const before = fs.readFileSync(cardPath, 'utf-8');

    let error: ConflictError | undefined;
    try {
      // Same title -> same derived id, but a different stack so it isn't also caught as a facet conflict first.
      await saveLearningDraft(db, storePath, baseInput({ stack: ['unrelated-stack'] }));
    } catch (e) {
      error = e as ConflictError;
    }

    expect(error).toBeInstanceOf(ConflictError);
    expect(fs.readFileSync(cardPath, 'utf-8')).toBe(before);

    const count = db.prepare('SELECT COUNT(*) as c FROM cards').get() as { c: number };
    expect(count.c).toBe(1);
  });
});

interface RenderCardFixture {
  id: string;
  status?: 'draft' | 'verified' | 'deprecated';
  sensitivity?: 'normal' | 'restricted';
  deprecation_reason?: string | null;
  last_verified?: string | null;
  failure?: number;
}

function insertRenderableCard(rdb: Database.Database, fixture: RenderCardFixture): void {
  rdb
    .prepare(
      `INSERT INTO cards (
        id, type, status, title, domain, stack, applies_to, task_type, error_signature,
        scope, version_range, sensitivity, supersedes, conflicts_with, source_commit, provenance,
        verified_by, verification_method, last_verified, deprecation_reason, deprecated_at, deprecated_by,
        body, created_at, updated_at, file_mtime
      ) VALUES (
        @id, 'pattern', @status, @title, NULL, '["node"]', '["api"]', NULL, NULL,
        'project', '>=1.0.0', @sensitivity, NULL, '[]', 'abc123', 'agent-observation',
        @verified_by, @verification_method, @last_verified, @deprecation_reason, @deprecated_at, @deprecated_by,
        'Body content.', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
      )`,
    )
    .run({
      id: fixture.id,
      status: fixture.status ?? 'verified',
      title: `Title for ${fixture.id}`,
      sensitivity: fixture.sensitivity ?? 'normal',
      verified_by: fixture.status === 'draft' ? null : 'bradley',
      verification_method: fixture.status === 'draft' ? null : 'manual-review',
      last_verified: fixture.status === 'draft' ? null : (fixture.last_verified ?? '2026-01-01T00:00:00Z'),
      deprecation_reason: fixture.status === 'deprecated' ? (fixture.deprecation_reason ?? 'superseded') : null,
      deprecated_at: fixture.status === 'deprecated' ? '2026-01-01T00:00:00Z' : null,
      deprecated_by: fixture.status === 'deprecated' ? 'bradley' : null,
    });

  if (fixture.failure !== undefined) {
    rdb.prepare('INSERT INTO counters (card_id, usage, success, failure) VALUES (?, 0, 0, ?)').run(fixture.id, fixture.failure);
  }
}

describe('updateCardStatus', () => {
  let storePath: string;
  let db: Database.Database;

  beforeEach(async () => {
    storePath = tmpDir();
    await initKnowledgeStore(storePath);
    db = getDatabase(path.join(storePath, '.metadata', 'index.db'));
  });

  afterEach(() => {
    closeDatabase();
    resetGit();
    fs.rmSync(storePath, { recursive: true, force: true });
  });

  it('draft -> verify sets verified_by/verification_method/last_verified on file and row (AC1)', async () => {
    await saveLearningDraft(db, storePath, baseInput({ title: 'Verify me pattern' }));
    const id = 'pattern-verify-me-pattern';

    const result = await updateCardStatus(db, storePath, { id, action: 'verify', by: 'bradley' });

    expect(result.status).toBe('verified');

    const cardPath = path.join(storePath, 'cards', `${id}.md`);
    const parsed = matter(fs.readFileSync(cardPath, 'utf-8'));
    expect(parsed.data['status']).toBe('verified');
    expect(parsed.data['verified_by']).toBe('bradley');
    expect(parsed.data['verification_method']).toBe('chat-approval');
    expect(typeof parsed.data['last_verified']).toBe('string');

    const row = db.prepare('SELECT status, verified_by, verification_method, last_verified FROM cards WHERE id = ?').get(id);
    expect(row).toMatchObject({ status: 'verified', verified_by: 'bradley', verification_method: 'chat-approval' });
  });

  it('draft -> deprecate sets deprecation_reason/at/by, keeps the file, and hides it from default search (AC2)', async () => {
    await saveLearningDraft(db, storePath, baseInput({ title: 'Deprecate from draft pattern' }));
    const id = 'pattern-deprecate-from-draft-pattern';
    const cardPath = path.join(storePath, 'cards', `${id}.md`);

    const result = await updateCardStatus(db, storePath, { id, action: 'deprecate', reason: 'no longer accurate' });

    expect(result.status).toBe('deprecated');
    expect(fs.existsSync(cardPath)).toBe(true);

    const parsed = matter(fs.readFileSync(cardPath, 'utf-8'));
    expect(parsed.data['status']).toBe('deprecated');
    expect(parsed.data['deprecation_reason']).toBe('no longer accurate');
    expect(typeof parsed.data['deprecated_at']).toBe('string');
    expect(parsed.data['deprecated_by']).toBe('bradley');

    const defaultResults = searchCards(db, 'deprecate from draft');
    expect(defaultResults.map((r) => r.id)).not.toContain(id);
  });

  it('verified -> deprecate carries forward verified_by/verification_method/last_verified and adds deprecation fields (AC2)', async () => {
    await saveLearningDraft(db, storePath, baseInput({ title: 'Verified then deprecated pattern' }));
    const id = 'pattern-verified-then-deprecated-pattern';
    await updateCardStatus(db, storePath, { id, action: 'verify' });

    const result = await updateCardStatus(db, storePath, { id, action: 'deprecate', reason: 'superseded' });

    expect(result.status).toBe('deprecated');
    const row = db
      .prepare('SELECT verified_by, verification_method, deprecation_reason FROM cards WHERE id = ?')
      .get(id) as { verified_by: string; verification_method: string; deprecation_reason: string };
    expect(row.verified_by).toBe('bradley');
    expect(row.verification_method).toBe('chat-approval');
    expect(row.deprecation_reason).toBe('superseded');
  });

  it('throws NotFoundError for a card id that does not exist', async () => {
    await expect(updateCardStatus(db, storePath, { id: 'pattern-missing', action: 'verify' })).rejects.toThrow(
      NotFoundError,
    );
  });

  it('throws InvalidTransitionError when verifying an already-deprecated card, with valid transitions in details', async () => {
    await saveLearningDraft(db, storePath, baseInput({ title: 'Already deprecated pattern' }));
    const id = 'pattern-already-deprecated-pattern';
    await updateCardStatus(db, storePath, { id, action: 'deprecate', reason: 'first deprecation' });

    let error: InvalidTransitionError | undefined;
    try {
      await updateCardStatus(db, storePath, { id, action: 'verify' });
    } catch (e) {
      error = e as InvalidTransitionError;
    }

    expect(error).toBeInstanceOf(InvalidTransitionError);
    expect(error!.details).toMatchObject({ from: 'deprecated', action: 'verify', validTransitions: [] });
  });

  it('throws InvalidTransitionError when deprecating an already-deprecated card (no un-deprecate, terminal)', async () => {
    await saveLearningDraft(db, storePath, baseInput({ title: 'Double deprecate pattern' }));
    const id = 'pattern-double-deprecate-pattern';
    await updateCardStatus(db, storePath, { id, action: 'deprecate', reason: 'first' });

    await expect(updateCardStatus(db, storePath, { id, action: 'deprecate', reason: 'second' })).rejects.toThrow(
      InvalidTransitionError,
    );
  });

  it('throws InvalidTransitionError for an unrecognized action', async () => {
    await saveLearningDraft(db, storePath, baseInput({ title: 'Unknown action pattern' }));
    const id = 'pattern-unknown-action-pattern';

    let error: InvalidTransitionError | undefined;
    try {
      await updateCardStatus(db, storePath, { id, action: 'delete' });
    } catch (e) {
      error = e as InvalidTransitionError;
    }

    expect(error).toBeInstanceOf(InvalidTransitionError);
    expect((error!.details as { validTransitions: string[] }).validTransitions).toEqual(['verified', 'deprecated']);
  });

  it('throws ValidationError when deprecating without a reason', async () => {
    await saveLearningDraft(db, storePath, baseInput({ title: 'Missing reason pattern' }));
    const id = 'pattern-missing-reason-pattern';

    await expect(updateCardStatus(db, storePath, { id, action: 'deprecate' })).rejects.toThrow(ValidationError);
  });
});

describe('updateCardStatus — supersede two-phase (3.4)', () => {
  let storePath: string;
  let db: Database.Database;

  beforeEach(async () => {
    storePath = tmpDir();
    await initKnowledgeStore(storePath);
    db = getDatabase(path.join(storePath, '.metadata', 'index.db'));
  });

  afterEach(() => {
    closeDatabase();
    resetGit();
    fs.rmSync(storePath, { recursive: true, force: true });
  });

  it('verify new (supersedes old, old verified): deprecates old in the SAME commit, both rows updated (AC1)', async () => {
    await saveLearningDraft(db, storePath, baseInput({ title: 'Old retry pattern v1' }));
    const oldId = 'pattern-old-retry-pattern-v1';
    await updateCardStatus(db, storePath, { id: oldId, action: 'verify' });

    await saveLearningDraft(db, storePath, baseInput({ title: 'New retry pattern v2', supersedes: oldId }));
    const newId = 'pattern-new-retry-pattern-v2';

    const git = getGit(storePath);
    const logBefore = await git.log();

    const result = await updateCardStatus(db, storePath, { id: newId, action: 'verify' });
    expect(result.status).toBe('verified');

    // One pipeline execute == one commit, even though it mutates two cards (AD-13).
    const logAfter = await git.log();
    expect(logAfter.total).toBe(logBefore.total + 1);
    expect(logAfter.latest?.message).toBe(`knowledge: verify ${newId} (supersedes ${oldId})`);

    const newRow = db.prepare('SELECT status FROM cards WHERE id = ?').get(newId);
    expect(newRow).toEqual({ status: 'verified' });

    const oldRow = db.prepare('SELECT status, deprecation_reason FROM cards WHERE id = ?').get(oldId);
    expect(oldRow).toEqual({ status: 'deprecated', deprecation_reason: `superseded by ${newId}` });

    const oldFile = matter(fs.readFileSync(path.join(storePath, 'cards', `${oldId}.md`), 'utf-8'));
    expect(oldFile.data['status']).toBe('deprecated');
    expect(oldFile.data['deprecation_reason']).toBe(`superseded by ${newId}`);
  });

  it('does not touch an already-deprecated supersede target — no double-deprecate, reason preserved (AC3)', async () => {
    await saveLearningDraft(db, storePath, baseInput({ title: 'Old already dead pattern' }));
    const oldId = 'pattern-old-already-dead-pattern';
    await updateCardStatus(db, storePath, { id: oldId, action: 'deprecate', reason: 'manually retired' });

    const oldCardPath = path.join(storePath, 'cards', `${oldId}.md`);
    const oldFileBefore = fs.readFileSync(oldCardPath, 'utf-8');
    const oldRowBefore = db.prepare('SELECT status, deprecation_reason FROM cards WHERE id = ?').get(oldId);

    await saveLearningDraft(db, storePath, baseInput({ title: 'New after dead pattern', supersedes: oldId }));
    const newId = 'pattern-new-after-dead-pattern';
    const result = await updateCardStatus(db, storePath, { id: newId, action: 'verify' });

    expect(result.status).toBe('verified');
    expect(fs.readFileSync(oldCardPath, 'utf-8')).toBe(oldFileBefore);
    expect(db.prepare('SELECT status, deprecation_reason FROM cards WHERE id = ?').get(oldId)).toEqual(oldRowBefore);
  });

  it('deprecating the new draft card cancels the pending supersede — old card is never touched (AC2)', async () => {
    await saveLearningDraft(db, storePath, baseInput({ title: 'Old untouched pattern' }));
    const oldId = 'pattern-old-untouched-pattern';
    await updateCardStatus(db, storePath, { id: oldId, action: 'verify' });

    const oldCardPath = path.join(storePath, 'cards', `${oldId}.md`);
    const oldFileBefore = fs.readFileSync(oldCardPath, 'utf-8');
    const oldMtimeBefore = fs.statSync(oldCardPath).mtimeMs;

    await saveLearningDraft(db, storePath, baseInput({ title: 'New pending pattern', supersedes: oldId }));
    const newId = 'pattern-new-pending-pattern';

    const result = await updateCardStatus(db, storePath, { id: newId, action: 'deprecate', reason: 'changed my mind' });
    expect(result.status).toBe('deprecated');

    expect(fs.readFileSync(oldCardPath, 'utf-8')).toBe(oldFileBefore);
    expect(fs.statSync(oldCardPath).mtimeMs).toBe(oldMtimeBefore);
    expect(db.prepare('SELECT status FROM cards WHERE id = ?').get(oldId)).toEqual({ status: 'verified' });
  });

  it('verifies successfully with a dangling supersedes target (old removed from disk+index), warning to stderr', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await saveLearningDraft(db, storePath, baseInput({ title: 'Soon deleted pattern' }));
    const oldId = 'pattern-soon-deleted-pattern';

    await saveLearningDraft(db, storePath, baseInput({ title: 'Dangling supersede pattern', supersedes: oldId }));
    const newId = 'pattern-dangling-supersede-pattern';

    // Simulate the old card having been removed from disk+index by some other process/machine.
    fs.rmSync(path.join(storePath, 'cards', `${oldId}.md`));
    db.prepare('DELETE FROM cards WHERE id = ?').run(oldId);

    const result = await updateCardStatus(db, storePath, { id: newId, action: 'verify' });

    expect(result.status).toBe('verified');
    expect(errorSpy.mock.calls.some(([msg]) => String(msg).includes(`supersedes target ${oldId} not found`))).toBe(true);

    errorSpy.mockRestore();
  });

  it('throws ValidationError when a card attempts to supersede itself', async () => {
    const id = 'pattern-self-supersede-pattern';
    const cardPath = path.join(storePath, 'cards', `${id}.md`);
    const frontmatter = {
      type: 'pattern',
      status: 'draft',
      title: 'Self supersede pattern',
      scope: 'global',
      version_range: '*',
      sensitivity: 'normal',
      source_commit: 'abcdef',
      provenance: 'test',
      supersedes: id,
    };
    fs.mkdirSync(path.dirname(cardPath), { recursive: true });
    fs.writeFileSync(cardPath, matter.stringify('Self supersede body', frontmatter));
    db.prepare(`
      INSERT INTO cards (id, type, status, title, scope, version_range, sensitivity, supersedes, source_commit, provenance, body, created_at, updated_at)
      VALUES (?, 'pattern', 'draft', 'Self supersede pattern', 'global', '*', 'normal', ?, 'abcdef', 'test', 'Self supersede body', '2026-07-06T00:00:00Z', '2026-07-06T00:00:00Z')
    `).run(id, id);

    await expect(updateCardStatus(db, storePath, { id, action: 'verify' })).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError on path traversal ID in updateCardStatus', async () => {
    await expect(updateCardStatus(db, storePath, { id: '../escaped-id', action: 'verify' })).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError on path traversal supersedes in updateCardStatus', async () => {
    const id = 'pattern-traversal-supersedes-pattern';
    const cardPath = path.join(storePath, 'cards', `${id}.md`);
    const frontmatter = {
      type: 'pattern',
      status: 'draft',
      title: 'Traversal supersedes pattern',
      scope: 'global',
      version_range: '*',
      sensitivity: 'normal',
      source_commit: 'abcdef',
      provenance: 'test',
      supersedes: '../../escaped-target',
    };
    fs.mkdirSync(path.dirname(cardPath), { recursive: true });
    fs.writeFileSync(cardPath, matter.stringify('Traversal supersedes body', frontmatter));
    db.prepare(`
      INSERT INTO cards (id, type, status, title, scope, version_range, sensitivity, supersedes, source_commit, provenance, body, created_at, updated_at)
      VALUES (?, 'pattern', 'draft', 'Traversal supersedes pattern', 'global', '*', 'normal', '../../escaped-target', 'abcdef', 'test', 'Traversal supersedes body', '2026-07-06T00:00:00Z', '2026-07-06T00:00:00Z')
    `).run(id);

    await expect(updateCardStatus(db, storePath, { id, action: 'verify' })).rejects.toThrow(ValidationError);
  });

  it('verifies successfully and warns when supersede target exists in DB but is missing on disk', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await saveLearningDraft(db, storePath, baseInput({ title: 'Soon deleted disk pattern' }));
    const oldId = 'pattern-soon-deleted-disk-pattern';
    await updateCardStatus(db, storePath, { id: oldId, action: 'verify' });

    await saveLearningDraft(db, storePath, baseInput({ title: 'Dangling disk supersede pattern', supersedes: oldId }));
    const newId = 'pattern-dangling-disk-supersede-pattern';

    // Remove old card from disk but KEEP it in index DB
    fs.rmSync(path.join(storePath, 'cards', `${oldId}.md`));

    const result = await updateCardStatus(db, storePath, { id: newId, action: 'verify' });

    expect(result.status).toBe('verified');
    expect(errorSpy.mock.calls.some(([msg]) => String(msg).includes(`supersedes target ${oldId} not found`))).toBe(true);

    errorSpy.mockRestore();
  });
});

describe('renderCard', () => {
  let rdb: Database.Database;

  beforeEach(() => {
    rdb = new Database(':memory:');
    initializeSchema(rdb);
  });

  afterEach(() => {
    rdb.close();
  });

  it('throws NotFoundError for an id that does not exist', () => {
    expect(() => renderCard(rdb, 'pattern-does-not-exist')).toThrow(NotFoundError);
  });

  it('renders a verified card with no extra labels, body, and trust present', () => {
    insertRenderableCard(rdb, { id: 'pattern-verified' });

    const card = renderCard(rdb, 'pattern-verified');

    expect(card.status).toBe('verified');
    expect(card.body).toBe('Body content.');
    expect(typeof card.trust).toBe('number');
    expect(card.untrusted).toBeUndefined();
    expect(card.deprecated).toBeUndefined();
    expect(card.restricted).toBeUndefined();
  });

  it('stamps untrusted:true on a draft card', () => {
    insertRenderableCard(rdb, { id: 'pattern-draft', status: 'draft' });

    const card = renderCard(rdb, 'pattern-draft');

    expect(card.untrusted).toBe(true);
  });

  it('stamps deprecated:true plus the deprecation_reason on a deprecated card', () => {
    insertRenderableCard(rdb, { id: 'pattern-deprecated', status: 'deprecated', deprecation_reason: 'superseded by pattern-v2' });

    const card = renderCard(rdb, 'pattern-deprecated');

    expect(card.deprecated).toBe(true);
    expect(card.deprecation_reason).toBe('superseded by pattern-v2');
  });

  it('stamps restricted:true on a restricted card, and still returns the body', () => {
    insertRenderableCard(rdb, { id: 'pattern-restricted', sensitivity: 'restricted' });

    const card = renderCard(rdb, 'pattern-restricted');

    expect(card.restricted).toBe(true);
    expect(card.body).toBe('Body content.');
  });

  it('flags stale when last_verified is older than the configured threshold, and needs_review from counters', () => {
    const now = new Date('2026-07-05T00:00:00Z');
    const oldDate = new Date(now.getTime() - 200 * 24 * 60 * 60 * 1000).toISOString();
    insertRenderableCard(rdb, { id: 'pattern-stale', last_verified: oldDate, failure: 5 });

    const card = renderCard(rdb, 'pattern-stale', now);

    expect(card.flags.stale).toBe(true);
    expect(card.flags.needs_review).toBe(true);
  });

  it('never includes a drift flag — get_card/Resource have no query context to compare against', () => {
    insertRenderableCard(rdb, { id: 'pattern-no-drift' });

    const card = renderCard(rdb, 'pattern-no-drift');

    expect('drift' in card.flags).toBe(false);
  });
});
