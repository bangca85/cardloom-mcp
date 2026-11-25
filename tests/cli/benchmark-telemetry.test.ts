import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFreshIndex, runBenchmark } from '../../src/cli/benchmark.js';
import { resetTelemetryState } from '../../src/services/telemetry-service.js';

const CARD = `---
type: pattern
scope: project
applies_to: [api]
stack: [node]
version_range: ">=1.0.0"
sensitivity: normal
source_commit: abc123
provenance: agent-observation
title: Pattern A
status: verified
verified_by: tester
verification_method: manual-review
verified_at: "2026-01-01T00:00:00.000Z"
last_verified: "2026-01-01T00:00:00.000Z"
---
Body for pattern a.
`;

describe('benchmark never records telemetry', () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const KEYS = ['CARDLOOM_TELEMETRY', 'CARDLOOM_TELEMETRY_SAMPLES', 'INDEX_DB_PATH'];

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cardloom-bench-telemetry-'));
    fs.mkdirSync(path.join(dir, 'store', 'cards'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'store', 'cards', 'pattern-a.md'), CARD);
    process.env['INDEX_DB_PATH'] = path.join(dir, 'meta', 'index.db');
    resetTelemetryState();
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes no telemetry file with CARDLOOM_TELEMETRY=local and samples on', async () => {
    process.env['CARDLOOM_TELEMETRY'] = 'local';
    process.env['CARDLOOM_TELEMETRY_SAMPLES'] = '1';
    const db = await buildFreshIndex(path.join(dir, 'store'));
    const report = runBenchmark(db, [
      { query: 'pattern', expected: 'pattern-a' },
      { query: 'qqqqnothing' },
    ]);
    db.close();
    expect(report.total).toBe(2);
    expect(fs.existsSync(path.join(dir, 'meta', 'telemetry.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'meta'))).toBe(false);
  });
});
