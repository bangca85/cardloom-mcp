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
});
