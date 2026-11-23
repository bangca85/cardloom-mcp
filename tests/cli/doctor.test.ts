import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { runDoctor, formatDoctorReport } from '../../src/cli/doctor.js';
import { EMPTY_STORE_HINT } from '../../src/config/messages.js';

const DRAFT_CARD = `---
type: pattern
scope: project
applies_to: [api]
stack: [node]
version_range: ">=1.0.0"
sensitivity: normal
source_commit: abc123
provenance: agent-observation
title: Doctor draft card
status: draft
---
Body of the doctor draft card.
`;

const VERIFIED_CARD = `---
type: pattern
scope: project
applies_to: [api]
stack: [node]
version_range: ">=1.0.0"
status: verified
sensitivity: normal
source_commit: abc123
provenance: agent-observation
title: Doctor verified card
verified_by: reviewer
verification_method: manual-review
last_verified: "2026-01-01T00:00:00Z"
---
Body of the doctor verified card.
`;

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cardloom-mcp-doctor-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeCard(store: string, name: string, content: string): void {
  fs.mkdirSync(path.join(store, 'cards'), { recursive: true });
  fs.writeFileSync(path.join(store, 'cards', name), content);
}

describe('runDoctor', () => {
  it('reports a missing store with zero counts and creates nothing', async () => {
    const store = path.join(tmp, 'missing-store');
    const report = await runDoctor(store, path.join(tmp, 'index.db'));
    expect(report.storeExists).toBe(false);
    expect(report.isGitRepo).toBe(false);
    expect(report.cards).toEqual({ draft: 0, verified: 0, deprecated: 0 });
    expect(report.benchmarkQueries).toBeNull();
    expect(fs.existsSync(store)).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'index.db'))).toBe(false);
  });

  it('reports an empty existing directory as existing with zero counts', async () => {
    const report = await runDoctor(tmp, path.join(tmp, 'index.db'));
    expect(report.storeExists).toBe(true);
    expect(report.isGitRepo).toBe(false);
    expect(report.cards).toEqual({ draft: 0, verified: 0, deprecated: 0 });
  });

  it('counts a draft card and detects a git repo', async () => {
    writeCard(tmp, 'pattern-doctor-draft.md', DRAFT_CARD);
    execFileSync('git', ['init', '-q'], { cwd: tmp });
    const report = await runDoctor(tmp, path.join(tmp, 'index.db'));
    expect(report.storeExists).toBe(true);
    expect(report.isGitRepo).toBe(true);
    expect(report.cards).toEqual({ draft: 1, verified: 0, deprecated: 0 });
    expect(fs.existsSync(path.join(tmp, 'index.db'))).toBe(false);
  });

  it('counts benchmark queries when queries.yaml is valid', async () => {
    fs.mkdirSync(path.join(tmp, 'benchmark'));
    fs.writeFileSync(
      path.join(tmp, 'benchmark', 'queries.yaml'),
      '- query: first\n  expected: a\n- query: second\n  expected: b\n',
    );
    const report = await runDoctor(tmp, path.join(tmp, 'index.db'));
    expect(report.benchmarkQueries).toBe(2);
  });

  it('reports null and flags an invalid queries.yaml without crashing', async () => {
    fs.mkdirSync(path.join(tmp, 'benchmark'));
    fs.writeFileSync(path.join(tmp, 'benchmark', 'queries.yaml'), 'not: a list\n');
    const report = await runDoctor(tmp, path.join(tmp, 'index.db'));
    expect(report.benchmarkQueries).toBeNull();
    expect(formatDoctorReport(report)).toContain('benchmark/queries.yaml is invalid');
  });
});

describe('formatDoctorReport', () => {
  it('says a missing store is created on first server start', async () => {
    const text = formatDoctorReport(await runDoctor(path.join(tmp, 'missing-store'), path.join(tmp, 'index.db')));
    expect(text.split('\n')[0]).toContain('(not found — created on first server start)');
  });

  it('ends with the empty-store hint when there are no verified cards', async () => {
    writeCard(tmp, 'pattern-doctor-draft.md', DRAFT_CARD);
    const text = formatDoctorReport(await runDoctor(tmp, path.join(tmp, 'index.db')));
    expect(text.trimEnd().split('\n').at(-1)).toBe(EMPTY_STORE_HINT);
  });

  it('omits the hint when a verified card exists', async () => {
    writeCard(tmp, 'pattern-doctor-verified.md', VERIFIED_CARD);
    const report = await runDoctor(tmp, path.join(tmp, 'index.db'));
    expect(report.cards.verified).toBe(1);
    expect(formatDoctorReport(report)).not.toContain(EMPTY_STORE_HINT);
  });

  it('prints the paths and counts', async () => {
    const report = await runDoctor(tmp, path.join(tmp, 'index.db'));
    const text = formatDoctorReport(report);
    expect(text).toContain(tmp);
    expect(text).toContain(path.join(tmp, 'index.db'));
    expect(text).toMatch(/draft:\s+0/);
  });
});
