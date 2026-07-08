import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type Database from 'better-sqlite3';
import { getDatabase, closeDatabase } from '../src/db/database.js';
import { initKnowledgeStore } from '../src/services/knowledge-store.js';
import { resetGit } from '../src/services/git-service.js';
import { createServer } from '../src/server.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cardloom-mcp-server-'));
}

function baseArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Use X pattern for retries',
    type: 'pattern',
    scope: 'project',
    applies_to: ['api'],
    stack: ['node'],
    version_range: '>=1.0.0',
    body: 'Body describing the retry pattern in detail.',
    source_commit: 'abc123',
    provenance: 'agent-observation',
    ...overrides,
  };
}

describe('MCP server surface (story 1.6)', () => {
  let storePath: string;
  let db: Database.Database;
  let client: Client;

  beforeEach(async () => {
    storePath = tmpDir();
    await initKnowledgeStore(storePath);
    db = getDatabase(path.join(storePath, '.metadata', 'index.db'));

    const server = createServer(db, storePath);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    closeDatabase();
    resetGit();
    fs.rmSync(storePath, { recursive: true, force: true });
  });

  it('exposes exactly the 5 v2 tools — no v1 tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_card',
      'report_card_usage',
      'save_learning_draft',
      'search_knowledge',
      'update_card_status',
    ]);
  });

  it('exposes the distill_project_knowledge prompt and interpolates project_path', async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(['distill_project_knowledge']);

    const result = await client.getPrompt({
      name: 'distill_project_knowledge',
      arguments: { project_path: '/repo/sample-app' },
    });
    expect(result.messages).toHaveLength(1);
    const content = result.messages[0]?.content as { type: string; text: string };
    expect(content.type).toBe('text');
    expect(content.text).toContain('/repo/sample-app');
  });

  it('saves a valid card through the full MCP round-trip (AC1)', async () => {
    const result = await client.callTool({ name: 'save_learning_draft', arguments: baseArgs() });
    expect(result.isError).toBeFalsy();

    const body = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text) as {
      id: string;
      status: string;
    };
    expect(body).toMatchObject({ id: 'pattern-use-x-pattern-for-retries', status: 'draft' });
  });

  it('maps a secret-detected rejection to code secret_detected (AC3)', async () => {
    const result = await client.callTool({
      name: 'save_learning_draft',
      arguments: baseArgs({ body: 'API_KEY=sk-abc123defghijklmnop456' }),
    });

    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text) as {
      error: { code: string };
    };
    expect(body.error.code).toBe('secret_detected');
  });

  it('maps a schema-invalid card to code validation_error (AC3)', async () => {
    const result = await client.callTool({
      name: 'save_learning_draft',
      arguments: baseArgs({ type: 'gotcha' }), // missing required error_signature
    });

    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text) as {
      error: { code: string };
    };
    expect(body.error.code).toBe('validation_error');
  });

  it('maps a facet conflict to code conflict with the FR14 payload (AC3)', async () => {
    await client.callTool({ name: 'save_learning_draft', arguments: baseArgs({ title: 'First retry pattern' }) });

    const result = await client.callTool({
      name: 'save_learning_draft',
      arguments: baseArgs({ title: 'Second retry pattern' }),
    });

    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text) as {
      error: { code: string; details: { conflicting_card_id: string; diff_summary: string; options: string[] } };
    };
    expect(body.error.code).toBe('conflict');
    expect(body.error.details.conflicting_card_id).toBe('pattern-first-retry-pattern');
    expect(body.error.details.options).toEqual(['supersede', 'scope-split']);
  });

  it('get_card returns not_found for a missing id (AC2, story 2.4)', async () => {
    const result = await client.callTool({ name: 'get_card', arguments: { id: 'pattern-does-not-exist' } });

    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text) as {
      error: { code: string };
    };
    expect(body.error.code).toBe('not_found');
  });

  it('get_card and the knowledge://card/{id} Resource return the same rendered card (AC1, story 2.4)', async () => {
    await client.callTool({ name: 'save_learning_draft', arguments: baseArgs({ title: 'Equivalence check pattern' }) });
    const id = 'pattern-equivalence-check-pattern';

    const toolResult = await client.callTool({ name: 'get_card', arguments: { id } });
    const toolBody = JSON.parse((toolResult.content as Array<{ type: string; text: string }>)[0]!.text) as {
      card: Record<string, unknown>;
    };

    const resourceResult = await client.readResource({ uri: `knowledge://card/${id}` });
    const resourceBody = JSON.parse((resourceResult.contents[0] as { text: string }).text) as {
      card: Record<string, unknown>;
    };

    expect(resourceBody.card).toEqual(toolBody.card);
    expect(toolBody.card['status']).toBe('draft');
    expect(toolBody.card['untrusted']).toBe(true);
  });

  it('report_card_usage returns not_found for a missing id (AC3, story 3.2)', async () => {
    const result = await client.callTool({
      name: 'report_card_usage',
      arguments: { id: 'pattern-does-not-exist', outcome: 'confirmed' },
    });

    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text) as {
      error: { code: string };
    };
    expect(body.error.code).toBe('not_found');
  });

  it('report_card_usage maps an out-of-enum outcome to validation_error (AC3, story 3.2)', async () => {
    await client.callTool({ name: 'save_learning_draft', arguments: baseArgs({ title: 'Outcome enum check pattern' }) });

    const result = await client.callTool({
      name: 'report_card_usage',
      arguments: { id: 'pattern-outcome-enum-check-pattern', outcome: 'maybe' },
    });

    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text) as {
      error: { code: string };
    };
    expect(body.error.code).toBe('validation_error');
  });

  it('closes the loop: repeated refuted usage makes needs_review appear in search (AC2, story 3.2)', async () => {
    await client.callTool({ name: 'save_learning_draft', arguments: baseArgs({ title: 'Flaky retry pattern' }) });
    const id = 'pattern-flaky-retry-pattern';

    // REVIEW_FAILURE_THRESHOLD default is 2 — two refuted reports should trip the flag.
    await client.callTool({ name: 'report_card_usage', arguments: { id, outcome: 'refuted' } });
    const usageResult = await client.callTool({ name: 'report_card_usage', arguments: { id, outcome: 'refuted' } });
    expect(usageResult.isError).toBeFalsy();
    const usageBody = JSON.parse((usageResult.content as Array<{ type: string; text: string }>)[0]!.text) as {
      counters: { usage: number; success: number; failure: number };
    };
    expect(usageBody.counters).toEqual({ usage: 2, success: 0, failure: 2 });

    // The card is still draft (never verified) — include_drafts is required to see it in search.
    const searchResult = await client.callTool({
      name: 'search_knowledge',
      arguments: { query: 'flaky retry', include_drafts: true },
    });
    const searchBody = JSON.parse((searchResult.content as Array<{ type: string; text: string }>)[0]!.text) as {
      results: Array<{ id: string; flags: { needs_review?: boolean } }>;
    };

    const found = searchBody.results.find((r) => r.id === id);
    expect(found?.flags.needs_review).toBe(true);
  });

  it('update_card_status verifies a draft card through the full MCP round-trip (AC1, story 3.3)', async () => {
    await client.callTool({ name: 'save_learning_draft', arguments: baseArgs({ title: 'Verify round trip pattern' }) });

    const result = await client.callTool({
      name: 'update_card_status',
      arguments: { id: 'pattern-verify-round-trip-pattern', action: 'verify' },
    });

    expect(result.isError).toBeFalsy();
    const body = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text) as { status: string };
    expect(body.status).toBe('verified');
  });

  it('update_card_status maps an unknown action to invalid_transition with valid options (AC3, story 3.3)', async () => {
    await client.callTool({ name: 'save_learning_draft', arguments: baseArgs({ title: 'Bad action pattern' }) });

    const result = await client.callTool({
      name: 'update_card_status',
      arguments: { id: 'pattern-bad-action-pattern', action: 'delete' },
    });

    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text) as {
      error: { code: string; details: { from: string; action: string; validTransitions: string[] } };
    };
    expect(body.error.code).toBe('invalid_transition');
    expect(body.error.details.validTransitions).toEqual(['verified', 'deprecated']);
  });

  it('deprecate is invalidate-and-preserve: card stays readable via get_card but disappears from default search (AC2, story 3.3)', async () => {
    await client.callTool({ name: 'save_learning_draft', arguments: baseArgs({ title: 'Preserve on deprecate pattern' }) });
    const id = 'pattern-preserve-on-deprecate-pattern';
    await client.callTool({ name: 'update_card_status', arguments: { id, action: 'verify' } });

    const deprecateResult = await client.callTool({
      name: 'update_card_status',
      arguments: { id, action: 'deprecate', reason: 'no longer accurate' },
    });
    expect(deprecateResult.isError).toBeFalsy();

    const getCardResult = await client.callTool({ name: 'get_card', arguments: { id } });
    expect(getCardResult.isError).toBeFalsy();
    const cardBody = JSON.parse((getCardResult.content as Array<{ type: string; text: string }>)[0]!.text) as {
      card: { status: string; deprecated?: boolean; deprecation_reason?: string };
    };
    expect(cardBody.card.status).toBe('deprecated');
    expect(cardBody.card.deprecated).toBe(true);
    expect(cardBody.card.deprecation_reason).toBe('no longer accurate');

    const searchResult = await client.callTool({
      name: 'search_knowledge',
      arguments: { query: 'preserve on deprecate' },
    });
    const searchBody = JSON.parse((searchResult.content as Array<{ type: string; text: string }>)[0]!.text) as {
      results: Array<{ id: string }>;
    };
    expect(searchBody.results.map((r) => r.id)).not.toContain(id);
  });

  it('supersede two-phase: verifying the new card deprecates the old one in the same operation (AC1, story 3.4)', async () => {
    await client.callTool({ name: 'save_learning_draft', arguments: baseArgs({ title: 'Old supersede round trip pattern' }) });
    const oldId = 'pattern-old-supersede-round-trip-pattern';
    await client.callTool({ name: 'update_card_status', arguments: { id: oldId, action: 'verify' } });

    await client.callTool({
      name: 'save_learning_draft',
      arguments: baseArgs({ title: 'New supersede round trip pattern', supersedes: oldId }),
    });
    const newId = 'pattern-new-supersede-round-trip-pattern';

    const verifyResult = await client.callTool({ name: 'update_card_status', arguments: { id: newId, action: 'verify' } });
    expect(verifyResult.isError).toBeFalsy();

    const oldCard = await client.callTool({ name: 'get_card', arguments: { id: oldId } });
    const oldBody = JSON.parse((oldCard.content as Array<{ type: string; text: string }>)[0]!.text) as {
      card: { status: string; deprecation_reason?: string };
    };
    expect(oldBody.card.status).toBe('deprecated');
    expect(oldBody.card.deprecation_reason).toBe(`superseded by ${newId}`);
  });
});
