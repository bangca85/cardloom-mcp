import type Database from 'better-sqlite3';
import { computeTrust } from './trust-service.js';
import { computeCardFlags } from './card-service.js';
import { config } from '../config/env.js';

export interface GraphQueryParams {
  focusId?: string;
  domain?: string;
  stack?: string;
  depth?: number;
  maxNodes?: number;
  includeSharedStack?: boolean;
}

export interface GraphResult {
  nodes: any[];
  edges: any[];
  isDegraded: boolean;
  totalCount: number;
  sharedStackDegraded: boolean;
}

export function computeGraph(db: Database.Database, params: GraphQueryParams): GraphResult {
  const focusId = params.focusId ?? '';
  const domain = params.domain ?? '';
  const stack = params.stack ?? '';
  const depth = params.depth ?? 2;
  const maxNodes = params.maxNodes ?? 100;
  const includeSharedStack = params.includeSharedStack ?? false;

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
    const sqlParams: any[] = [];
    if (domain) {
      sql += ' AND domain = ?';
      sqlParams.push(domain);
    }
    if (stack) {
      sql += ' AND id IN (SELECT card_id FROM card_stacks WHERE stack_name = ?)';
      sqlParams.push(stack);
    }
    targetCards = db.prepare(sql).all(...sqlParams);
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

  let sharedStackDegraded = false;

  if (includeSharedStack && nodeIds.size > 0) {
    const placeholders = Array.from(nodeIds).map(() => '?').join(',');
    const nodeIdsArray = Array.from(nodeIds);
    const stackRows = db.prepare(
      `SELECT card_id, stack_name FROM card_stacks WHERE card_id IN (${placeholders})`
    ).all(...nodeIdsArray) as Array<{ card_id: string; stack_name: string }>;

    const genericTags = new Set(config.graphGenericStackTags);
    const groups = new Map<string, string[]>();
    for (const row of stackRows) {
      if (genericTags.has(row.stack_name.toLowerCase())) continue;
      if (!groups.has(row.stack_name)) groups.set(row.stack_name, []);
      groups.get(row.stack_name)!.push(row.card_id);
    }

    const seenPairs = new Set<string>();
    const sharedStackEdges: any[] = [];
    for (const [stackName, cardIds] of groups) {
      if (cardIds.length > config.maxSharedStackGroupSize) {
        console.error(
          `[graph-service] skipping shared_stack edges for oversized group: ${stackName} (${cardIds.length} cards)`
        );
        continue;
      }
      for (let i = 0; i < cardIds.length; i++) {
        for (let j = i + 1; j < cardIds.length; j++) {
          const [a, b] = [cardIds[i], cardIds[j]].sort();
          const pairKey = `${a}|${b}`;
          if (seenPairs.has(pairKey)) continue;
          seenPairs.add(pairKey);
          sharedStackEdges.push({
            from: a,
            to: b,
            dashes: [2, 4],
            color: { color: '#9a99a8' },
            label: 'shared_stack',
            font: { align: 'top', size: 8, color: '#9a99a8' },
          });
        }
      }
    }

    if (sharedStackEdges.length > config.maxSharedStackEdges) {
      console.error(
        `[graph-service] shared_stack layer exceeds MAX_SHARED_STACK_EDGES (${sharedStackEdges.length} > ${config.maxSharedStackEdges}) — dropping entire layer for this request`
      );
      sharedStackDegraded = true;
    } else {
      edges.push(...sharedStackEdges);
    }
  }

  return {
    nodes,
    edges,
    isDegraded: (totalCount > 500 && !focusId) || isDegraded,
    totalCount,
    sharedStackDegraded,
  };
}
