import express from 'express';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { config } from '../config/env.js';
import { getDatabase } from '../db/database.js';
import { reconcileIndex } from '../services/index-reconciler.js';
import { updateCardStatus, renderCard, computeCardFlags } from '../services/card-service.js';
import { computeTrust } from '../services/trust-service.js';
import { validateCardLenient } from '../types/card-schema.js';
import { NotFoundError, ValidationError, InvalidTransitionError } from '../types/errors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

let db = getDatabase(config.indexDbPath);
let storePath = config.knowledgeStorePath;

export function updateConfigPaths() {
  db = getDatabase(config.indexDbPath);
  storePath = config.knowledgeStorePath;
}

// Serve frontend assets
const publicPath = path.resolve(__dirname, 'public');
app.use(express.static(publicPath));

// Lightweight Single-Card Sync-on-Demand
function reconcileSingleCard(idxDb: Database.Database, id: string, storeDir: string): void {
  const cardPath = path.resolve(storeDir, 'cards', `${id}.md`);
  if (!fs.existsSync(cardPath)) {
    const row = idxDb.prepare('SELECT id FROM cards WHERE id = ?').get(id);
    if (row) {
      idxDb.prepare('DELETE FROM cards WHERE id = ?').run(id);
    }
    return;
  }

  const stat = fs.statSync(cardPath);
  const fileMtime = stat.mtime.toISOString();

  const row = idxDb.prepare('SELECT file_mtime FROM cards WHERE id = ?').get(id) as { file_mtime: string } | undefined;
  if (row && row.file_mtime === fileMtime) {
    return;
  }

  const rawContent = fs.readFileSync(cardPath, 'utf-8');
  const parsed = matter(rawContent);
  const { card } = validateCardLenient(parsed.data);

  const record = {
    id,
    type: card.type,
    status: card.status,
    title: card.title,
    domain: card.domain ?? null,
    stack: JSON.stringify(card.stack),
    applies_to: JSON.stringify(card.applies_to),
    task_type: card.task_type ?? null,
    error_signature: card.error_signature ?? null,
    scope: card.scope,
    version_range: card.version_range,
    sensitivity: card.sensitivity,
    supersedes: card.supersedes,
    conflicts_with: JSON.stringify(card.conflicts_with),
    source_commit: card.source_commit,
    provenance: card.provenance,
    verified_by: card.verified_by,
    verification_method: card.verification_method,
    last_verified: card.last_verified,
    deprecation_reason: card.status === 'deprecated' ? card.deprecation_reason : null,
    deprecated_at: card.status === 'deprecated' ? card.deprecated_at : null,
    deprecated_by: card.status === 'deprecated' ? card.deprecated_by : null,
    body: parsed.content,
    created_at: fileMtime,
    updated_at: fileMtime,
    file_mtime: fileMtime,
  };

  const insertOrReplace = idxDb.prepare(`
    INSERT INTO cards (
      id, type, status, title, domain, stack, applies_to, task_type, error_signature,
      scope, version_range, sensitivity, supersedes, conflicts_with, source_commit, provenance,
      verified_by, verification_method, last_verified, deprecation_reason, deprecated_at, deprecated_by,
      body, created_at, updated_at, file_mtime
    ) VALUES (
      @id, @type, @status, @title, @domain, @stack, @applies_to, @task_type, @error_signature,
      @scope, @version_range, @sensitivity, @supersedes, @conflicts_with, @source_commit, @provenance,
      @verified_by, @verification_method, @last_verified, @deprecation_reason, @deprecated_at, @deprecated_by,
      @body, @created_at, @updated_at, @file_mtime
    )
    ON CONFLICT(id) DO UPDATE SET
      type = excluded.type, status = excluded.status, title = excluded.title, domain = excluded.domain,
      stack = excluded.stack, applies_to = excluded.applies_to, task_type = excluded.task_type,
      error_signature = excluded.error_signature, scope = excluded.scope, version_range = excluded.version_range,
      sensitivity = excluded.sensitivity, supersedes = excluded.supersedes, conflicts_with = excluded.conflicts_with,
      source_commit = excluded.source_commit, provenance = excluded.provenance, verified_by = excluded.verified_by,
      verification_method = excluded.verification_method, last_verified = excluded.last_verified,
      deprecation_reason = excluded.deprecation_reason, deprecated_at = excluded.deprecated_at,
      deprecated_by = excluded.deprecated_by, body = excluded.body, updated_at = excluded.updated_at,
      file_mtime = excluded.file_mtime
  `);

  insertOrReplace.run(record);
}

// REST API: Get list of cards (List View)
app.get('/api/cards', (req, res) => {
  try {
    const includeDrafts = req.query['include_drafts'] === 'true';
    const includeDeprecated = req.query['include_deprecated'] === 'true';
    const includeRestricted = req.query['include_restricted'] === 'true';
    const query = typeof req.query['query'] === 'string' ? req.query['query'].trim() : '';
    const type = typeof req.query['type'] === 'string' ? req.query['type'] : '';
    const domain = typeof req.query['domain'] === 'string' ? req.query['domain'] : '';
    const limit = Number(req.query['limit']) || 50;
    const offset = Number(req.query['offset']) || 0;

    let sql = 'SELECT * FROM cards WHERE 1=1';
    const params: any[] = [];

    if (!includeDrafts) {
      sql += " AND status != 'draft'";
    }
    if (!includeDeprecated) {
      sql += " AND status != 'deprecated'";
    }
    if (!includeRestricted) {
      sql += " AND sensitivity = 'normal'";
    }

    if (type) {
      sql += ' AND type = ?';
      params.push(type);
    }
    if (domain) {
      sql += ' AND domain = ?';
      params.push(domain);
    }
    if (query) {
      sql += ' AND (id LIKE ? OR title LIKE ? OR body LIKE ?)';
      const likeQuery = `%${query}%`;
      params.push(likeQuery, likeQuery, likeQuery);
    }

    sql += ' ORDER BY id ASC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = db.prepare(sql).all(...params) as any[];

    const cards = rows.map((row) => {
      const counters = db.prepare('SELECT success, failure FROM counters WHERE card_id = ?').get(row.id) as
        | { success: number; failure: number }
        | undefined;
      const success = counters?.success ?? 0;
      const failure = counters?.failure ?? 0;

      const trust = computeTrust({
        status: row.status,
        lastVerified: row.last_verified,
        success,
        failure,
      });

      const flags = computeCardFlags({
        last_verified: row.last_verified,
        failure,
      }, new Date());

      let stack: string[] = [];
      try {
        stack = JSON.parse(row.stack);
      } catch {}
      let appliesTo: string[] = [];
      try {
        appliesTo = JSON.parse(row.applies_to);
      } catch {}

      return {
        id: row.id,
        title: row.title,
        type: row.type,
        status: row.status,
        trust,
        flags,
        stack,
        applies_to: appliesTo,
        domain: row.domain,
      };
    });

    res.json(cards);
  } catch (err) {
    console.error('[server] error in GET /api/cards:', err);
    res.status(500).json({ error: { message: (err as Error).message } });
  }
});

// REST API: Get detail of single card
app.get('/api/cards/:id', (req, res) => {
  const { id } = req.params;
  try {
    reconcileSingleCard(db, id, storePath);
    const rendered = renderCard(db, id);
    res.json(rendered);
  } catch (err) {
    if (err instanceof NotFoundError) {
      res.status(404).json({ error: { code: 'not_found', message: err.message } });
    } else {
      console.error(`[server] error in GET /api/cards/${id}:`, err);
      res.status(500).json({ error: { message: (err as Error).message } });
    }
  }
});

// REST API: Get graph data
app.get('/api/graph', (req, res) => {
  try {
    const focusId = typeof req.query['focus_id'] === 'string' ? req.query['focus_id'].trim() : '';
    const domain = typeof req.query['domain'] === 'string' ? req.query['domain'] : '';
    const stack = typeof req.query['stack'] === 'string' ? req.query['stack'] : '';

    let depth = 2;
    if (typeof req.query['depth'] === 'string') {
      const parsedDepth = parseInt(req.query['depth'], 10);
      if (!isNaN(parsedDepth) && parsedDepth >= 1 && parsedDepth <= 3) {
        depth = parsedDepth;
      }
    }

    let maxNodes = 100;
    if (typeof req.query['max_nodes'] === 'string') {
      const parsedMax = parseInt(req.query['max_nodes'], 10);
      if (!isNaN(parsedMax) && parsedMax >= 1 && parsedMax <= 500) {
        maxNodes = parsedMax;
      }
    }

    // Step 1: Count total active cards
    const countRow = db.prepare("SELECT COUNT(*) as count FROM cards WHERE status != 'deprecated'").get() as { count: number };
    const totalCount = countRow.count;

    let targetCards: any[] = [];
    let isDegraded = false;

    // Fallback switch if cards > 500 or explicit focus request
    if (totalCount > 500 || focusId) {
      let activeFocusId = focusId;
      if (!activeFocusId) {
        activeFocusId = (db.prepare("SELECT id FROM cards WHERE status = 'verified' LIMIT 1").get() as any)?.id || '';
        isDegraded = totalCount > 500;
      }

      if (activeFocusId) {
        const focusExists = db.prepare('SELECT 1 FROM cards WHERE id = ?').get(activeFocusId);
        if (focusExists) {
          // Recursive CTE to traverse bidirectional structural relations up to 'depth' hops
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

          const relatedIds = db.prepare(cteQuery).all(activeFocusId, depth, maxNodes).map((row: any) => row.id);

          if (relatedIds.length > 0) {
            const placeholders = relatedIds.map(() => '?').join(',');
            targetCards = db.prepare(`SELECT * FROM cards WHERE id IN (${placeholders})`).all(...relatedIds);
          }
        }
      }
    } else {
      // Full Graph Mode (fetch all verified and draft cards)
      let sql = "SELECT * FROM cards WHERE status != 'deprecated'";
      const params: any[] = [];
      if (domain) {
        sql += ' AND domain = ?';
        params.push(domain);
      }
      if (stack) {
        sql += ' AND id IN (SELECT card_id FROM card_stacks WHERE stack_name = ?)';
        params.push(stack);
      }
      targetCards = db.prepare(sql).all(...params);
    }

    // Deduplicate target cards
    const cardMap = new Map<string, any>();
    for (const card of targetCards) {
      cardMap.set(card.id, card);
    }
    const finalCards = Array.from(cardMap.values());

    // Format Nodes
    const nodes = finalCards.map((card) => {
      const counters = db.prepare('SELECT success, failure FROM counters WHERE card_id = ?').get(card.id) as
        | { success: number; failure: number }
        | undefined;
      const success = counters?.success ?? 0;
      const failure = counters?.failure ?? 0;

      const trust = computeTrust({
        status: card.status,
        lastVerified: card.last_verified,
        success,
        failure,
      });

      const flags = computeCardFlags({
        last_verified: card.last_verified,
        failure,
      }, new Date());

      return {
        id: card.id,
        label: card.id,
        title: card.title,
        group: card.domain || card.type,
        type: card.type,
        domain: card.domain,
        status: card.status,
        trust,
        flags,
      };
    });

    // Format Edges
    const edges: any[] = [];
    const nodeIds = new Set(nodes.map((n) => n.id));

    if (nodeIds.size > 0) {
      const placeholders = Array.from(nodeIds).map(() => '?').join(',');
      const relationsQuery = `
        SELECT source_id, target_id, relation_type 
        FROM card_relations 
        WHERE source_id IN (${placeholders}) AND target_id IN (${placeholders})
      `;
      const nodeIdsArray = Array.from(nodeIds);
      const activeRelations = db.prepare(relationsQuery).all(...nodeIdsArray, ...nodeIdsArray) as Array<{
        source_id: string;
        target_id: string;
        relation_type: string;
      }>;

      for (const rel of activeRelations) {
        if (rel.relation_type === 'supersedes') {
          edges.push({
            from: rel.source_id,
            to: rel.target_id,
            arrows: 'to',
            color: { color: '#2ec4b6' },
            label: 'supersedes',
            font: { align: 'top', size: 9, color: '#2ec4b6' },
          });
        } else if (rel.relation_type === 'conflicts_with') {
          const [first, second] = [rel.source_id, rel.target_id].sort();
          const edgeId = `conflict-${first}-${second}`;
          if (!edges.some((e) => e.id === edgeId)) {
            edges.push({
              id: edgeId,
              from: rel.source_id,
              to: rel.target_id,
              dashes: true,
              color: { color: '#e63946' },
              label: 'conflict',
              font: { align: 'top', size: 9, color: '#e63946' },
            });
          }
        }
      }
    }

    res.json({
      nodes,
      edges,
      isDegraded: (totalCount > 500 && !focusId) || isDegraded,
      totalCount,
    });
  } catch (err) {
    console.error('[server] error in GET /api/graph:', err);
    res.status(500).json({ error: { message: (err as Error).message } });
  }
});

// REST API: Approve Card
app.post('/api/cards/:id/approve', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await updateCardStatus(db, storePath, {
      id,
      action: 'verify',
      method: 'web-ui',
      by: config.reviewerName,
    });
    res.json(result);
  } catch (err) {
    if (err instanceof NotFoundError) {
      res.status(404).json({ error: { code: 'not_found', message: err.message } });
    } else if (err instanceof InvalidTransitionError) {
      res.status(400).json({ error: { code: 'invalid_transition', message: err.message } });
    } else if (err instanceof ValidationError) {
      res.status(400).json({ error: { code: 'validation_error', message: err.message, details: err.details } });
    } else {
      console.error(`[server] error in POST /api/cards/${id}/approve:`, err);
      res.status(500).json({ error: { message: (err as Error).message } });
    }
  }
});

// REST API: Deprecate Card
app.post('/api/cards/:id/deprecate', async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
  try {
    const result = await updateCardStatus(db, storePath, {
      id,
      action: 'deprecate',
      reason,
      by: config.reviewerName,
    });
    res.json(result);
  } catch (err) {
    if (err instanceof NotFoundError) {
      res.status(404).json({ error: { code: 'not_found', message: err.message } });
    } else if (err instanceof InvalidTransitionError) {
      res.status(400).json({ error: { code: 'invalid_transition', message: err.message } });
    } else if (err instanceof ValidationError) {
      res.status(400).json({ error: { code: 'validation_error', message: err.message, details: err.details } });
    } else {
      console.error(`[server] error in POST /api/cards/${id}/deprecate:`, err);
      res.status(500).json({ error: { message: (err as Error).message } });
    }
  }
});

export { app, db };
export let serverListener: any;

export async function startServer(port: number, host: string) {
  updateConfigPaths();
  console.error('[server] Initializing index reconciliation...');
  try {
    await reconcileIndex(db, storePath);
  } catch (err) {
    console.error('[server] Warning: Initial index reconciliation failed:', err);
  }

  return new Promise<any>((resolve) => {
    const listener = app.listen(port, host, () => {
      console.error(`[server] Obsidian-Web Viewer running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
      resolve(listener);
    });
    serverListener = listener;
  });
}

if (process.env.NODE_ENV !== 'test') {
  const defaultPort = Number(process.env['PORT']) || 3334;
  const hostname = process.env['RUNNING_IN_DOCKER'] ? '0.0.0.0' : '127.0.0.1';
  startServer(defaultPort, hostname).catch((err) => {
    console.error('[server] Fatal startup error:', err);
    process.exit(1);
  });
}
