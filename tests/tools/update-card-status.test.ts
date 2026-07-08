import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { getDatabase, closeDatabase } from '../../src/db/database.js';
import { initKnowledgeStore } from '../../src/services/knowledge-store.js';
import { resetGit } from '../../src/services/git-service.js';
import { saveLearningDraft } from '../../src/services/card-service.js';
import { handleUpdateCardStatus } from '../../src/tools/update-card-status.js';
import { InvalidTransitionError, ValidationError } from '../../src/types/errors.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cardloom-mcp-update-status-'));
}

function parseResponse(result: { content: Array<{ type: string; text: string }> }): {
  id: string;
  status: string;
} {
  return JSON.parse(result.content[0]!.text) as { id: string; status: string };
}

describe('handleUpdateCardStatus', () => {
  let storePath: string;
  let db: Database.Database;

  beforeEach(async () => {
    storePath = tmpDir();
    await initKnowledgeStore(storePath);
    db = getDatabase(path.join(storePath, '.metadata', 'index.db'));
    await saveLearningDraft(db, storePath, {
      title: 'Tool wrapper pattern',
      type: 'pattern',
      scope: 'project',
      applies_to: ['api'],
      stack: ['node'],
      version_range: '>=1.0.0',
      body: 'Body content.',
      source_commit: 'abc123',
      provenance: 'agent-observation',
    });
  });

  afterEach(() => {
    closeDatabase();
    resetGit();
    fs.rmSync(storePath, { recursive: true, force: true });
  });

  it('is a thin pass-through: verify returns {id, status}', async () => {
    const response = parseResponse(
      await handleUpdateCardStatus(db, storePath, { id: 'pattern-tool-wrapper-pattern', action: 'verify' }),
    );
    expect(response).toMatchObject({ id: 'pattern-tool-wrapper-pattern', status: 'verified' });
  });

  it('propagates ValidationError when deprecating without a reason', async () => {
    await expect(
      handleUpdateCardStatus(db, storePath, { id: 'pattern-tool-wrapper-pattern', action: 'deprecate' }),
    ).rejects.toThrow(ValidationError);
  });

  it('propagates InvalidTransitionError for an unknown action', async () => {
    await expect(
      handleUpdateCardStatus(db, storePath, { id: 'pattern-tool-wrapper-pattern', action: 'unpublish' }),
    ).rejects.toThrow(InvalidTransitionError);
  });
});
