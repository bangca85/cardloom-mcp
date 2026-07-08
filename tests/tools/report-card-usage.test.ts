import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { getDatabase, closeDatabase } from '../../src/db/database.js';
import { initKnowledgeStore } from '../../src/services/knowledge-store.js';
import { resetGit } from '../../src/services/git-service.js';
import { handleReportCardUsage } from '../../src/tools/report-card-usage.js';
import { NotFoundError, ValidationError } from '../../src/types/errors.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cardloom-mcp-report-usage-'));
}

function insertCard(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO cards (
      id, type, status, title, domain, stack, applies_to, task_type, error_signature,
      scope, version_range, sensitivity, supersedes, conflicts_with, source_commit, provenance,
      verified_by, verification_method, last_verified, deprecation_reason, deprecated_at, deprecated_by,
      body, created_at, updated_at, file_mtime
    ) VALUES (
      @id, 'pattern', 'verified', @title, NULL, '["node"]', '["api"]', NULL, NULL,
      'project', '>=1.0.0', 'normal', NULL, '[]', 'abc123', 'agent-observation',
      'bradley', 'manual-review', '2026-01-01T00:00:00Z', NULL, NULL, NULL,
      'Body content.', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
    )`,
  ).run({ id, title: `Title for ${id}` });
}

function parseResponse(result: { content: Array<{ type: string; text: string }> }): {
  card: string;
  outcome: string;
  counters: { usage: number; success: number; failure: number };
} {
  return JSON.parse(result.content[0]!.text) as {
    card: string;
    outcome: string;
    counters: { usage: number; success: number; failure: number };
  };
}

describe('handleReportCardUsage', () => {
  let storePath: string;
  let db: Database.Database;

  beforeEach(async () => {
    storePath = tmpDir();
    await initKnowledgeStore(storePath);
    db = getDatabase(path.join(storePath, '.metadata', 'index.db'));
    process.env['KNOWLEDGE_MACHINE_ID'] = 'test-machine';
  });

  afterEach(() => {
    delete process.env['KNOWLEDGE_MACHINE_ID'];
    closeDatabase();
    resetGit();
    fs.rmSync(storePath, { recursive: true, force: true });
  });

  it('confirmed: increments usage and success, returns fresh counters', async () => {
    insertCard(db, 'pattern-a');

    const response = parseResponse(await handleReportCardUsage(db, storePath, { id: 'pattern-a', outcome: 'confirmed' }));

    expect(response).toMatchObject({ card: 'pattern-a', outcome: 'confirmed', counters: { usage: 1, success: 1, failure: 0 } });
  });

  it('refuted: increments usage and failure', async () => {
    insertCard(db, 'pattern-b');

    const response = parseResponse(await handleReportCardUsage(db, storePath, { id: 'pattern-b', outcome: 'refuted' }));

    expect(response.counters).toEqual({ usage: 1, success: 0, failure: 1 });
  });

  it('neutral: increments only usage', async () => {
    insertCard(db, 'pattern-c');

    const response = parseResponse(await handleReportCardUsage(db, storePath, { id: 'pattern-c', outcome: 'neutral' }));

    expect(response.counters).toEqual({ usage: 1, success: 0, failure: 0 });
  });

  it('throws NotFoundError for a card id that does not exist', async () => {
    await expect(handleReportCardUsage(db, storePath, { id: 'pattern-missing', outcome: 'confirmed' })).rejects.toThrow(
      NotFoundError,
    );
  });

  it('throws ValidationError for an outcome outside the enum', async () => {
    insertCard(db, 'pattern-d');

    await expect(handleReportCardUsage(db, storePath, { id: 'pattern-d', outcome: 'maybe' })).rejects.toThrow(
      ValidationError,
    );
  });

  it('appends the event to events/{machine-id}.jsonl with a knowledge: usage commit', async () => {
    insertCard(db, 'pattern-e');

    await handleReportCardUsage(db, storePath, { id: 'pattern-e', outcome: 'confirmed' });

    const filePath = path.join(storePath, 'events', 'test-machine.jsonl');
    expect(fs.existsSync(filePath)).toBe(true);
    const line = fs.readFileSync(filePath, 'utf-8').trim();
    expect(JSON.parse(line)).toMatchObject({ v: 1, card: 'pattern-e', outcome: 'confirmed' });

    const { simpleGit } = await import('simple-git');
    const git = simpleGit(storePath);
    const log = await git.log();
    expect(log.all.some((c) => c.message.includes('knowledge: usage pattern-e'))).toBe(true);
  });
});
