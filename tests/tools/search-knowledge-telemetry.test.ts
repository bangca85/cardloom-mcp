import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeSchema } from '../../src/db/schema.js';
import { handleSearchKnowledge } from '../../src/tools/search-knowledge.js';
import { resetConfigNotes } from '../../src/config/env.js';
import { resetTelemetryState } from '../../src/services/telemetry-service.js';
import * as telemetry from '../../src/services/telemetry-service.js';

// A pass-through spy: every test sees the real writer except the one that makes it throw.
vi.mock('../../src/services/telemetry-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/telemetry-service.js')>();
  return { ...actual, recordSearch: vi.fn(actual.recordSearch) };
});

function insertCard(db: Database.Database, id: string, body: string): void {
  db.prepare(
    `INSERT INTO cards (
      id, type, status, title, domain, stack, applies_to, task_type, error_signature,
      scope, version_range, sensitivity, supersedes, conflicts_with, source_commit, provenance,
      verified_by, verification_method, last_verified, deprecation_reason, deprecated_at, deprecated_by,
      body, created_at, updated_at, file_mtime, project
    ) VALUES (
      @id, 'pattern', 'verified', @title, NULL, '["node"]', '["api"]', NULL, NULL,
      'project', '>=1.0.0', 'normal', NULL, '[]', 'abc123', 'agent-observation',
      'bradley', 'manual-review', '2026-01-01T00:00:00Z', NULL, NULL, NULL,
      @body, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL
    )`,
  ).run({ id, title: `Title ${id}`, body });
}

const SAVED = ['CARDLOOM_TELEMETRY', 'CARDLOOM_TELEMETRY_SAMPLES', 'CARDLOOM_TELEMETRY_PATH', 'INDEX_DB_PATH', 'KNOWLEDGE_STORE_PATH'] as const;

describe('search_knowledge telemetry', () => {
  let db: Database.Database;
  let dir: string;
  let file: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of SAVED) saved[k] = process.env[k];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cardloom-search-telemetry-'));
    process.env['INDEX_DB_PATH'] = path.join(dir, 'index.db');
    file = path.join(dir, 'telemetry.jsonl');
    delete process.env['CARDLOOM_TELEMETRY'];
    delete process.env['CARDLOOM_TELEMETRY_SAMPLES'];
    delete process.env['CARDLOOM_TELEMETRY_PATH'];
    process.env['KNOWLEDGE_STORE_PATH'] = path.join(dir, 'store');
    resetTelemetryState();
    resetConfigNotes();
    db = new Database(':memory:');
    initializeSchema(db);
    insertCard(db, 'pattern-alpha', 'alpha beta gamma');
  });
  afterEach(() => {
    db.close();
    for (const k of SAVED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.mocked(telemetry.recordSearch).mockClear();
  });

  const rows = (): Array<Record<string, unknown>> =>
    fs.readFileSync(file, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Record<string, unknown>);

  it('records exactly one entry per call with the right outcome and result_count', () => {
    process.env['CARDLOOM_TELEMETRY'] = 'local';
    handleSearchKnowledge(db, { query: 'alpha beta' });
    handleSearchKnowledge(db, { query: 'alpha zzzmissing' });
    handleSearchKnowledge(db, { query: 'qqqqnothing' });
    const r = rows();
    expect(r).toHaveLength(3);
    expect(r[0]).toMatchObject({ outcome: 'answered', result_count: 1, tool: 'search_knowledge', v: 1 });
    expect(r[1]).toMatchObject({ outcome: 'related_only', result_count: 1 });
    expect(r[2]).toMatchObject({ outcome: 'empty', result_count: 0 });
    for (const row of r) {
      expect(typeof row['latency_ms']).toBe('number');
      expect(row).not.toHaveProperty('query');
      expect(JSON.stringify(row)).not.toContain('pattern-alpha');
    }
  });

  it('records the query of an unanswered search only when samples are on', () => {
    process.env['CARDLOOM_TELEMETRY'] = 'local';
    process.env['CARDLOOM_TELEMETRY_SAMPLES'] = '1';
    handleSearchKnowledge(db, { query: 'qqqqnothing' });
    handleSearchKnowledge(db, { query: 'alpha beta' });
    const r = rows();
    expect(r[0]!['query']).toBe('qqqqnothing');
    expect(r[1]).not.toHaveProperty('query');
  });

  it('writes nothing when telemetry is off', () => {
    handleSearchKnowledge(db, { query: 'alpha beta' });
    process.env['CARDLOOM_TELEMETRY'] = 'on';
    handleSearchKnowledge(db, { query: 'alpha beta' });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('writes nothing when the caller passes telemetry: false, even with the switch on', () => {
    process.env['CARDLOOM_TELEMETRY'] = 'local';
    handleSearchKnowledge(db, { query: 'alpha beta' }, { telemetry: false });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('returns a byte-identical response when the writer throws', () => {
    const off = handleSearchKnowledge(db, { query: 'alpha beta' });
    process.env['CARDLOOM_TELEMETRY'] = 'local';
    vi.mocked(telemetry.recordSearch).mockClear();
    vi.mocked(telemetry.recordSearch).mockImplementationOnce(() => {
      throw new Error('disk on fire');
    });
    const failing = handleSearchKnowledge(db, { query: 'alpha beta' });
    expect(telemetry.recordSearch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(failing)).toBe(JSON.stringify(off));
    expect(failing).toEqual(off);
  });

  describe('the knowledge store is off limits', () => {
    const notes = (spy: ReturnType<typeof vi.spyOn>): string[] =>
      spy.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.startsWith('[telemetry]'));

    it('with INDEX_DB_PATH unset the default lands inside the store: nothing created, one note, same response', () => {
      const off = handleSearchKnowledge(db, { query: 'alpha beta' });
      delete process.env['INDEX_DB_PATH'];
      process.env['CARDLOOM_TELEMETRY'] = 'local';
      process.env['CARDLOOM_TELEMETRY_SAMPLES'] = '1';
      const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      let last: unknown;
      for (let i = 0; i < 4; i++) last = handleSearchKnowledge(db, { query: 'alpha beta' });
      handleSearchKnowledge(db, { query: 'qqqqnothing' });
      expect(fs.readdirSync(dir)).toEqual([]);
      expect(notes(err)).toHaveLength(1);
      expect(notes(err)[0]).toContain('is inside the knowledge store; not recording. Set INDEX_DB_PATH or CARDLOOM_TELEMETRY_PATH outside it.');
      expect(JSON.stringify(last)).toBe(JSON.stringify(off));
    });

    it('with INDEX_DB_PATH pointing under the store it refuses too', () => {
      process.env['INDEX_DB_PATH'] = path.join(dir, 'store', '.metadata', 'index.db');
      process.env['CARDLOOM_TELEMETRY'] = 'local';
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      handleSearchKnowledge(db, { query: 'alpha beta' });
      expect(fs.readdirSync(dir)).toEqual([]);
    });

    it('records when INDEX_DB_PATH is outside the store', () => {
      process.env['CARDLOOM_TELEMETRY'] = 'local';
      handleSearchKnowledge(db, { query: 'alpha beta' });
      expect(rows()).toHaveLength(1);
    });

    it('CARDLOOM_TELEMETRY_PATH (absolute, outside) is used instead of the index folder', () => {
      const elsewhere = path.join(dir, 'elsewhere', 'gaps.jsonl');
      process.env['CARDLOOM_TELEMETRY_PATH'] = elsewhere;
      process.env['CARDLOOM_TELEMETRY'] = 'local';
      delete process.env['INDEX_DB_PATH']; // the default would be inside the store; the override rescues it
      handleSearchKnowledge(db, { query: 'alpha beta' });
      expect(fs.readFileSync(elsewhere, 'utf8').trim().split('\n')).toHaveLength(1);
      expect(fs.existsSync(path.join(dir, 'store'))).toBe(false);
    });

    it('a relative CARDLOOM_TELEMETRY_PATH is ignored with one note, and the default beside the index is used', () => {
      process.env['CARDLOOM_TELEMETRY_PATH'] = 'relative/gaps.jsonl';
      process.env['CARDLOOM_TELEMETRY'] = 'local';
      const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      handleSearchKnowledge(db, { query: 'alpha beta' });
      handleSearchKnowledge(db, { query: 'alpha beta' });
      expect(notes(err)).toEqual(['[telemetry] CARDLOOM_TELEMETRY_PATH must be an absolute path; ignoring it.']);
      expect(rows()).toHaveLength(2);
      expect(fs.existsSync(path.resolve('relative'))).toBe(false);
    });

    it('an override inside the store is refused', () => {
      process.env['CARDLOOM_TELEMETRY_PATH'] = path.join(dir, 'store', 'telemetry.jsonl');
      process.env['CARDLOOM_TELEMETRY'] = 'local';
      const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      handleSearchKnowledge(db, { query: 'alpha beta' });
      expect(fs.readdirSync(dir)).toEqual([]);
      expect(notes(err)).toHaveLength(1);
    });
  });
});
