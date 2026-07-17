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

  it('runBenchmark executes successfully for 100, 500, 1000, 5000 scale and meets NFR-1 (<1.5s) via the real computeGraph code path', async () => {
    // This intentionally exercises the public benchmark sizes, so allow a wider budget.
    const results = await runBenchmark();
    expect(results).toHaveLength(4);
    expect(results[0].count).toBe(100);

    for (const result of results) {
      expect(result.reconcileTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.queryTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.sharedStackTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.sharedStackEdgeCount).toBeGreaterThanOrEqual(0);
      // NFR-1: Graph View render time budget — both the plain graph query and the
      // shared_stack-enabled variant must stay under 1.5s at every benchmarked scale.
      expect(result.queryTimeMs).toBeLessThan(1500);
      expect(result.sharedStackTimeMs).toBeLessThan(1500);
    }
  }, 20000);
});
