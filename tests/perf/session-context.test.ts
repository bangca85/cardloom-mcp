import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { generateDummyCards } from '../../src/cli/generate-dummy-cards.js';
import { runContext } from '../../src/cli/context.js';
import { initializeSchema } from '../../src/db/schema.js';
import { buildSessionContext } from '../../src/services/session-context-service.js';
import { reconcileIndex } from '../../src/services/index-reconciler.js';

const SKIP_PERF = process.env['SKIP_PERF_TESTS'] === 'true';
const RUNS = 20;
// Generous on purpose (shared CI machines); the target is 300 ms and the measured values are logged.
const BUDGET_MS = 1500;
const PROJECTS = ['bench/mine', 'bench/other-a', 'bench/other-b', 'bench/other-c', 'bench/other-d'];

/** A WAL index leaves `-wal`/`-shm` behind; which path `openIndexReadOnly` takes depends on whether they exist. */
function removeWalFiles(indexPath: string): void {
  fs.rmSync(`${indexPath}-wal`, { force: true });
  fs.rmSync(`${indexPath}-shm`, { force: true });
}

function p95(durations: number[]): number {
  const sorted = [...durations].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)]!;
}

describe.skipIf(SKIP_PERF)('buildSessionContext performance (p95 of 20 runs on an existing index)', () => {
  it.each([300, 1000, 5000])(
    'stays under %i-card budget',
    async (count) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `cardloom-ctx-perf-${count}-`));
      try {
        const store = path.join(root, 'store');
        generateDummyCards(count, store, { projects: PROJECTS });
        const indexPath = path.join(root, 'index.db');
        const build = new Database(indexPath);
        build.pragma('journal_mode = WAL'); // as the server leaves it
        initializeSchema(build);
        await reconcileIndex(build, store);
        build.close();

        // Path 1, in place: this read-only open creates the -wal/-shm files, so it measures the query on the file.
        removeWalFiles(indexPath);
        const db = new Database(indexPath, { readonly: true, fileMustExist: true });
        const opts = { project: 'bench/mine', stack: ['typescript'], maxCards: 5, maxEstimatedTokens: 800 };
        buildSessionContext(db, opts); // warm the statement cache
        const durations: number[] = [];
        let last = buildSessionContext(db, opts);
        for (let i = 0; i < RUNS; i++) {
          const start = performance.now();
          last = buildSessionContext(db, opts);
          durations.push(performance.now() - start);
        }
        db.close();
        expect(last.cards.length).toBeGreaterThan(0);

        // Path 2, in memory: with no -wal/-shm next to a WAL index, runContext reads the file into memory instead.
        removeWalFiles(indexPath);
        const work = path.join(root, 'work');
        fs.mkdirSync(work);
        fs.writeFileSync(path.join(work, '.knowledge-map.yaml'), 'project: bench/mine\nstack:\n  - typescript@5\n');
        const whole: number[] = [];
        for (let i = 0; i < RUNS; i++) {
          const start = performance.now();
          await runContext({ INDEX_DB_PATH: indexPath }, work, { maxCards: 5, maxEstimatedTokens: 800 });
          whole.push(performance.now() - start);
        }

        // The in-memory path really ran: it created nothing next to the index.
        expect(fs.existsSync(`${indexPath}-wal`)).toBe(false);
        expect(fs.existsSync(`${indexPath}-shm`)).toBe(false);

        const service = p95(durations);
        const command = p95(whole);
        console.error(
          `[perf] session context @ ${count} cards — in place (buildSessionContext) p95=${service.toFixed(2)}ms; in memory (runContext: open + map + query) p95=${command.toFixed(2)}ms`,
        );
        expect(service).toBeLessThan(BUDGET_MS);
        expect(command).toBeLessThan(BUDGET_MS);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
