import { describe, it, expect } from 'vitest';
import { AnthropicApiError, AnthropicRunner, MAX_TOOL_CALLS } from '../../eval/anthropic-runner.js';
import { ToolNotAllowedError } from '../../eval/toolbox.js';
import type { EvalTask, ToolBox, ToolResult, ToolSpec } from '../../eval/types.js';

const task: EvalTask = { id: 't', prompt: 'p', repo: 'fixture/ledger-api', required_cards: [], rubric: [] };
const specs: ToolSpec[] = [
  { name: 'search_knowledge', description: 'search', input_schema: { type: 'object', properties: { query: { type: 'string' } } } },
];

function fakeTools(handler: (name: string, args: unknown) => ToolResult = () => ({ text: '{"results":[]}', isError: false }), withSpecs = true): ToolBox & { calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    specs: withSpecs ? specs : [],
    call(name, args) {
      calls.push([name, args]);
      return handler(name, args);
    },
    stats: () => ({ calls: calls.length, seenMatches: [], seenCards: [], getCardCalls: 0, refetchCalls: 0, refetchChars: 0 }),
  };
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const toolUse = (id: string, input: unknown, usage = { input_tokens: 100, output_tokens: 20 }) =>
  json({ stop_reason: 'tool_use', content: [{ type: 'text', text: 'looking' }, { type: 'tool_use', id, name: 'search_knowledge', input }], usage });
const endTurn = (text: string, usage = { input_tokens: 150, output_tokens: 30 }) =>
  json({ stop_reason: 'end_turn', content: [{ type: 'text', text }], usage });

type Call = { url: string; init: RequestInit; body: any };
function scriptedFetch(responses: Array<Response | (() => Response)>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body)) });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return typeof r === 'function' ? r() : r.clone();
  }) as typeof fetch;
  return { fetch: f, calls };
}

const input = (tools: ToolBox, mode: 'top5' | 'read_all' = 'top5') => ({ task, mode, model: 'test-model', tools, prompt: 'the prompt', system: 'the system' });

describe('AnthropicRunner (injected fetch only)', () => {
  it('runs a tool_use turn then an end_turn, sums API usage and answers with the final text', async () => {
    const { fetch, calls } = scriptedFetch([toolUse('tu_1', { query: 'x' }), endTurn('final answer')]);
    const tools = fakeTools(() => ({ text: 'TOOL-RESULT-JSON', isError: false }));
    const runner = new AnthropicRunner({ apiKey: 'sk-test-key', fetch });
    const out = await runner.run(input(tools));

    expect(out.answer).toBe('final answer');
    expect(out.tokens).toBe(100 + 20 + 150 + 30);
    expect(out.toolCalls).toBe(1);
    expect(out.capped).toBeFalsy();
    expect(out.latencyMs).toBeGreaterThanOrEqual(0);
    expect(tools.calls).toEqual([['search_knowledge', { query: 'x' }]]);

    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test-key');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.body).toMatchObject({ model: 'test-model', system: 'the system', messages: [{ role: 'user', content: 'the prompt' }] });
    expect(calls[0]!.body.tools).toEqual([{ name: 'search_knowledge', description: 'search', input_schema: specs[0]!.input_schema }]);

    const second = calls[1]!.body.messages;
    expect(second[1]).toMatchObject({ role: 'assistant' });
    expect(second[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'TOOL-RESULT-JSON' }] });
  });

  it('sends no tools field when the tool box has none (read_all)', async () => {
    const { fetch, calls } = scriptedFetch([endTurn('a')]);
    await new AnthropicRunner({ apiKey: 'k', fetch }).run(input(fakeTools(undefined, false), 'read_all'));
    expect('tools' in calls[0]!.body).toBe(false);
  });

  it('feeds a rejected or failing tool call back as an is_error tool_result and carries on', async () => {
    const { fetch, calls } = scriptedFetch([toolUse('tu_1', {}), endTurn('done')]);
    const tools = fakeTools(() => {
      throw new ToolNotAllowedError('get_card', 'top5');
    });
    const out = await new AnthropicRunner({ apiKey: 'k', fetch }).run(input(tools));
    expect(out.answer).toBe('done');
    expect(out.toolCalls).toBe(1);
    const block = calls[1]!.body.messages[2].content[0];
    expect(block).toMatchObject({ type: 'tool_result', tool_use_id: 'tu_1', is_error: true });
    expect(block.content).toContain('get_card');
  });

  it('marks an is_error result from the tool box as is_error', async () => {
    const { fetch, calls } = scriptedFetch([toolUse('tu_1', {}), endTurn('done')]);
    const tools = fakeTools(() => ({ text: '{"error":{"code":"not_found"}}', isError: true }));
    await new AnthropicRunner({ apiKey: 'k', fetch }).run(input(tools));
    expect(calls[1]!.body.messages[2].content[0].is_error).toBe(true);
  });

  it('rejects with the status and message of an API error response, never echoing the key', async () => {
    const { fetch } = scriptedFetch([json({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 429)]);
    const p = new AnthropicRunner({ apiKey: 'sk-secret-123', fetch }).run(input(fakeTools()));
    await expect(p).rejects.toBeInstanceOf(AnthropicApiError);
    await expect(p).rejects.toMatchObject({ status: 429 });
    await expect(p).rejects.toThrow(/429.*slow down/);
    await p.catch((e: Error) => expect(String(e.message)).not.toContain('sk-secret-123'));
  });

  it('survives a non-JSON error body', async () => {
    const { fetch } = scriptedFetch([new Response('upstream exploded', { status: 502 })]);
    await expect(new AnthropicRunner({ apiKey: 'k', fetch }).run(input(fakeTools()))).rejects.toThrow(/502/);
  });

  it('stops after the tool-call cap, answers with the text so far and marks the run capped', async () => {
    const { fetch, calls } = scriptedFetch([() => toolUse('tu_n', { query: 'again' })]);
    const tools = fakeTools();
    const out = await new AnthropicRunner({ apiKey: 'k', fetch }).run(input(tools));
    expect(MAX_TOOL_CALLS).toBe(8);
    expect(out.capped).toBe(true);
    expect(out.toolCalls).toBe(8);
    expect(tools.calls).toHaveLength(8);
    expect(calls).toHaveLength(9); // the 9th response asked for a 9th call, which is refused
    expect(out.tokens).toBe(9 * 120);
    expect(out.answer).toContain('looking');
  });

  it('refuses to run without a model', async () => {
    const { fetch } = scriptedFetch([endTurn('a')]);
    await expect(new AnthropicRunner({ apiKey: 'k', fetch }).run({ ...input(fakeTools()), model: '' })).rejects.toThrow(/model/i);
  });
});
