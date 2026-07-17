import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getDatabase, closeDatabase } from '../../src/db/database.js';
import { initKnowledgeStore } from '../../src/services/knowledge-store.js';
import { reconcileIndex } from '../../src/services/index-reconciler.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cardloom-web-server-test-'));
}

describe('Web Server API', () => {
  let storePath: string;
  let dbPath: string;
  let serverListener: any;
  let port: number;

  beforeEach(async () => {
    storePath = tmpDir();
    await initKnowledgeStore(storePath);
    dbPath = path.join(storePath, '.metadata', 'index.db');

    // Setup a draft card fixture
    const draftCardPath = path.join(storePath, 'cards', 'gotcha-mock-draft.md');
    fs.writeFileSync(
      draftCardPath,
      `---
title: Mock Draft Gotcha
type: gotcha
scope: project
applies_to: [api]
stack: [typescript]
version_range: '>=5.0.0'
status: draft
sensitivity: normal
source_commit: abc123
provenance: test
error_signature: 'SyntaxError: Unexpected token'
---
This is a mock draft card.
`
    );

    // Setup a verified card fixture
    const verifiedCardPath = path.join(storePath, 'cards', 'pattern-mock-verified.md');
    fs.writeFileSync(
      verifiedCardPath,
      `---
title: Mock Verified Pattern
type: pattern
scope: project
applies_to: [web]
stack: [javascript]
version_range: '*'
status: verified
sensitivity: normal
verified_by: human-reviewer
verification_method: chat-approval
last_verified: '2026-07-07T08:00:00Z'
source_commit: def456
provenance: test
---
This is a mock verified card.
`
    );

    // Set env variables for dynamic import
    process.env['INDEX_DB_PATH'] = dbPath;
    process.env['KNOWLEDGE_STORE_PATH'] = storePath;

    // Dynamically import the web server
    const serverModule = await import('../../src/web/server.js');
    
    // Start server for each test
    serverListener = await serverModule.startServer(0, '127.0.0.1');

    const address = serverListener.address();
    port = typeof address === 'string' ? 3334 : address.port;
  });

  afterEach(async () => {
    if (serverListener) {
      await new Promise<void>((resolve) => {
        serverListener.close(() => resolve());
      });
    }
    closeDatabase();
    // Reset env
    delete process.env['PORT'];
    delete process.env['INDEX_DB_PATH'];
    delete process.env['KNOWLEDGE_STORE_PATH'];
    delete process.env['REVIEWER_NAME'];
    delete process.env['GRAPH_GENERIC_STACK_TAGS'];
    delete process.env['MAX_SHARED_STACK_GROUP_SIZE'];
    delete process.env['MAX_SHARED_STACK_EDGES'];
    fs.rmSync(storePath, { recursive: true, force: true });
  });

  it('GET /api/cards returns list of verified cards by default', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/cards`);
    expect(res.status).toBe(200);
    const json = await res.json() as any[];
    
    // By default, includes verified, excludes draft & deprecated
    expect(json).toHaveLength(1);
    expect(json[0].id).toBe('pattern-mock-verified');
  });

  it('GET /api/cards with include_drafts=true returns drafts as well', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/cards?include_drafts=true`);
    expect(res.status).toBe(200);
    const json = await res.json() as any[];
    expect(json.length).toBeGreaterThanOrEqual(2);
    
    const ids = json.map(c => c.id);
    expect(ids).toContain('gotcha-mock-draft');
    expect(ids).toContain('pattern-mock-verified');
  });

  it('GET /api/cards/:id returns rendered card body and metadata', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/cards/pattern-mock-verified`);
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.id).toBe('pattern-mock-verified');
    expect(json.body).toContain('This is a mock verified card.');
    expect(json.trust).toBeDefined();
    expect(json.flags).toBeDefined();
  });

  it('GET /api/graph returns nodes and edges for active cards', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/graph`);
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.nodes).toBeDefined();
    expect(json.edges).toBeDefined();
    expect(json.isDegraded).toBe(false);
    
    const nodeIds = json.nodes.map((n: any) => n.id);
    expect(nodeIds).toContain('pattern-mock-verified');
    expect(nodeIds).toContain('gotcha-mock-draft');
  });

  it('POST /api/cards/:id/approve transitions a draft to verified', async () => {
    // Approve
    const resApprove = await fetch(`http://127.0.0.1:${port}/api/cards/gotcha-mock-draft/approve`, {
      method: 'POST'
    });
    expect(resApprove.status).toBe(200);
    const outcome = await resApprove.json() as any;
    expect(outcome.status).toBe('verified');
    expect(outcome.index_updated).toBe(true);

    // Re-fetch detail
    const resDetail = await fetch(`http://127.0.0.1:${port}/api/cards/gotcha-mock-draft`);
    const card = await resDetail.json() as any;
    expect(card.status).toBe('verified');
    expect(card.verified_by).toBe('human-reviewer');
    expect(card.verification_method).toBe('web-ui');
  });

  it('POST /api/cards/:id/deprecate transitions verified card to deprecated', async () => {
    const resDeprecate = await fetch(`http://127.0.0.1:${port}/api/cards/pattern-mock-verified/deprecate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Outdated pattern' })
    });
    expect(resDeprecate.status).toBe(200);
    const outcome = await resDeprecate.json() as any;
    expect(outcome.status).toBe('deprecated');

    // Check detail
    const resDetail = await fetch(`http://127.0.0.1:${port}/api/cards/pattern-mock-verified`);
    const card = await resDetail.json() as any;
    expect(card.status).toBe('deprecated');
    expect(card.deprecation_reason).toBe('Outdated pattern');
  });

  it('GET /api/graph with focus_id, depth, and max_nodes works with Recursive CTE', async () => {
    // Setup a chain of related cards: card-A -> card-B -> card-C -> card-D
    // A (supersedes B), B (conflicts with C), C (supersedes D)
    const writeCard = (id: string, content: string) => {
      fs.writeFileSync(path.join(storePath, 'cards', `${id}.md`), content);
    };

    writeCard('card-A', `---
title: Card A
type: decision
scope: project
applies_to: [api]
stack: [typescript]
version_range: '*'
status: verified
sensitivity: normal
verified_by: human-reviewer
verification_method: test
last_verified: '2026-07-07T08:00:00Z'
source_commit: abc
provenance: test
supersedes: card-B
---
Body A`);

    writeCard('card-B', `---
title: Card B
type: decision
scope: project
applies_to: [api]
stack: [typescript]
version_range: '*'
status: verified
sensitivity: normal
verified_by: human-reviewer
verification_method: test
last_verified: '2026-07-07T08:00:00Z'
source_commit: abc
provenance: test
conflicts_with: [card-C]
---
Body B`);

    writeCard('card-C', `---
title: Card C
type: decision
scope: project
applies_to: [api]
stack: [typescript]
version_range: '*'
status: verified
sensitivity: normal
verified_by: human-reviewer
verification_method: test
last_verified: '2026-07-07T08:00:00Z'
source_commit: abc
provenance: test
supersedes: card-D
---
Body C`);

    writeCard('card-D', `---
title: Card D
type: decision
scope: project
applies_to: [api]
stack: [javascript]
version_range: '*'
status: verified
sensitivity: normal
verified_by: human-reviewer
verification_method: test
last_verified: '2026-07-07T08:00:00Z'
source_commit: abc
provenance: test
---
Body D`);

    // Reconcile new cards
    const db = getDatabase(dbPath);
    await reconcileIndex(db, storePath);

    // 1. Query with depth = 1 around card-A (should return A and B)
    const resDepth1 = await fetch(`http://127.0.0.1:${port}/api/graph?focus_id=card-A&depth=1`);
    expect(resDepth1.status).toBe(200);
    const json1 = await resDepth1.json() as any;
    const nodeIds1 = json1.nodes.map((n: any) => n.id);
    expect(nodeIds1).toContain('card-A');
    expect(nodeIds1).toContain('card-B');
    expect(nodeIds1).not.toContain('card-C');
    expect(nodeIds1).not.toContain('card-D');
    
    // Check edges for depth 1 (should contain supersedes A->B)
    expect(json1.edges).toHaveLength(1);
    expect(json1.edges[0]).toMatchObject({ from: 'card-A', to: 'card-B', label: 'supersedes' });

    // 2. Query with depth = 2 around card-A (should return A, B, C)
    const resDepth2 = await fetch(`http://127.0.0.1:${port}/api/graph?focus_id=card-A&depth=2`);
    const json2 = await resDepth2.json() as any;
    const nodeIds2 = json2.nodes.map((n: any) => n.id);
    expect(nodeIds2).toContain('card-A');
    expect(nodeIds2).toContain('card-B');
    expect(nodeIds2).toContain('card-C');
    expect(nodeIds2).not.toContain('card-D');

    // Check edges for depth 2 (should contain supersedes A->B and conflict B<->C)
    expect(json2.edges.map((e: any) => e.label)).toContain('supersedes');
    expect(json2.edges.map((e: any) => e.label)).toContain('conflict');

    // 3. Query with depth = 3 around card-A (should return A, B, C, D)
    const resDepth3 = await fetch(`http://127.0.0.1:${port}/api/graph?focus_id=card-A&depth=3`);
    const json3 = await resDepth3.json() as any;
    const nodeIds3 = json3.nodes.map((n: any) => n.id);
    expect(nodeIds3).toContain('card-D');

    // 4. Query with max_nodes = 2
    const resMaxNodes = await fetch(`http://127.0.0.1:${port}/api/graph?focus_id=card-A&depth=3&max_nodes=2`);
    const jsonMax = await resMaxNodes.json() as any;
    expect(jsonMax.nodes).toHaveLength(2);

    // 5. Query full graph by stack using card_stacks index
    const resStack = await fetch(`http://127.0.0.1:${port}/api/graph?stack=javascript`);
    const jsonStack = await resStack.json() as any;
    const stackNodes = jsonStack.nodes.map((n: any) => n.id);
    // card-D has javascript, others have typescript, pattern-mock-verified has javascript
    expect(stackNodes).toContain('card-D');
    expect(stackNodes).toContain('pattern-mock-verified');
    expect(stackNodes).not.toContain('card-A');
  });

  it('reconcileSingleCard (GET /api/cards/:id) keeps card_relations in sync without a full reconcileIndex', async () => {
    const writeCard = (id: string, content: string) => {
      fs.writeFileSync(path.join(storePath, 'cards', `${id}.md`), content);
    };

    const cardBody = (id: string, title: string, supersedes: string | undefined, body: string) => `---
title: ${title}
type: decision
scope: project
applies_to: [api]
stack: [typescript]
version_range: '*'
status: verified
sensitivity: normal
verified_by: human-reviewer
verification_method: test
last_verified: '2026-07-07T08:00:00Z'
source_commit: abc
provenance: test
${supersedes ? `supersedes: ${supersedes}\n` : ''}---
${body}`;

    writeCard('card-E', cardBody('card-E', 'Card E', 'card-F', 'Body E'));
    writeCard('card-F', cardBody('card-F', 'Card F', undefined, 'Body F'));
    writeCard('card-G', cardBody('card-G', 'Card G', undefined, 'Body G'));

    // Sync each card individually via the single-card endpoint (reconcileSingleCard) — never call reconcileIndex here
    await fetch(`http://127.0.0.1:${port}/api/cards/card-E`);
    await fetch(`http://127.0.0.1:${port}/api/cards/card-F`);
    await fetch(`http://127.0.0.1:${port}/api/cards/card-G`);

    const resBefore = await fetch(`http://127.0.0.1:${port}/api/graph`);
    const jsonBefore = await resBefore.json() as any;
    expect(jsonBefore.edges).toContainEqual(expect.objectContaining({ from: 'card-E', to: 'card-F', label: 'supersedes' }));

    // Edit card-E on disk: supersedes now points to card-G instead of card-F
    const editedPath = path.join(storePath, 'cards', 'card-E.md');
    writeCard('card-E', cardBody('card-E', 'Card E', 'card-G', 'Body E edited'));
    const futureTime = new Date(Date.now() + 5000);
    fs.utimesSync(editedPath, futureTime, futureTime);

    // Re-sync ONLY card-E through the single-card endpoint
    await fetch(`http://127.0.0.1:${port}/api/cards/card-E`);

    const resAfter = await fetch(`http://127.0.0.1:${port}/api/graph`);
    const jsonAfter = await resAfter.json() as any;
    expect(jsonAfter.edges).toContainEqual(expect.objectContaining({ from: 'card-E', to: 'card-G', label: 'supersedes' }));
    expect(jsonAfter.edges).not.toContainEqual(expect.objectContaining({ from: 'card-E', to: 'card-F' }));
  });

  it('reconcileSingleCard (GET /api/cards/:id) removes stale card_relations when a card is deleted from disk', async () => {
    const writeCard = (id: string, content: string) => {
      fs.writeFileSync(path.join(storePath, 'cards', `${id}.md`), content);
    };

    const cardBody = (title: string, supersedes: string | undefined, body: string) => `---
title: ${title}
type: decision
scope: project
applies_to: [api]
stack: [typescript]
version_range: '*'
status: verified
sensitivity: normal
verified_by: human-reviewer
verification_method: test
last_verified: '2026-07-07T08:00:00Z'
source_commit: abc
provenance: test
${supersedes ? `supersedes: ${supersedes}\n` : ''}---
${body}`;

    writeCard('card-H', cardBody('Card H', 'card-I', 'Body H'));
    writeCard('card-I', cardBody('Card I', undefined, 'Body I'));

    await fetch(`http://127.0.0.1:${port}/api/cards/card-H`);
    await fetch(`http://127.0.0.1:${port}/api/cards/card-I`);

    const resBefore = await fetch(`http://127.0.0.1:${port}/api/graph`);
    const jsonBefore = await resBefore.json() as any;
    expect(jsonBefore.edges).toContainEqual(expect.objectContaining({ from: 'card-H', to: 'card-I', label: 'supersedes' }));

    // Delete card-H from disk, then trigger reconcileSingleCard's delete branch via the single-card endpoint
    fs.rmSync(path.join(storePath, 'cards', 'card-H.md'));
    const res404 = await fetch(`http://127.0.0.1:${port}/api/cards/card-H`);
    expect(res404.status).toBe(404);

    const resAfter = await fetch(`http://127.0.0.1:${port}/api/graph`);
    const jsonAfter = await resAfter.json() as any;
    expect(jsonAfter.edges).not.toContainEqual(expect.objectContaining({ from: 'card-H' }));
  });

  it('GET /api/graph?include_shared_stack=true derives shared_stack edges from card_stacks, deduped per pair, opt-in only', async () => {
    const writeCard = (id: string, stackTags: string[], body: string) => {
      fs.writeFileSync(path.join(storePath, 'cards', `${id}.md`), `---
title: ${id}
type: decision
scope: project
applies_to: [api]
stack: [${stackTags.join(', ')}]
version_range: '*'
status: verified
sensitivity: normal
verified_by: human-reviewer
verification_method: test
last_verified: '2026-07-07T08:00:00Z'
source_commit: abc
provenance: test
---
${body}`);
    };

    // card-J and card-K share TWO stack tags — must still dedupe to exactly one shared_stack edge (AC #5)
    writeCard('card-J', ['shared-tag-one', 'shared-tag-two'], 'Body J');
    writeCard('card-K', ['shared-tag-one', 'shared-tag-two'], 'Body K');

    const db = getDatabase(dbPath);
    await reconcileIndex(db, storePath);

    // Default (no include_shared_stack) — no shared_stack edges at all
    const resDefault = await fetch(`http://127.0.0.1:${port}/api/graph`);
    const jsonDefault = await resDefault.json() as any;
    expect(jsonDefault.edges.filter((e: any) => e.label === 'shared_stack')).toHaveLength(0);

    // Opt-in — exactly one deduped edge between card-J and card-K
    const resOn = await fetch(`http://127.0.0.1:${port}/api/graph?include_shared_stack=true`);
    const jsonOn = await resOn.json() as any;
    const sharedEdges = jsonOn.edges.filter((e: any) => e.label === 'shared_stack');
    expect(sharedEdges).toHaveLength(1);
    expect([sharedEdges[0].from, sharedEdges[0].to].sort()).toEqual(['card-J', 'card-K']);
  });

  it('GET /api/graph?include_shared_stack=true excludes configured generic stack tags', async () => {
    const writeCard = (id: string, stackTag: string, body: string) => {
      fs.writeFileSync(path.join(storePath, 'cards', `${id}.md`), `---
title: ${id}
type: decision
scope: project
applies_to: [api]
stack: [${stackTag}]
version_range: '*'
status: verified
sensitivity: normal
verified_by: human-reviewer
verification_method: test
last_verified: '2026-07-07T08:00:00Z'
source_commit: abc
provenance: test
---
${body}`);
    };

    writeCard('card-L', 'generic-tag-x', 'Body L');
    writeCard('card-M', 'generic-tag-x', 'Body M');

    const db = getDatabase(dbPath);
    await reconcileIndex(db, storePath);

    process.env['GRAPH_GENERIC_STACK_TAGS'] = 'generic-tag-x';

    const res = await fetch(`http://127.0.0.1:${port}/api/graph?include_shared_stack=true`);
    const json = await res.json() as any;
    expect(json.edges.filter((e: any) => e.label === 'shared_stack')).toHaveLength(0);
  });

  it('GET /api/graph?include_shared_stack=true skips a stack group larger than MAX_SHARED_STACK_GROUP_SIZE', async () => {
    const writeCard = (id: string, body: string) => {
      fs.writeFileSync(path.join(storePath, 'cards', `${id}.md`), `---
title: ${id}
type: decision
scope: project
applies_to: [api]
stack: [oversized-tag]
version_range: '*'
status: verified
sensitivity: normal
verified_by: human-reviewer
verification_method: test
last_verified: '2026-07-07T08:00:00Z'
source_commit: abc
provenance: test
---
${body}`);
    };

    writeCard('card-N1', 'Body N1');
    writeCard('card-N2', 'Body N2');
    writeCard('card-N3', 'Body N3');

    const db = getDatabase(dbPath);
    await reconcileIndex(db, storePath);

    process.env['MAX_SHARED_STACK_GROUP_SIZE'] = '2';

    const res = await fetch(`http://127.0.0.1:${port}/api/graph?include_shared_stack=true`);
    const json = await res.json() as any;
    expect(json.edges.filter((e: any) => e.label === 'shared_stack')).toHaveLength(0);
  });

  it('reconcileSingleCard removes inbound card_relations when the TARGET of a supersedes/conflicts_with is deleted from disk', async () => {
    const writeCard = (id: string, content: string) => {
      fs.writeFileSync(path.join(storePath, 'cards', `${id}.md`), content);
    };

    const cardBody = (title: string, supersedes: string | undefined, body: string) => `---
title: ${title}
type: decision
scope: project
applies_to: [api]
stack: [typescript]
version_range: '*'
status: verified
sensitivity: normal
verified_by: human-reviewer
verification_method: test
last_verified: '2026-07-07T08:00:00Z'
source_commit: abc
provenance: test
${supersedes ? `supersedes: ${supersedes}\n` : ''}---
${body}`;

    // card-P supersedes card-Q — card-Q is the TARGET, not the source
    writeCard('card-P', cardBody('Card P', 'card-Q', 'Body P'));
    writeCard('card-Q', cardBody('Card Q', undefined, 'Body Q'));

    await fetch(`http://127.0.0.1:${port}/api/cards/card-P`);
    await fetch(`http://127.0.0.1:${port}/api/cards/card-Q`);

    const resBefore = await fetch(`http://127.0.0.1:${port}/api/graph`);
    const jsonBefore = await resBefore.json() as any;
    expect(jsonBefore.edges).toContainEqual(expect.objectContaining({ from: 'card-P', to: 'card-Q', label: 'supersedes' }));

    // Delete card-Q (the TARGET) from disk, then trigger reconcileSingleCard's delete branch for it
    fs.rmSync(path.join(storePath, 'cards', 'card-Q.md'));
    const res404 = await fetch(`http://127.0.0.1:${port}/api/cards/card-Q`);
    expect(res404.status).toBe(404);

    // Assert directly against the DB, not /api/graph: since card-Q no longer exists in `cards`,
    // it would drop out of the graph's node set (and thus its edges) even if the stale
    // card_relations row with target_id='card-Q' were never cleaned up. Only a direct DB read
    // proves deleteCardRelationsAndStacks actually cleaned the inbound (target_id) row.
    const db = getDatabase(dbPath);
    const orphanRows = db.prepare('SELECT * FROM card_relations WHERE target_id = ?').all('card-Q');
    expect(orphanRows).toHaveLength(0);
    const sourceRows = db.prepare('SELECT * FROM card_relations WHERE source_id = ?').all('card-Q');
    expect(sourceRows).toHaveLength(0);
  });

  it('GET /api/graph?include_shared_stack=true drops the entire shared_stack layer and reports sharedStackDegraded when it exceeds MAX_SHARED_STACK_EDGES', async () => {
    const writeCard = (id: string, tag: string, body: string) => {
      fs.writeFileSync(path.join(storePath, 'cards', `${id}.md`), `---
title: ${id}
type: decision
scope: project
applies_to: [api]
stack: [${tag}]
version_range: '*'
status: verified
sensitivity: normal
verified_by: human-reviewer
verification_method: test
last_verified: '2026-07-07T08:00:00Z'
source_commit: abc
provenance: test
---
${body}`);
    };

    // 4 cards sharing one tag = 6 pairs, well within the per-group cap (default 50)
    writeCard('card-O1', 'oversized-total-tag', 'Body O1');
    writeCard('card-O2', 'oversized-total-tag', 'Body O2');
    writeCard('card-O3', 'oversized-total-tag', 'Body O3');
    writeCard('card-O4', 'oversized-total-tag', 'Body O4');

    const db = getDatabase(dbPath);
    await reconcileIndex(db, storePath);

    // Set the GLOBAL cap below the 6 pairs this group would produce
    process.env['MAX_SHARED_STACK_EDGES'] = '3';

    const res = await fetch(`http://127.0.0.1:${port}/api/graph?include_shared_stack=true`);
    const json = await res.json() as any;
    expect(json.sharedStackDegraded).toBe(true);
    expect(json.edges.filter((e: any) => e.label === 'shared_stack')).toHaveLength(0);
  });

  it('GET /api/graph?include_shared_stack=true does not collide edge identities across differently-hyphenated card id pairs', async () => {
    const writeCard = (id: string, tag: string, body: string) => {
      fs.writeFileSync(path.join(storePath, 'cards', `${id}.md`), `---
title: ${id}
type: decision
scope: project
applies_to: [api]
stack: [${tag}]
version_range: '*'
status: verified
sensitivity: normal
verified_by: human-reviewer
verification_method: test
last_verified: '2026-07-07T08:00:00Z'
source_commit: abc
provenance: test
---
${body}`);
    };

    // Naive string-concat edge ids ("shared-stack-" + a + "-" + b) would collide between these two
    // distinct pairs: ("card-R", "S-T") and ("card-R-S", "T") both stringify to "shared-stack-card-R-S-T".
    writeCard('card-R', 'collision-tag-one', 'Body R');
    writeCard('S-T', 'collision-tag-one', 'Body S-T');
    writeCard('card-R-S', 'collision-tag-two', 'Body R-S');
    writeCard('T', 'collision-tag-two', 'Body T');

    const db = getDatabase(dbPath);
    await reconcileIndex(db, storePath);

    const res = await fetch(`http://127.0.0.1:${port}/api/graph?include_shared_stack=true`);
    const json = await res.json() as any;
    const sharedEdges = json.edges.filter((e: any) => e.label === 'shared_stack');
    const sharedPairs = sharedEdges.map((e: any) => [e.from, e.to].sort());
    expect(sharedPairs).toHaveLength(2);
    expect(sharedPairs).toContainEqual(['S-T', 'card-R'].sort());
    expect(sharedPairs).toContainEqual(['T', 'card-R-S'].sort());
  });
});
