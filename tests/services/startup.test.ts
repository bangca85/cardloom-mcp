import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getDatabase, closeDatabase } from '../../src/db/database.js';
import { initKnowledgeStore } from '../../src/services/knowledge-store.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cardloom-mcp-test-'));
}

describe('Startup: knowledge store + SQLite + reconciliation', () => {
  let storePath: string;

  beforeEach(() => {
    storePath = tmpDir();
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(storePath, { recursive: true, force: true });
  });

  it('initKnowledgeStore creates dirs and git repo', async () => {
    await initKnowledgeStore(storePath);

    expect(fs.existsSync(path.join(storePath, 'cards'))).toBe(true);
    expect(fs.existsSync(path.join(storePath, 'events'))).toBe(true);
    expect(fs.existsSync(path.join(storePath, 'benchmark'))).toBe(true);
    expect(fs.existsSync(path.join(storePath, '.git'))).toBe(true);
  });

  it('initKnowledgeStore is idempotent', async () => {
    await initKnowledgeStore(storePath);
    await initKnowledgeStore(storePath);

    expect(fs.existsSync(path.join(storePath, '.git'))).toBe(true);
  });

  it('getDatabase creates SQLite with cards, counters and cards_fts tables', () => {
    const dbPath = path.join(storePath, '.metadata', 'index.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = getDatabase(dbPath);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const tableNames = tables.map(t => t.name);

    expect(tableNames).toContain('cards');
    expect(tableNames).toContain('counters');
  });
});
