import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { initializeSchema } from '../db/schema.js';
import { reconcileIndex } from '../services/index-reconciler.js';
import { generateDummyCards } from './generate-dummy-cards.js';

interface BenchmarkResult {
  count: number;
  reconcileTimeMs: number;
  queryTimeMs: number;
  nodeCount: number;
}

export async function runBenchmark(): Promise<BenchmarkResult[]> {
  const sizes = [100, 500, 1000, 5000];
  const results: BenchmarkResult[] = [];

  console.error('[benchmark] Starting knowledge graph and database benchmark...');
  console.error('| Vault Size | Reconcile Time (ms) | Graph Query Depth-2 Time (ms) | Nodes Returned |');
  console.error('|------------|---------------------|-------------------------------|----------------|');

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

      // 5. Measure Graph Query (Recursive CTE on focus_id = decision-dummy-N, depth = 2, max_nodes = 100)
      const activeFocusId = `decision-dummy-${Math.floor(count / 2) || 1}`;
      const startQuery = Date.now();
      
      const cteQuery = `
        WITH RECURSIVE graph_nodes(id, depth) AS (
          SELECT ? as id, 0 as depth
          UNION
          SELECT 
            CASE 
              WHEN r.source_id = gn.id THEN r.target_id 
              ELSE r.source_id 
            END as id,
            gn.depth + 1
          FROM graph_nodes gn
          JOIN card_relations r ON r.source_id = gn.id OR r.target_id = gn.id
          WHERE gn.depth < ?
        )
        SELECT DISTINCT id FROM graph_nodes LIMIT ?
      `;

      const relatedIds = db.prepare(cteQuery).all(activeFocusId, 2, 100).map((row: any) => row.id);
      
      let nodeCount = 0;
      if (relatedIds.length > 0) {
        const placeholders = relatedIds.map(() => '?').join(',');
        const targetCards = db.prepare(`SELECT * FROM cards WHERE id IN (${placeholders})`).all(...relatedIds);
        nodeCount = targetCards.length;
      }
      
      const queryTimeMs = Date.now() - startQuery;

      results.push({
        count,
        reconcileTimeMs,
        queryTimeMs,
        nodeCount,
      });

      console.error(`| ${count.toString().padEnd(10)} | ${reconcileTimeMs.toString().padEnd(19)} | ${queryTimeMs.toString().padEnd(29)} | ${nodeCount.toString().padEnd(14)} |`);

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
