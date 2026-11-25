import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { buildFreshIndex } from '../../src/cli/benchmark.js';
import { loadTasks } from '../../eval/tasks.js';
import {
  ToolNotAllowedError,
  buildPrompts,
  createToolBox,
  listEligibleCards,
  loadRepoContext,
  loadToolSpecs,
  renderEligibleCards,
  type RepoContext,
  type ToolBoxOptions,
} from '../../eval/toolbox.js';
import type { ToolSpec } from '../../eval/types.js';

const evalDir = path.resolve(import.meta.dirname, '../../eval');
const storeDir = path.join(evalDir, 'fixtures/store');
const reposDir = path.join(evalDir, 'fixtures/repos');

let db: Database.Database;
let specs: ToolSpec[];
let notify: RepoContext;
let ledger: RepoContext;

beforeAll(async () => {
  db = await buildFreshIndex(storeDir);
  specs = await loadToolSpecs(db, storeDir);
  notify = loadRepoContext('fixture/notify-worker', reposDir);
  ledger = loadRepoContext('fixture/ledger-api', reposDir);
});
afterAll(() => db.close());

const opts = (over: Partial<ToolBoxOptions> = {}): ToolBoxOptions => ({
  mode: 'search_then_get',
  context: notify,
  specs,
  ...over,
});

const parse = (text: string) => JSON.parse(text) as Record<string, any>;

describe('synthetic fixtures', () => {
  it('has 8 seed tasks, every required card exists and is visible to default search', () => {
    const tasks = loadTasks(path.join(evalDir, 'tasks/tasks.yaml'));
    expect(tasks).toHaveLength(8);
    for (const t of tasks) {
      for (const id of t.required_cards) {
        const row = db.prepare('SELECT status, sensitivity FROM cards WHERE id = ?').get(id) as { status: string; sensitivity: string } | undefined;
        expect(row, `${t.id} -> ${id}`).toBeDefined();
        expect(row).toMatchObject({ status: 'verified', sensitivity: 'normal' });
      }
    }
  });

  it('keeps the gotcha exception beyond the first 600 characters, so a compact fetch cannot see it', () => {
    const body = (db.prepare('SELECT body FROM cards WHERE id = ?').get('gotcha-ledger-month-end-close-lock-hang') as { body: string }).body;
    expect(body.indexOf('statement_timeout')).toBeGreaterThan(600);
    const compact = parse(createToolBox(db, opts({ context: ledger })).call('get_card', { id: 'gotcha-ledger-month-end-close-lock-hang', compact: true }).text);
    expect(compact.card.truncated).toBe(true);
    expect(compact.card.body).not.toContain('statement_timeout');
  });

  it('has a related-only search for the TLS task (no direct match)', () => {
    const box = createToolBox(db, opts());
    const out = parse(box.call('search_knowledge', { query: 'rotate TLS certificates notify-worker' }).text);
    expect(out.results.length).toBeGreaterThan(0);
    expect(out.no_direct_match).toBe(true);
  });

  it('hides the draft and the deprecated card from default search', () => {
    const box = createToolBox(db, opts());
    const dedupe = parse(box.call('search_knowledge', { query: 'dedupe window notification' }).text);
    const ids = dedupe.results.map((r: { id: string }) => r.id);
    expect(ids).toContain('decision-notify-dedupe-window-ten-minutes');
    expect(ids).not.toContain('decision-notify-dedupe-window-one-day');
    const lb = createToolBox(db, opts({ context: ledger }));
    const pag = parse(lb.call('search_knowledge', { query: 'list endpoints pagination' }).text);
    const pids = pag.results.map((r: { id: string }) => r.id);
    expect(pids).toContain('decision-ledger-list-endpoints-cursor-pagination');
    expect(pids).not.toContain('decision-ledger-list-endpoints-offset-pagination');
  });
});

describe('loadToolSpecs', () => {
  it('exposes only search_knowledge and get_card, taken from the real server, without visibility overrides', () => {
    expect(specs.map((s) => s.name).sort()).toEqual(['get_card', 'search_knowledge']);
    const search = specs.find((s) => s.name === 'search_knowledge')!;
    const props = Object.keys((search.input_schema as { properties: object }).properties);
    expect(props).toEqual(expect.arrayContaining(['query', 'context', 'limit']));
    expect(props.some((p) => p.startsWith('include_'))).toBe(false);
    const get = specs.find((s) => s.name === 'get_card')!;
    expect(Object.keys((get.input_schema as { properties: object }).properties)).toEqual(expect.arrayContaining(['id', 'compact']));
    expect(search.description).toContain('write_back_reminder');
  });
});

describe('ToolBox per mode', () => {
  it('top5 offers only search_knowledge and rejects get_card', () => {
    const box = createToolBox(db, opts({ mode: 'top5' }));
    expect(box.specs.map((s) => s.name)).toEqual(['search_knowledge']);
    expect(() => box.call('get_card', { id: 'x' })).toThrow(ToolNotAllowedError);
  });

  it('search_then_get offers both and rejects anything else', () => {
    const box = createToolBox(db, opts());
    expect(box.specs.map((s) => s.name).sort()).toEqual(['get_card', 'search_knowledge']);
    expect(() => box.call('report_card_usage', {})).toThrow(ToolNotAllowedError);
  });

  it('read_all exposes no tools at all', () => {
    const box = createToolBox(db, opts({ mode: 'read_all' }));
    expect(box.specs).toEqual([]);
    expect(() => box.call('search_knowledge', { query: 'x' })).toThrow(ToolNotAllowedError);
  });

  it('forces limit 5 and default visibility, ignoring include_* and a larger limit', () => {
    const box = createToolBox(db, opts());
    const out = parse(box.call('search_knowledge', { query: 'notify node', limit: 50, include_drafts: true, include_deprecated: true, include_restricted: true }).text);
    expect(out.results.length).toBeLessThanOrEqual(5);
    expect(out.results.every((r: { status: string }) => r.status === 'verified')).toBe(true);
  });

  it('returns the real handler JSON for get_card and a typed error result for a missing card', () => {
    const box = createToolBox(db, opts());
    const ok = box.call('get_card', { id: 'decision-notify-dedupe-window-ten-minutes' });
    expect(ok.isError).toBe(false);
    expect(parse(ok.text).card.title).toBe('Notification dedupe window is ten minutes');
    const missing = box.call('get_card', { id: 'nope' });
    expect(missing.isError).toBe(true);
    expect(parse(missing.text).error.code).toBe('not_found');
  });

  it('tracks seen matches, seen cards and re-fetches', () => {
    const box = createToolBox(db, opts());
    box.call('search_knowledge', { query: 'dedupe window notification' });
    box.call('get_card', { id: 'decision-notify-dedupe-window-ten-minutes', compact: true });
    box.call('get_card', { id: 'decision-notify-dedupe-window-ten-minutes' });
    const s = box.stats();
    expect(s.calls).toBe(3);
    expect(s.seenMatches.length).toBeGreaterThan(0);
    expect(s.seenCards).toContain('decision-notify-dedupe-window-ten-minutes');
    expect(s.getCardCalls).toBe(2);
    expect(s.refetchCalls).toBe(1);
    expect(s.refetchChars).toBeGreaterThan(0);
  });

  it('the compact variant defaults get_card to compact but lets the agent ask for the full card', () => {
    const box = createToolBox(db, opts({ context: ledger, getCardDefault: 'compact' }));
    const id = 'gotcha-ledger-month-end-close-lock-hang';
    expect(parse(box.call('get_card', { id }).text).card.truncated).toBe(true);
    expect(parse(box.call('get_card', { id, compact: false }).text).card.body).toContain('statement_timeout');
  });
});

describe('read_all prompt', () => {
  it('lists exactly the eligible cards of the repo: verified, normal, project match or stack/global overlap', () => {
    expect(listEligibleCards(db, notify)).toEqual([
      'decision-notify-dedupe-window-ten-minutes',
      'pattern-notify-retry-exponential-backoff-dead-letter',
      'pattern-queue-consumer-drain-on-sigterm',
      'playbook-notify-rotate-webhook-signing-secret',
    ]);
    expect(listEligibleCards(db, ledger)).toEqual([
      'decision-ledger-list-endpoints-cursor-pagination',
      'decision-ledger-store-amounts-as-integer-minor-units',
      'gotcha-ledger-entry-out-of-order',
      'gotcha-ledger-month-end-close-lock-hang',
      'pattern-ledger-idempotency-key-on-posts',
      'pattern-queue-consumer-drain-on-sigterm',
    ]);
  });

  it('puts every eligible card, and nothing else, in the prompt', () => {
    const task = loadTasks(path.join(evalDir, 'tasks/tasks.yaml')).find((t) => t.id === 'notify-dedupe-draft-conflict')!;
    const ids = listEligibleCards(db, notify);
    const { prompt, system } = buildPrompts({ task, mode: 'read_all', context: notify, cards: renderEligibleCards(db, ids) });
    for (const id of ids) expect(prompt).toContain(`"id":"${id}"`);
    expect(prompt).not.toContain('decision-notify-dedupe-window-one-day');
    expect(prompt).not.toContain('gotcha-ledger');
    expect(prompt).toContain(task.prompt);
    expect(system).toContain('no direct answer');
  });

  it('tool modes tell the agent the repo context and carry no card bodies', () => {
    const task = loadTasks(path.join(evalDir, 'tasks/tasks.yaml'))[0]!;
    const { prompt } = buildPrompts({ task, mode: 'top5', context: ledger });
    expect(prompt).toContain('fixture/ledger-api');
    expect(prompt).toContain('postgres@16');
    expect(prompt).not.toContain('amount_minor');
  });
});

describe('pinned clock', () => {
  afterEach(() => vi.useRealTimers());

  // Everything an agent can see in one fixed sequence of tool calls plus the read_all rendering.
  function transcript(): string[] {
    const search = createToolBox(db, opts({ context: ledger, mode: 'search_then_get' }));
    return [
      search.call('search_knowledge', { query: 'month-end close lock timeout' }).text,
      search.call('get_card', { id: 'gotcha-ledger-month-end-close-lock-hang' }).text,
      search.call('get_card', { id: 'gotcha-ledger-month-end-close-lock-hang', compact: true }).text,
      ...renderEligibleCards(db, listEligibleCards(db, ledger)),
    ];
  }

  it('gives byte-identical tool output under two different system clocks', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-12-01T00:00:00.000Z'));
    const early = transcript();
    vi.setSystemTime(new Date('2028-06-01T00:00:00.000Z')); // far past the 180-day stale threshold
    const late = transcript();
    expect(late).toEqual(early);
    expect(late.join('')).not.toContain('"stale":true');
  });

  it('is the injected now, not the pinned one, that tests can change', () => {
    const base = parse(createToolBox(db, opts({ context: ledger })).call('get_card', { id: 'gotcha-ledger-entry-out-of-order' }).text);
    const later = parse(createToolBox(db, opts({ context: ledger, now: new Date('2028-06-01T00:00:00.000Z') })).call('get_card', { id: 'gotcha-ledger-entry-out-of-order' }).text);
    expect(base.card.flags?.stale).toBeUndefined();
    expect(later.card.flags?.stale).toBe(true);
  });
});
