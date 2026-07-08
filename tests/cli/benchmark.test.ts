import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateDummyCards } from '../../src/cli/generate-dummy-cards.js';
import { runBenchmark } from '../../src/cli/run-graph-benchmark.js';

describe('Benchmark CLI Scripts Smoke Test', () => {
  it('generateDummyCards generates files in a target directory', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cardloom-bench-smoke-test-'));
    try {
      generateDummyCards(5, tempDir);
      
      const cardsDir = path.join(tempDir, 'cards');
      expect(fs.existsSync(cardsDir)).toBe(true);
      
      const files = fs.readdirSync(cardsDir);
      expect(files).toHaveLength(5);
      
      const firstFileContent = fs.readFileSync(path.join(cardsDir, files[0]), 'utf-8');
      expect(firstFileContent).toContain('status: verified');
      expect(firstFileContent).toContain('sensitivity: normal');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('runBenchmark executes successfully for 100, 500, 1000, 5000 scale', async () => {
    // This intentionally exercises the public benchmark sizes, so allow a wider budget.
    const results = await runBenchmark();
    expect(results).toHaveLength(4);
    expect(results[0].count).toBe(100);
    expect(results[0].reconcileTimeMs).toBeGreaterThanOrEqual(0);
    expect(results[0].queryTimeMs).toBeGreaterThanOrEqual(0);
  }, 20000);
});
