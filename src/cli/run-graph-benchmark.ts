import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { initializeSchema } from '../db/schema.js';
import { reconcileIndex } from '../services/index-reconciler.js';
import { computeGraph } from '../services/graph-service.js';
import { generateDummyCards } from './generate-dummy-cards.js';

interface BenchmarkResult {
  count: number;
  reconcileTimeMs: number;
  queryTimeMs: number;
  nodeCount: number;
  sharedStackTimeMs: number;
  sharedStackEdgeCount: number;
}

export async function runBenchmark(): Promise<BenchmarkResult[]> {
  const sizes = [100, 500, 1000, 5000];
  const results: BenchmarkResult[] = [];

  console.error('[benchmark] Starting knowledge graph and database benchmark...');
  console.error('| Vault Size | Reconcile Time (ms) | Graph Query Time (ms) | Nodes Returned | Shared Stack Time (ms) | Shared Stack Edges |');
  console.error('|------------|---------------------|------------------------|-----------------|------------------------|--------------------|');

  for (const count of sizes) {
    // 1. Create temp directory
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `cardloom-mcp-bench-${count}-`));

    try {
      // 2. Generate dummy cards
      generateDummyCards(count, tempDir);

      // 3. Initialize clean in-memory database
      const db = new Database(':memory:');
      initializeSchema(db);

      // 4. Measure Reconcile (cold start index build)
      const startReconcile = Date.now();
      await reconcileIndex(db, tempDir);
      const reconcileTimeMs = Date.now() - startReconcile;

      // 5. Measure the REAL /api/graph code path (computeGraph — same function the Express route calls).
      // No focus_id is passed: computeGraph decides Full Graph Mode vs Target-Centered Mode itself,
      // exactly like production does, based on totalCount > 500.
      const startQuery = Date.now();
      const graphResult = computeGraph(db, { depth: 2, maxNodes: 100 });
      const queryTimeMs = Date.now() - startQuery;
      const nodeCount = graphResult.nodes.length;

      // 6. Measure the same real code path with the shared_stack Derived Link enabled (Story 6.2)
      const startSharedStack = Date.now();
      const graphResultWithSharedStack = computeGraph(db, { depth: 2, maxNodes: 100, includeSharedStack: true });
      const sharedStackTimeMs = Date.now() - startSharedStack;
      const sharedStackEdgeCount = graphResultWithSharedStack.edges.filter((e) => e.label === 'shared_stack').length;

      results.push({
        count,
        reconcileTimeMs,
        queryTimeMs,
        nodeCount,
        sharedStackTimeMs,
        sharedStackEdgeCount,
      });

      console.error(`| ${count.toString().padEnd(10)} | ${reconcileTimeMs.toString().padEnd(19)} | ${queryTimeMs.toString().padEnd(22)} | ${nodeCount.toString().padEnd(14)} | ${sharedStackTimeMs.toString().padEnd(20)} | ${sharedStackEdgeCount.toString().padEnd(18)} |`);

      db.close();
    } finally {
      // Clean up temp dir
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  return results;
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runBenchmark().catch((err) => {
    console.error('[benchmark] failed:', err);
    process.exit(1);
  });
}
