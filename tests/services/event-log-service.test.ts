import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { getDatabase, closeDatabase } from '../../src/db/database.js';
import { initKnowledgeStore } from '../../src/services/knowledge-store.js';
import { resetGit } from '../../src/services/git-service.js';
import { initializeSchema } from '../../src/db/schema.js';
import {
  appendUsageEvent,
  foldAllEvents,
  foldEvent,
  resolveMachineId,
  type UsageEvent,
} from '../../src/services/event-log-service.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cardloom-mcp-event-log-'));
}

function readCounters(db: Database.Database, cardId: string): { usage: number; success: number; failure: number } | undefined {
  return db.prepare('SELECT usage, success, failure FROM counters WHERE card_id = ?').get(cardId) as
    | { usage: number; success: number; failure: number }
    | undefined;
}

describe('resolveMachineId', () => {
  const originalEnv = process.env['KNOWLEDGE_MACHINE_ID'];

  afterEach(() => {
    if (originalEnv === undefined) delete process.env['KNOWLEDGE_MACHINE_ID'];
    else process.env['KNOWLEDGE_MACHINE_ID'] = originalEnv;
  });

  it('uses KNOWLEDGE_MACHINE_ID when set, sanitized to lowercase-kebab', () => {
    process.env['KNOWLEDGE_MACHINE_ID'] = 'My Laptop_2';
    expect(resolveMachineId()).toBe('my-laptop-2');
  });

  it('falls back to the sanitized hostname when unset', () => {
    delete process.env['KNOWLEDGE_MACHINE_ID'];
    const id = resolveMachineId();
    expect(id).toMatch(/^[a-z0-9-]+$/);
    expect(id.length).toBeGreaterThan(0);
  });
});

describe('foldEvent', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('confirmed increments usage and success', () => {
    foldEvent(db, { v: 1, card: 'pattern-a', outcome: 'confirmed', at: '2026-01-01T00:00:00Z' });
    expect(readCounters(db, 'pattern-a')).toEqual({ usage: 1, success: 1, failure: 0 });
  });

  it('refuted increments usage and failure', () => {
    foldEvent(db, { v: 1, card: 'pattern-b', outcome: 'refuted', at: '2026-01-01T00:00:00Z' });
    expect(readCounters(db, 'pattern-b')).toEqual({ usage: 1, success: 0, failure: 1 });
  });

  it('neutral increments only usage', () => {
    foldEvent(db, { v: 1, card: 'pattern-c', outcome: 'neutral', at: '2026-01-01T00:00:00Z' });
    expect(readCounters(db, 'pattern-c')).toEqual({ usage: 1, success: 0, failure: 0 });
  });

  it('accumulates across repeated events for the same card', () => {
    foldEvent(db, { v: 1, card: 'pattern-d', outcome: 'confirmed', at: '2026-01-01T00:00:00Z' });
    foldEvent(db, { v: 1, card: 'pattern-d', outcome: 'refuted', at: '2026-01-01T00:01:00Z' });
    foldEvent(db, { v: 1, card: 'pattern-d', outcome: 'confirmed', at: '2026-01-01T00:02:00Z' });
    expect(readCounters(db, 'pattern-d')).toEqual({ usage: 3, success: 2, failure: 1 });
  });
});

describe('appendUsageEvent', () => {
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

  it('appends a JSONL line matching UsageEvent shape and folds counters in the same operation (AC1, AC2)', async () => {
    delete process.env['KNOWLEDGE_MACHINE_ID'];
    process.env['KNOWLEDGE_MACHINE_ID'] = 'test-machine';

    const result = await appendUsageEvent(db, storePath, { card: 'pattern-x', outcome: 'confirmed' });

    expect(result.git_committed).toBe(true);

    const filePath = path.join(storePath, 'events', 'test-machine.jsonl');
    expect(fs.existsSync(filePath)).toBe(true);

    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]!) as UsageEvent;
    expect(event).toMatchObject({ v: 1, card: 'pattern-x', outcome: 'confirmed' });
    expect(typeof event.at).toBe('string');

    expect(readCounters(db, 'pattern-x')).toEqual({ usage: 1, success: 1, failure: 0 });

    delete process.env['KNOWLEDGE_MACHINE_ID'];
  });
});

describe('foldAllEvents', () => {
  let storePath: string;
  let db: Database.Database;

  beforeEach(() => {
    storePath = tmpDir();
    db = new Database(':memory:');
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(storePath, { recursive: true, force: true });
  });

  it('folds events from multiple machine files into combined totals (AC3)', () => {
    const eventsDir = path.join(storePath, 'events');
    fs.mkdirSync(eventsDir, { recursive: true });

    fs.writeFileSync(
      path.join(eventsDir, 'laptop-a.jsonl'),
      [
        JSON.stringify({ v: 1, card: 'pattern-shared', outcome: 'confirmed', at: '2026-01-01T00:00:00Z' }),
        JSON.stringify({ v: 1, card: 'pattern-shared', outcome: 'confirmed', at: '2026-01-01T00:01:00Z' }),
      ].join('\n') + '\n',
    );
    fs.writeFileSync(
      path.join(eventsDir, 'laptop-b.jsonl'),
      [JSON.stringify({ v: 1, card: 'pattern-shared', outcome: 'refuted', at: '2026-01-01T00:02:00Z' })].join('\n') + '\n',
    );

    foldAllEvents(db, storePath);

    expect(readCounters(db, 'pattern-shared')).toEqual({ usage: 3, success: 2, failure: 1 });
  });

  it('skips malformed lines and warns to stderr, but folds the valid ones (AC3)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const eventsDir = path.join(storePath, 'events');
    fs.mkdirSync(eventsDir, { recursive: true });

    fs.writeFileSync(
      path.join(eventsDir, 'laptop-a.jsonl'),
      [
        JSON.stringify({ v: 1, card: 'pattern-good', outcome: 'confirmed', at: '2026-01-01T00:00:00Z' }),
        'not valid json {{{',
        JSON.stringify({ v: 2, card: 'pattern-wrong-version', outcome: 'confirmed', at: '2026-01-01T00:00:00Z' }),
        JSON.stringify({ v: 1, card: 'pattern-good', outcome: 'confirmed', at: '2026-01-01T00:01:00Z' }),
      ].join('\n') + '\n',
    );

    expect(() => foldAllEvents(db, storePath)).not.toThrow();

    expect(readCounters(db, 'pattern-good')).toEqual({ usage: 2, success: 2, failure: 0 });
    expect(readCounters(db, 'pattern-wrong-version')).toBeUndefined();
    expect(errorSpy.mock.calls.some(([msg]) => String(msg).includes('[event-log] skip malformed line'))).toBe(true);

    errorSpy.mockRestore();
  });

  it('rebuilds from empty when the events dir does not exist yet', () => {
    expect(() => foldAllEvents(db, storePath)).not.toThrow();
    const count = db.prepare('SELECT COUNT(*) as c FROM counters').get() as { c: number };
    expect(count.c).toBe(0);
  });

  it('is idempotent — re-running against the same files does not double-count', () => {
    const eventsDir = path.join(storePath, 'events');
    fs.mkdirSync(eventsDir, { recursive: true });
    fs.writeFileSync(
      path.join(eventsDir, 'laptop-a.jsonl'),
      JSON.stringify({ v: 1, card: 'pattern-once', outcome: 'confirmed', at: '2026-01-01T00:00:00Z' }) + '\n',
    );

    foldAllEvents(db, storePath);
    foldAllEvents(db, storePath);

    expect(readCounters(db, 'pattern-once')).toEqual({ usage: 1, success: 1, failure: 0 });
  });
});

describe('usage_events (derived, filled by the one fold)', () => {
  let db: Database.Database;
  let storePath: string;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    storePath = tmpDir();
  });

  afterEach(() => {
    db.close();
    fs.rmSync(storePath, { recursive: true, force: true });
  });

  function rows(): Array<{ card_id: string; outcome: string; at: string; repo: string | null }> {
    return db
      .prepare('SELECT card_id, outcome, at, repo FROM usage_events ORDER BY at, card_id')
      .all() as Array<{ card_id: string; outcome: string; at: string; repo: string | null }>;
  }

  function writeEvents(events: UsageEvent[]): void {
    const eventsDir = path.join(storePath, 'events');
    fs.mkdirSync(eventsDir, { recursive: true });
    fs.writeFileSync(path.join(eventsDir, 'laptop.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }

  const EVENTS: UsageEvent[] = [
    { v: 1, card: 'pattern-a', outcome: 'confirmed', at: '2026-01-01T00:00:00Z', repo: 'org/app' },
    { v: 1, card: 'pattern-a', outcome: 'refuted', at: '2026-01-02T00:00:00Z' },
    { v: 1, card: 'pattern-b', outcome: 'neutral', at: '2026-01-03T00:00:00Z' },
  ];

  it('foldEvent of 3 events fills usage_events with card, outcome, at and repo', () => {
    for (const e of EVENTS) foldEvent(db, e);
    expect(rows()).toEqual([
      { card_id: 'pattern-a', outcome: 'confirmed', at: '2026-01-01T00:00:00Z', repo: 'org/app' },
      { card_id: 'pattern-a', outcome: 'refuted', at: '2026-01-02T00:00:00Z', repo: null },
      { card_id: 'pattern-b', outcome: 'neutral', at: '2026-01-03T00:00:00Z', repo: null },
    ]);
  });

  it('foldAllEvents twice leaves the same rows (no duplicates) and unchanged counters', () => {
    writeEvents(EVENTS);
    foldAllEvents(db, storePath);
    const first = rows();
    foldAllEvents(db, storePath);
    expect(rows()).toEqual(first);
    expect(first).toHaveLength(3);
    expect(readCounters(db, 'pattern-a')).toEqual({ usage: 2, success: 1, failure: 1 });
  });

  it('a full fold equals what live folding the same events produced (rebuild == live)', () => {
    for (const e of EVENTS) foldEvent(db, e);
    const live = rows();
    const liveCounters = readCounters(db, 'pattern-a');
    writeEvents(EVENTS);
    foldAllEvents(db, storePath);
    expect(rows()).toEqual(live);
    expect(readCounters(db, 'pattern-a')).toEqual(liveCounters);
  });

  it('a full fold with no events dir clears usage_events too', () => {
    foldEvent(db, EVENTS[0]!);
    foldAllEvents(db, storePath);
    expect(rows()).toEqual([]);
  });

  it('an event with an unparseable at does not crash the fold', () => {
    expect(() => foldEvent(db, { v: 1, card: 'pattern-a', outcome: 'confirmed', at: 'not-a-date' })).not.toThrow();
    expect(readCounters(db, 'pattern-a')).toEqual({ usage: 1, success: 1, failure: 0 });
  });

  it('initializeSchema adds the table (and index on at) to an old index that lacks it, keeping existing data', () => {
    initializeSchema(db);
    db.exec('DROP TABLE usage_events');
    // Old index: counters exist, usage_events does not.
    db.prepare("INSERT INTO counters (card_id, usage, success, failure) VALUES ('pattern-old', 1, 1, 0)").run();
    expect(() => initializeSchema(db)).not.toThrow();
    expect(() => initializeSchema(db)).not.toThrow();
    expect(rows()).toEqual([]);
    expect(readCounters(db, 'pattern-old')).toEqual({ usage: 1, success: 1, failure: 0 });
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'usage_events'").all();
    expect(idx.length).toBeGreaterThan(0);
  });
});
