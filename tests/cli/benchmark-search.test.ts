import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  buildFreshIndex,
  findMissingExpected,
  corpusFingerprint,
} from '../../src/cli/benchmark.js';

function card(type: string, title: string): string {
  return `---
type: ${type}
scope: project
applies_to: [api]
stack: [node]
version_range: ">=1.0.0"
sensitivity: normal
source_commit: abc123
provenance: agent-observation
title: ${title}
${type === 'gotcha' ? 'error_signature: "TypeError: boom"\n' : ''}status: verified
verified_by: tester
verification_method: manual-review
verified_at: "2026-01-01T00:00:00.000Z"
last_verified: "2026-01-01T00:00:00.000Z"
---
Body for ${title}.
`;
}

describe('benchmark against a fresh index', () => {
  let store: string;

  beforeEach(() => {
    store = fs.mkdtempSync(path.join(os.tmpdir(), 'cardloom-mcp-bench-'));
    const cardsDir = path.join(store, 'cards');
    fs.mkdirSync(cardsDir, { recursive: true });
    fs.writeFileSync(path.join(cardsDir, 'pattern-a.md'), card('pattern', 'Pattern A'));
    fs.writeFileSync(path.join(cardsDir, 'gotcha-b.md'), card('gotcha', 'Gotcha B'));
  });

  afterEach(() => {
    fs.rmSync(store, { recursive: true, force: true });
  });

  it('buildFreshIndex indexes every card file in the store', async () => {
    const db = await buildFreshIndex(store);
    expect(db.prepare('SELECT count(*) c FROM cards').get()).toEqual({ c: 2 });
    db.close();
  });

  it('findMissingExpected lists expected ids that are not in the index', async () => {
    const db = await buildFreshIndex(store);
    expect(
      findMissingExpected(db, [
        { query: 'x', expected: 'pattern-a' },
        { query: 'y', expected: 'gone-1' },
        { query: 'z', expected: 'gone-1' },
      ]),
    ).toEqual(['gone-1']);
    expect(findMissingExpected(db, [{ query: 'x', expected: 'pattern-a' }])).toEqual([]);
    db.close();
  });

  it('findMissingExpected returns ids sorted', async () => {
    const db = await buildFreshIndex(store);
    expect(
      findMissingExpected(db, [
        { query: 'x', expected: 'zeta' },
        { query: 'y', expected: 'alpha' },
      ]),
    ).toEqual(['alpha', 'zeta']);
    db.close();
  });

  it('corpusFingerprint counts cards and changes when a card status changes', async () => {
    const db = await buildFreshIndex(store);
    const before = corpusFingerprint(db);
    expect(before.cards).toBe(2);
    expect(before.verified).toBe(2);
    expect(before.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(corpusFingerprint(db).sha256).toBe(before.sha256);

    db.prepare("UPDATE cards SET status = 'deprecated' WHERE id = 'gotcha-b'").run();
    const after = corpusFingerprint(db);
    expect(after.verified).toBe(1);
    expect(after.sha256).not.toBe(before.sha256);
    db.close();
  });
});
