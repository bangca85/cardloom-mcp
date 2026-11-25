import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeSchema } from '../../src/db/schema.js';
import { handleSearchKnowledge } from '../../src/tools/search-knowledge.js';
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

const SAVED = ['CARDLOOM_TELEMETRY', 'CARDLOOM_TELEMETRY_SAMPLES', 'INDEX_DB_PATH'] as const;

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
    resetTelemetryState();
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
});
