import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { rebuildIndex } from '../../src/cli/rebuild-index.js';
import { closeDatabase } from '../../src/db/database.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cardloom-mcp-rebuild-cli-'));
}

const VALID_CARD = `---
type: pattern
scope: project
applies_to: [api]
stack: [node]
version_range: ">=1.0.0"
status: verified
sensitivity: normal
source_commit: abc123
provenance: agent-observation
title: CLI rebuild test pattern
verified_by: bradley
verification_method: manual-review
last_verified: "2026-01-01T00:00:00Z"
---
Body for CLI rebuild test.
`;

function cardContentFor(n: number): string {
  return `---
type: pattern
scope: project
applies_to: [api]
stack: [node]
version_range: ">=1.0.0"
status: verified
sensitivity: normal
source_commit: abc123
provenance: agent-observation
title: Shrink guard test pattern ${n}
verified_by: bradley
verification_method: manual-review
last_verified: "2026-01-01T00:00:00Z"
---
Body for shrink guard test ${n}.
`;
}

describe('rebuildIndex CLI (story 4.2)', () => {
  let storePath: string;
  let originalStorePathEnv: string | undefined;
  let originalIndexDbEnv: string | undefined;

  beforeEach(() => {
    storePath = tmpDir();
    originalStorePathEnv = process.env['KNOWLEDGE_STORE_PATH'];
    originalIndexDbEnv = process.env['INDEX_DB_PATH'];
    process.env['KNOWLEDGE_STORE_PATH'] = storePath;
    process.env['INDEX_DB_PATH'] = path.join(storePath, '.metadata', 'index.db');
  });

  afterEach(() => {
    closeDatabase();
    if (originalStorePathEnv === undefined) delete process.env['KNOWLEDGE_STORE_PATH'];
    else process.env['KNOWLEDGE_STORE_PATH'] = originalStorePathEnv;
    if (originalIndexDbEnv === undefined) delete process.env['INDEX_DB_PATH'];
    else process.env['INDEX_DB_PATH'] = originalIndexDbEnv;
    fs.rmSync(storePath, { recursive: true, force: true });
  });

  it('rebuilds cards + counters from cards/*.md and events/*.jsonl (AC1)', async () => {
    fs.mkdirSync(path.join(storePath, 'cards'), { recursive: true });
    fs.writeFileSync(path.join(storePath, 'cards', 'pattern-cli-rebuild-test-pattern.md'), VALID_CARD);

    fs.mkdirSync(path.join(storePath, 'events'), { recursive: true });
    fs.writeFileSync(
      path.join(storePath, 'events', 'm1.jsonl'),
      `${JSON.stringify({ v: 1, card: 'pattern-cli-rebuild-test-pattern', outcome: 'confirmed', at: '2026-01-01T00:00:00Z' })}\n`,
    );

    await rebuildIndex();

    const dbPath = path.join(storePath, '.metadata', 'index.db');
    expect(fs.existsSync(dbPath)).toBe(true);

    const db = new Database(dbPath, { readonly: true });
    const card = db.prepare('SELECT id, status FROM cards').get();
    expect(card).toEqual({ id: 'pattern-cli-rebuild-test-pattern', status: 'verified' });

    const counters = db.prepare('SELECT usage, success, failure FROM counters WHERE card_id = ?').get(
      'pattern-cli-rebuild-test-pattern',
    );
    expect(counters).toEqual({ usage: 1, success: 1, failure: 0 });
    db.close();
  });

  it('does not modify cards/ or events/ — read-only w.r.t. the store (NFR2)', async () => {
    fs.mkdirSync(path.join(storePath, 'cards'), { recursive: true });
    const cardPath = path.join(storePath, 'cards', 'pattern-cli-rebuild-test-pattern.md');
    fs.writeFileSync(cardPath, VALID_CARD);
    const cardContentBefore = fs.readFileSync(cardPath, 'utf-8');
    const cardMtimeBefore = fs.statSync(cardPath).mtimeMs;

    await rebuildIndex();

    expect(fs.readFileSync(cardPath, 'utf-8')).toBe(cardContentBefore);
    expect(fs.statSync(cardPath).mtimeMs).toBe(cardMtimeBefore);
  });

  it('recovers when an existing index.db is corrupt — deletes it and rebuilds fresh', async () => {
    const dbPath = path.join(storePath, '.metadata', 'index.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, 'this is not a valid sqlite file');

    fs.mkdirSync(path.join(storePath, 'cards'), { recursive: true });
    fs.writeFileSync(path.join(storePath, 'cards', 'pattern-cli-rebuild-test-pattern.md'), VALID_CARD);

    await expect(rebuildIndex()).resolves.not.toThrow();

    const db = new Database(dbPath, { readonly: true });
    const count = db.prepare('SELECT COUNT(*) as c FROM cards').get() as { c: number };
    expect(count.c).toBe(1);
    db.close();
  });

  it('is idempotent — running twice yields the same result', async () => {
    fs.mkdirSync(path.join(storePath, 'cards'), { recursive: true });
    fs.writeFileSync(path.join(storePath, 'cards', 'pattern-cli-rebuild-test-pattern.md'), VALID_CARD);

    await rebuildIndex();
    closeDatabase();
    await rebuildIndex();

    const dbPath = path.join(storePath, '.metadata', 'index.db');
    const db = new Database(dbPath, { readonly: true });
    const count = db.prepare('SELECT COUNT(*) as c FROM cards').get() as { c: number };
    expect(count.c).toBe(1);
    db.close();
  });

  it('logs a shrink-guard warning to stderr when the active card count drops sharply', async () => {
    const cardsDir = path.join(storePath, 'cards');
    fs.mkdirSync(cardsDir, { recursive: true });
    const cardFiles: string[] = [];
    for (let i = 0; i < 10; i++) {
      const file = path.join(cardsDir, `pattern-shrink-test-${i}.md`);
      fs.writeFileSync(file, cardContentFor(i));
      cardFiles.push(file);
    }

    await rebuildIndex();
    closeDatabase();

    // Remove all but 2 cards: 2 < 0.8 * 10, should trigger the shrink-guard warning.
    for (const file of cardFiles.slice(0, 8)) {
      fs.rmSync(file);
    }

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let calls: unknown[][];
    try {
      await rebuildIndex();
    } finally {
      calls = errorSpy.mock.calls.map((call) => [...call]);
      errorSpy.mockRestore();
    }

    const warningCalls = calls.filter((call) => String(call[0]).includes('[rebuild-index] warning'));
    expect(warningCalls.length).toBe(1);
    expect(String(warningCalls[0][0])).toContain('total card count dropped from 10 to 2');
  });

  it('does not log a shrink-guard warning exactly at the threshold boundary (count == 80% of previous)', async () => {
    const cardsDir = path.join(storePath, 'cards');
    fs.mkdirSync(cardsDir, { recursive: true });
    const cardFiles: string[] = [];
    for (let i = 0; i < 10; i++) {
      const file = path.join(cardsDir, `pattern-shrink-boundary-${i}.md`);
      fs.writeFileSync(file, cardContentFor(i));
      cardFiles.push(file);
    }

    await rebuildIndex();
    closeDatabase();

    // Remove exactly 2 of 10: 8 is NOT < 0.8 * 10 (8 < 8 is false) — must not warn.
    for (const file of cardFiles.slice(0, 2)) {
      fs.rmSync(file);
    }

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let calls: unknown[][];
    try {
      await rebuildIndex();
    } finally {
      calls = errorSpy.mock.calls.map((call) => [...call]);
      errorSpy.mockRestore();
    }

    const warningCalls = calls.filter((call) => String(call[0]).includes('[rebuild-index] warning'));
    expect(warningCalls.length).toBe(0);
  });

  it('does not log a shrink-guard warning on the first-ever rebuild (no prior index.db)', async () => {
    fs.mkdirSync(path.join(storePath, 'cards'), { recursive: true });
    fs.writeFileSync(path.join(storePath, 'cards', 'pattern-cli-rebuild-test-pattern.md'), VALID_CARD);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let calls: unknown[][];
    try {
      await rebuildIndex();
    } finally {
      calls = errorSpy.mock.calls.map((call) => [...call]);
      errorSpy.mockRestore();
    }

    const warningCalls = calls.filter((call) => String(call[0]).includes('[rebuild-index] warning'));
    expect(warningCalls.length).toBe(0);
  });

  it('does not log a shrink-guard warning when the prior index.db is corrupt, and rebuild still succeeds', async () => {
    const dbPath = path.join(storePath, '.metadata', 'index.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, 'this is not a valid sqlite file');

    fs.mkdirSync(path.join(storePath, 'cards'), { recursive: true });
    fs.writeFileSync(path.join(storePath, 'cards', 'pattern-cli-rebuild-test-pattern.md'), VALID_CARD);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let calls: unknown[][];
    try {
      await expect(rebuildIndex()).resolves.not.toThrow();
    } finally {
      calls = errorSpy.mock.calls.map((call) => [...call]);
      errorSpy.mockRestore();
    }

    const warningCalls = calls.filter((call) => String(call[0]).includes('[rebuild-index] warning'));
    expect(warningCalls.length).toBe(0);

    const db = new Database(dbPath, { readonly: true });
    const count = db.prepare('SELECT COUNT(*) as c FROM cards').get() as { c: number };
    expect(count.c).toBe(1);
    db.close();
  });
});
