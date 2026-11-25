import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildGapsReport,
  classifyOutcome,
  pruneTelemetry,
  readTelemetry,
  recordSearch,
  resetTelemetryState,
  type TelemetryEntry,
} from '../../src/services/telemetry-service.js';

const DAY = 86_400_000;
const NOW = new Date('2026-11-25T12:00:00.000Z');

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cardloom-telemetry-'));
  file = path.join(dir, 'telemetry.jsonl');
  resetTelemetryState();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const lines = (): string[] => fs.readFileSync(file, 'utf8').split('\n').filter((l) => l !== '');
const entryAt = (at: Date, extra: Partial<TelemetryEntry> = {}): TelemetryEntry => ({
  v: 1,
  at: at.toISOString(),
  tool: 'search_knowledge',
  result_count: 1,
  outcome: 'answered',
  latency_ms: 3,
  ...extra,
});

describe('classifyOutcome', () => {
  it('is empty when nothing was found', () => {
    expect(classifyOutcome([])).toBe('empty');
  });
  it('is related_only when every result is related', () => {
    expect(classifyOutcome([{ match: 'related' }, { match: 'related' }])).toBe('related_only');
  });
  it('is answered when at least one result is a direct match', () => {
    expect(classifyOutcome([{ match: 'related' }, { match: 'exact' }])).toBe('answered');
    expect(classifyOutcome([{ match: 'all_terms' }])).toBe('answered');
  });
});

describe('recordSearch', () => {
  it('creates nothing when the mode is off', () => {
    recordSearch({ resultCount: 0, outcome: 'empty', latencyMs: 1, query: 'x' }, { path: file, mode: 'off', samples: true, now: NOW });
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('appends one line per call with exactly the documented keys and no query when samples are off', () => {
    recordSearch({ resultCount: 3, outcome: 'answered', latencyMs: 12, query: 'secret-ish customer text' }, { path: file, mode: 'local', samples: false, now: NOW });
    recordSearch({ resultCount: 0, outcome: 'empty', latencyMs: 4, query: 'another' }, { path: file, mode: 'local', samples: false, now: NOW });
    const rows = lines().map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(rows).toHaveLength(2);
    expect(Object.keys(rows[0]!)).toEqual(['v', 'at', 'tool', 'result_count', 'outcome', 'latency_ms']);
    expect(rows[0]).toEqual({
      v: 1,
      at: '2026-11-25T12:00:00.000Z',
      tool: 'search_knowledge',
      result_count: 3,
      outcome: 'answered',
      latency_ms: 12,
    });
    expect(rows[1]).toMatchObject({ outcome: 'empty', result_count: 0 });
    expect(fs.readFileSync(file, 'utf8').endsWith('\n')).toBe(true);
  });

  it('writes the query for an unanswered search when samples are on', () => {
    recordSearch({ resultCount: 2, outcome: 'related_only', latencyMs: 5, query: 'how to rotate keys' }, { path: file, mode: 'local', samples: true, now: NOW });
    recordSearch({ resultCount: 0, outcome: 'empty', latencyMs: 5, query: 'nothing here' }, { path: file, mode: 'local', samples: true, now: NOW });
    const rows = lines().map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(rows[0]!['query']).toBe('how to rotate keys');
    expect(rows[1]!['query']).toBe('nothing here');
  });

  it('never writes the query of an answered search, even with samples on', () => {
    recordSearch({ resultCount: 2, outcome: 'answered', latencyMs: 5, query: 'found it' }, { path: file, mode: 'local', samples: true, now: NOW });
    expect(JSON.parse(lines()[0]!)).not.toHaveProperty('query');
  });

  it('omits a query the secret scanner rejects and never writes its text', () => {
    const secret = `how to use AKIA${'A'.repeat(16)} here`;
    recordSearch({ resultCount: 0, outcome: 'empty', latencyMs: 5, query: secret }, { path: file, mode: 'local', samples: true, now: NOW });
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).not.toContain('AKIA');
    expect(raw).not.toContain('how to use');
    expect(JSON.parse(lines()[0]!)).not.toHaveProperty('query');
    expect(JSON.parse(lines()[0]!)).toMatchObject({ outcome: 'empty', result_count: 0 });
  });

  it('omits a query whose secret sits beyond the 200-character cut as well', () => {
    const q = `${'a '.repeat(150)}API_KEY=abcdefgh12345678`;
    recordSearch({ resultCount: 0, outcome: 'empty', latencyMs: 5, query: q }, { path: file, mode: 'local', samples: true, now: NOW });
    expect(fs.readFileSync(file, 'utf8')).not.toContain('API_KEY');
    expect(JSON.parse(lines()[0]!)).not.toHaveProperty('query');
  });

  it('truncates a 250-character query to 200', () => {
    recordSearch({ resultCount: 0, outcome: 'empty', latencyMs: 5, query: 'q'.repeat(250) }, { path: file, mode: 'local', samples: true, now: NOW });
    expect((JSON.parse(lines()[0]!) as { query: string }).query).toBe('q'.repeat(200));
  });

  it('omits a blank query', () => {
    recordSearch({ resultCount: 0, outcome: 'empty', latencyMs: 5, query: '   ' }, { path: file, mode: 'local', samples: true, now: NOW });
    expect(JSON.parse(lines()[0]!)).not.toHaveProperty('query');
  });

  it('records the card-free, result-free fields only', () => {
    recordSearch({ resultCount: 1, outcome: 'answered', latencyMs: 5 }, { path: file, mode: 'local', now: NOW });
    expect(Object.keys(JSON.parse(lines()[0]!) as object).sort()).toEqual(['at', 'latency_ms', 'outcome', 'result_count', 'tool', 'v']);
  });

  it('does not throw when the path cannot be written (a directory used as the file)', () => {
    const asDir = path.join(dir, 'is-a-dir');
    fs.mkdirSync(asDir);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => recordSearch({ resultCount: 0, outcome: 'empty', latencyMs: 1 }, { path: asDir, mode: 'local', now: NOW })).not.toThrow();
    expect(() => recordSearch({ resultCount: 0, outcome: 'empty', latencyMs: 1 }, { path: asDir, mode: 'local', now: NOW })).not.toThrow();
    // At most one stderr line per process, never per search; never stdout.
    const telemetryLines = err.mock.calls.filter((c) => String(c[0]).startsWith('[telemetry]'));
    expect(telemetryLines).toHaveLength(1);
  });

  it('does not throw when the parent directory is a file', () => {
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => recordSearch({ resultCount: 0, outcome: 'empty', latencyMs: 1 }, { path: path.join(blocker, 'telemetry.jsonl'), mode: 'local', now: NOW })).not.toThrow();
  });

  it('creates the missing parent directory', () => {
    const nested = path.join(dir, 'a', 'b', 'telemetry.jsonl');
    recordSearch({ resultCount: 1, outcome: 'answered', latencyMs: 1 }, { path: nested, mode: 'local', now: NOW });
    expect(fs.existsSync(nested)).toBe(true);
  });

  it('prunes at most once per UTC day and again after the date changes', () => {
    const old = entryAt(new Date(NOW.getTime() - 100 * DAY));
    // First append after start counts: the old line goes.
    fs.writeFileSync(file, `${JSON.stringify(old)}\n`);
    recordSearch({ resultCount: 1, outcome: 'answered', latencyMs: 1 }, { path: file, mode: 'local', now: NOW });
    expect(readTelemetry(file)).toHaveLength(1);

    // Same UTC day: an old line planted now survives the next append (no second prune).
    fs.appendFileSync(file, `${JSON.stringify(old)}\n`);
    recordSearch({ resultCount: 1, outcome: 'answered', latencyMs: 1 }, { path: file, mode: 'local', now: new Date(NOW.getTime() + 3_600_000) });
    expect(readTelemetry(file)).toHaveLength(3);

    // The next UTC day prunes again.
    recordSearch({ resultCount: 1, outcome: 'answered', latencyMs: 1 }, { path: file, mode: 'local', now: new Date(NOW.getTime() + DAY) });
    const kept = readTelemetry(file);
    expect(kept).toHaveLength(3);
    expect(kept.every((e) => e.at >= new Date(NOW.getTime() - 90 * DAY).toISOString())).toBe(true);
    expect(fs.readdirSync(dir)).toEqual(['telemetry.jsonl']);
  });
});

describe('pruneTelemetry', () => {
  it('keeps the recent entry, drops the old one and malformed lines, and leaves no temp file', () => {
    const recent = entryAt(new Date(NOW.getTime() - 10 * DAY));
    const old = entryAt(new Date(NOW.getTime() - 100 * DAY));
    fs.writeFileSync(file, [JSON.stringify(old), 'not json', JSON.stringify(recent), '{"v":1}', ''].join('\n'));
    pruneTelemetry(file, NOW);
    expect(lines()).toEqual([JSON.stringify(recent)]);
    expect(fs.readFileSync(file, 'utf8').endsWith('\n')).toBe(true);
    expect(fs.readdirSync(dir)).toEqual(['telemetry.jsonl']);
  });

  it('honours a custom retention', () => {
    const e = entryAt(new Date(NOW.getTime() - 10 * DAY));
    fs.writeFileSync(file, `${JSON.stringify(e)}\n`);
    pruneTelemetry(file, NOW, 5);
    expect(fs.readFileSync(file, 'utf8')).toBe('');
  });

  it('is a no-op when the file is missing', () => {
    expect(() => pruneTelemetry(file, NOW)).not.toThrow();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('does not throw on an unreadable path and leaves no temp file', () => {
    const asDir = path.join(dir, 'd');
    fs.mkdirSync(asDir);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => pruneTelemetry(asDir, NOW)).not.toThrow();
    expect(fs.readdirSync(dir)).toEqual(['d']);
  });
});

describe('readTelemetry', () => {
  it('skips malformed lines and entries of the wrong shape, and returns [] for a missing file', () => {
    expect(readTelemetry(file)).toEqual([]);
    const good = entryAt(NOW);
    fs.writeFileSync(file, [JSON.stringify(good), '{bad', JSON.stringify({ ...good, outcome: 'weird' }), JSON.stringify({ ...good, v: 2 }), ''].join('\n'));
    expect(readTelemetry(file)).toEqual([good]);
  });
});

describe('buildGapsReport', () => {
  it('counts outcomes and finds the first timestamp', () => {
    const r = buildGapsReport([
      entryAt(new Date('2026-11-02T00:00:00Z')),
      entryAt(new Date('2026-11-01T00:00:00Z'), { outcome: 'empty', result_count: 0 }),
      entryAt(new Date('2026-11-03T00:00:00Z'), { outcome: 'related_only' }),
    ]);
    expect(r).toEqual({
      total: 3,
      answered: 1,
      relatedOnly: 1,
      empty: 1,
      since: '2026-11-01T00:00:00.000Z',
      topQueries: [],
      samplesEnabled: false,
    });
  });

  it('is zeroed with since null for no entries', () => {
    expect(buildGapsReport([])).toMatchObject({ total: 0, since: null, topQueries: [], samplesEnabled: false });
  });

  it('groups unanswered queries after normalising them, ignoring answered ones', () => {
    const e = (query: string, outcome: TelemetryEntry['outcome'] = 'empty'): TelemetryEntry => entryAt(NOW, { query, outcome });
    const r = buildGapsReport([
      e('How  to Rotate   keys'),
      e('  how to rotate keys  ', 'related_only'),
      e('HOW TO ROTATE KEYS'),
      e('should not count', 'answered'),
      e('other'),
    ]);
    expect(r.samplesEnabled).toBe(true);
    expect(r.topQueries).toEqual([
      { query: 'how to rotate keys', count: 3 },
      { query: 'other', count: 1 },
    ]);
  });

  it('keeps the top 10 by count, ties by text', () => {
    const entries: TelemetryEntry[] = [];
    for (const q of ['k', 'j', 'i', 'h', 'g', 'f', 'e', 'd', 'c', 'b', 'a']) entries.push(entryAt(NOW, { query: q, outcome: 'empty' }));
    entries.push(entryAt(NOW, { query: 'z', outcome: 'empty' }), entryAt(NOW, { query: 'z', outcome: 'empty' }));
    const r = buildGapsReport(entries);
    expect(r.topQueries).toHaveLength(10);
    expect(r.topQueries[0]).toEqual({ query: 'z', count: 2 });
    expect(r.topQueries.slice(1).map((t) => t.query)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
  });
});
