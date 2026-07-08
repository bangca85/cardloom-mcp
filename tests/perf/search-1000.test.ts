import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { searchCards } from '../../src/services/search-service.js';

const STACKS = ['node', 'python', 'react', 'go', 'rust', 'java'];
const TYPES = ['pattern', 'decision', 'snippet', 'gotcha', 'playbook'] as const;
const WORDS = ['retry', 'backoff', 'timeout', 'auth', 'cache', 'deploy', 'migration', 'schema', 'lock', 'queue'];

function seedCards(db: Database.Database, count: number): void {
  const insert = db.prepare(`
    INSERT INTO cards (
      id, type, status, title, domain, stack, applies_to, task_type, error_signature,
      scope, version_range, sensitivity, supersedes, conflicts_with, source_commit, provenance,
      verified_by, verification_method, last_verified, deprecation_reason, deprecated_at, deprecated_by,
      body, created_at, updated_at, file_mtime
    ) VALUES (
      @id, @type, 'verified', @title, NULL, @stack, '["api"]', NULL, @error_signature,
      'project', '>=1.0.0', 'normal', NULL, '[]', 'abc123', 'agent-observation',
      'bradley', 'manual-review', '2026-01-01T00:00:00Z', NULL, NULL, NULL,
      @body, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
    )
  `);

  const insertMany = db.transaction((n: number) => {
    for (let i = 0; i < n; i++) {
      const type = TYPES[i % TYPES.length]!;
      const stack = STACKS[i % STACKS.length]!;
      const wordA = WORDS[i % WORDS.length]!;
      const wordB = WORDS[(i + 3) % WORDS.length]!;

      insert.run({
        id: `${type}-card-${i}`,
        type,
        title: `Card number ${i} about ${wordA} and ${wordB}`,
        stack: JSON.stringify([stack]),
        error_signature: type === 'gotcha' ? `SyntheticError${i}: step ${i} failed unexpectedly` : null,
        body: `Body for card ${i}. Discusses ${wordA} and ${wordB} in depth with examples and detail padding to simulate a real card of reasonable length. `.repeat(3),
      });
    }
  });

  insertMany(count);
}

function percentile(sortedDurations: number[], p: number): number {
  const index = Math.min(sortedDurations.length - 1, Math.ceil((p / 100) * sortedDurations.length) - 1);
  return sortedDurations[Math.max(0, index)]!;
}

const SKIP_PERF = process.env['SKIP_PERF_TESTS'] === 'true';

describe.skipIf(SKIP_PERF)('searchCards performance (NFR1: p95 < 500ms @ 1000 cards)', () => {
  it('stays under the 500ms budget across a diverse query mix', () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    seedCards(db, 1000);

    const queries: Array<{ query: string; context?: { stack?: string[]; versions?: Record<string, string> } }> = [];

    for (const word of WORDS) {
      queries.push({ query: word });
      queries.push({ query: word, context: { stack: ['node'], versions: { node: '^20.0.0' } } });
    }
    queries.push({ query: 'SyntheticError7: step 7 failed unexpectedly' });
    queries.push({ query: 'SyntheticError42: step 42 failed unexpectedly' });

    const durations: number[] = [];
    for (const q of queries) {
      const start = performance.now();
      searchCards(db, q.query, { context: q.context });
      durations.push(performance.now() - start);
    }

    db.close();

    durations.sort((a, b) => a - b);
    const p50 = percentile(durations, 50);
    const p95 = percentile(durations, 95);
    const max = durations[durations.length - 1]!;

    console.error(
      `[perf] searchCards @ 1000 cards, ${queries.length} queries — p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms max=${max.toFixed(2)}ms`,
    );

    expect(p95).toBeLessThan(500);
  });
});
