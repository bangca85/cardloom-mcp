import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { getDatabase, closeDatabase } from '../../src/db/database.js';
import { initKnowledgeStore } from '../../src/services/knowledge-store.js';
import { reconcileIndex } from '../../src/services/index-reconciler.js';
import { resetGit } from '../../src/services/git-service.js';
import { MutationPipeline } from '../../src/services/mutation-pipeline.js';
import { SecretDetectedError } from '../../src/types/errors.js';
import * as gitServiceModule from '../../src/services/git-service.js';
import * as secretScannerModule from '../../src/services/secret-scanner.js';

const WORKER_SCRIPT = path.join(import.meta.dirname, '..', 'fixtures', 'pipeline-worker.ts');

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cardloom-mcp-pipeline-'));
}

function runWorker(storePath: string, dbPath: string, workerId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', WORKER_SCRIPT, storePath, dbPath, workerId], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`worker ${workerId} exited with code ${code}: ${stderr}`));
    });
    child.on('error', reject);
  });
}

describe('MutationPipeline.execute', () => {
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
    vi.restoreAllMocks();
    fs.rmSync(storePath, { recursive: true, force: true });
  });

  it('runs steps in the fixed order: scan → validate → conflict → file → git → index', async () => {
    const scanSpy = vi.spyOn(secretScannerModule, 'scanForSecrets');
    const gitSpy = vi.spyOn(gitServiceModule, 'gitCommit');

    const validateFn = vi.fn();
    const conflictFn = vi.fn();
    const filePath = path.join(storePath, 'cards', 'order-test.md');
    const writeFilesFn = vi.fn(() => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, 'content');
      return { result: { ok: true }, tempFiles: [] };
    });
    const updateIndexFn = vi.fn();

    const pipeline = new MutationPipeline(db, storePath);
    await pipeline.execute({
      scanContent: 'clean content, no secrets here',
      validate: validateFn,
      conflictCheck: conflictFn,
      writeFiles: writeFilesFn,
      filesToCommit: ['cards/order-test.md'],
      commitMessage: 'knowledge: add order-test',
      updateIndex: updateIndexFn,
    });

    expect(scanSpy).toHaveBeenCalledWith('clean content, no secrets here');
    expect(gitSpy).toHaveBeenCalled();

    const scanOrder = scanSpy.mock.invocationCallOrder[0]!;
    const validateOrder = validateFn.mock.invocationCallOrder[0]!;
    const conflictOrder = conflictFn.mock.invocationCallOrder[0]!;
    const writeOrder = writeFilesFn.mock.invocationCallOrder[0]!;
    const gitOrder = gitSpy.mock.invocationCallOrder[0]!;
    const indexOrder = updateIndexFn.mock.invocationCallOrder[0]!;

    expect(scanOrder).toBeLessThan(validateOrder);
    expect(validateOrder).toBeLessThan(conflictOrder);
    expect(conflictOrder).toBeLessThan(writeOrder);
    expect(writeOrder).toBeLessThan(gitOrder);
    expect(gitOrder).toBeLessThan(indexOrder);
  });

  it('aborts before writing any file when the secret scanner rejects the content', async () => {
    const writeFilesFn = vi.fn(() => ({ result: {}, tempFiles: [] }));
    const updateIndexFn = vi.fn();

    const pipeline = new MutationPipeline(db, storePath);

    await expect(
      pipeline.execute({
        scanContent: 'API_KEY=sk-abc123defghijklmnop456',
        writeFiles: writeFilesFn,
        filesToCommit: [],
        commitMessage: 'knowledge: should never happen',
        updateIndex: updateIndexFn,
      }),
    ).rejects.toThrow(SecretDetectedError);

    expect(writeFilesFn).not.toHaveBeenCalled();
    expect(updateIndexFn).not.toHaveBeenCalled();
  });

  it('heals via reconcile when the index update fails after the file was already written', async () => {
    fs.mkdirSync(path.join(storePath, 'cards'), { recursive: true });
    const cardPath = path.join(storePath, 'cards', 'pattern-heal-test.md');
    const cardContent = `---
type: pattern
scope: project
applies_to: [api]
stack: [node]
version_range: ">=1.0.0"
sensitivity: normal
source_commit: abc123
provenance: agent-observation
title: Heal test pattern
status: draft
---
Body describing the heal-test pattern.
`;

    const pipeline = new MutationPipeline(db, storePath);

    const outcome = await pipeline.execute<{ ok: boolean }>({
      writeFiles: () => {
        fs.writeFileSync(cardPath, cardContent);
        return { result: { ok: true }, tempFiles: [] };
      },
      filesToCommit: ['cards/pattern-heal-test.md'],
      commitMessage: 'knowledge: add pattern-heal-test',
      updateIndex: () => {
        throw new Error('simulated SQLite failure');
      },
    });

    expect(outcome.indexUpdated).toBe(false);
    expect(outcome.indexError).toContain('simulated SQLite failure');
    expect(fs.existsSync(cardPath)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) as c FROM cards').get()).toEqual({ c: 0 });

    await reconcileIndex(db, storePath);

    const row = db.prepare('SELECT id FROM cards WHERE id = ?').get('pattern-heal-test');
    expect(row).toBeDefined();
  });

  it('skips git commit and index update once the lock is reported compromised', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const gitSpy = vi.spyOn(gitServiceModule, 'gitCommit');
    const updateIndexFn = vi.fn();

    // proper-lockfile clamps stale to a 2000ms floor and update to a 1000ms floor
    // regardless of what's requested — wait past the floor so the background
    // mtime-check has a chance to notice the lockfile is gone and fire onCompromised.
    const pipeline = new MutationPipeline(db, storePath, undefined, { stale: 2000, update: 1000 });
    const lockFilePath = path.join(storePath, '.metadata', 'write.lock');

    const outcome = await pipeline.execute({
      writeFiles: async () => {
        // Simulate an external process forcibly reclaiming the stale lock mid-mutation.
        fs.rmSync(lockFilePath, { recursive: true, force: true });
        await new Promise((resolve) => setTimeout(resolve, 1200));
        return { result: {}, tempFiles: [] };
      },
      filesToCommit: [],
      commitMessage: 'knowledge: should not be committed',
      updateIndex: updateIndexFn,
    });

    expect(outcome.gitCommitted).toBe(false);
    expect(outcome.indexUpdated).toBe(false);
    expect(gitSpy).not.toHaveBeenCalled();
    expect(updateIndexFn).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.some(([msg]) => String(msg).includes('[pipeline] lock compromised'))).toBe(true);
  }, 10000);

  it('serializes two concurrent cross-process mutations without corrupting the store', async () => {
    closeDatabase();
    const dbPath = path.join(storePath, '.metadata', 'index.db');

    await Promise.all([runWorker(storePath, dbPath, '1'), runWorker(storePath, dbPath, '2')]);

    const verifyDb = new Database(dbPath);
    try {
      const rows = verifyDb.prepare('SELECT id FROM cards ORDER BY id').all() as Array<{ id: string }>;
      expect(rows.map((r) => r.id)).toEqual(['pattern-worker-1', 'pattern-worker-2']);

      expect(fs.existsSync(path.join(storePath, 'cards', 'pattern-worker-1.md'))).toBe(true);
      expect(fs.existsSync(path.join(storePath, 'cards', 'pattern-worker-2.md'))).toBe(true);
    } finally {
      verifyDb.close();
    }
  }, 20000);
});
