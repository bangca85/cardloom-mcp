import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GAPS_USAGE, formatGapsReport, parseGapsArgs, runGaps } from '../../src/cli/gaps.js';
import type { TelemetryEntry } from '../../src/services/telemetry-service.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cardloom-gaps-'));
  file = path.join(dir, 'telemetry.jsonl');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const e = (at: string, outcome: TelemetryEntry['outcome'], query?: string): string =>
  JSON.stringify({
    v: 1,
    at,
    tool: 'search_knowledge',
    result_count: outcome === 'empty' ? 0 : 1,
    outcome,
    latency_ms: 2,
    ...(query !== undefined && { query }),
  });

describe('parseGapsArgs', () => {
  it('accepts no arguments, --json and help', () => {
    expect(parseGapsArgs([])).toEqual({ json: false });
    expect(parseGapsArgs(['--json'])).toEqual({ json: true });
    expect(parseGapsArgs(['--help'])).toEqual({ json: false, help: true });
    expect(parseGapsArgs(['-h'])).toEqual({ json: false, help: true });
  });
  it('rejects anything else', () => {
    expect(parseGapsArgs(['--bogus'])).toBeNull();
    expect(parseGapsArgs(['x'])).toBeNull();
    expect(parseGapsArgs(['--json', '--days', '3'])).toBeNull();
  });
  it('has a usage that names the command', () => {
    expect(GAPS_USAGE).toContain('Usage: gaps');
  });
});

describe('runGaps', () => {
  it('says there is no telemetry yet when the file is missing, and creates nothing', () => {
    expect(runGaps(file, { json: false })).toBe('No telemetry yet. Set CARDLOOM_TELEMETRY=local to start recording.');
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('prints an empty report as JSON when the file is missing and --json is given', () => {
    expect(JSON.parse(runGaps(file, { json: true }))).toEqual({
      total: 0,
      answered: 0,
      relatedOnly: 0,
      empty: 0,
      since: null,
      topQueries: [],
      samplesEnabled: false,
    });
  });

  it('prints the counts and the first timestamp, and says samples are off when no entry has a query', () => {
    fs.writeFileSync(
      file,
      [e('2026-11-02T00:00:00.000Z', 'answered'), e('2026-11-01T00:00:00.000Z', 'empty'), e('2026-11-03T00:00:00.000Z', 'related_only'), e('2026-11-03T00:00:00.000Z', 'answered'), ''].join('\n'),
    );
    const out = runGaps(file, { json: false });
    expect(out).toContain('4 searches since 2026-11-01T00:00:00.000Z');
    expect(out).toContain('answered: 2');
    expect(out).toContain('related only: 1');
    expect(out).toContain('empty: 1');
    expect(out).not.toContain('Questions with no direct answer');
    expect(out).toContain('CARDLOOM_TELEMETRY_SAMPLES=1');
  });

  it('lists the unanswered questions when entries carry a query', () => {
    fs.writeFileSync(
      file,
      [e('2026-11-01T00:00:00.000Z', 'empty', 'How to rotate keys'), e('2026-11-02T00:00:00.000Z', 'related_only', 'how to  rotate keys'), e('2026-11-02T00:00:00.000Z', 'empty', 'other'), ''].join('\n'),
    );
    const out = runGaps(file, { json: false });
    expect(out).toContain('Questions with no direct answer');
    expect(out).toContain('how to rotate keys (2)');
    expect(out).toContain('other (1)');
    expect(out).not.toContain('CARDLOOM_TELEMETRY_SAMPLES=1');
  });

  it('prints the report object with --json', () => {
    fs.writeFileSync(file, `${e('2026-11-01T00:00:00.000Z', 'empty', 'x')}\n`);
    const r = JSON.parse(runGaps(file, { json: true })) as { total: number; topQueries: unknown[] };
    expect(r.total).toBe(1);
    expect(r.topQueries).toEqual([{ query: 'x', count: 1 }]);
  });

  it('formats a single search in the singular', () => {
    expect(
      formatGapsReport({ total: 1, answered: 1, relatedOnly: 0, empty: 0, since: '2026-11-01T00:00:00.000Z', topQueries: [], samplesEnabled: false }),
    ).toContain('1 search since');
  });
});
