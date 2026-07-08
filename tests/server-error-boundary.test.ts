import { describe, it, expect, vi } from 'vitest';
import { mcpError, withErrorBoundary } from '../src/server';
import { NotFoundError, ConflictError, ValidationError } from '../src/types/errors';

function parseBody(result: { content: Array<{ type: 'text'; text: string }>; isError: true }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe('mcpError (server boundary)', () => {
  it('maps a typed KnowledgeError to {error: {code, message}} with isError true', () => {
    const result = mcpError(new NotFoundError('pattern-missing'));
    expect(result.isError).toBe(true);
    const body = parseBody(result);
    expect(body['error']).toMatchObject({ code: 'not_found' });
    expect((body['error'] as Record<string, unknown>)['message']).toContain('pattern-missing');
  });

  it('includes details for ConflictError with the full FR14 payload', () => {
    const result = mcpError(
      new ConflictError({
        conflicting_card_id: 'pattern-existing',
        diff_summary: 'same type=pattern, stack ∩ [node]',
        options: ['supersede', 'scope-split'],
      }),
    );
    const body = parseBody(result);
    const error = body['error'] as { code: string; details: unknown };
    expect(error.code).toBe('conflict');
    expect(error.details).toEqual({
      conflicting_card_id: 'pattern-existing',
      diff_summary: 'same type=pattern, stack ∩ [node]',
      options: ['supersede', 'scope-split'],
    });
  });

  it('includes details for ValidationError as a list of {field, message}', () => {
    const result = mcpError(new ValidationError([{ field: 'stack', message: 'Required' }]));
    const body = parseBody(result);
    const error = body['error'] as { code: string; details: unknown };
    expect(error.code).toBe('validation_error');
    expect(error.details).toEqual([{ field: 'stack', message: 'Required' }]);
  });

  it('maps an unknown error to a generic message without a code, and logs the stack to stderr', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const weirdBug = new Error('some internal implementation detail leaked here');

    const result = mcpError(weirdBug);
    const body = parseBody(result);

    expect(body['error']).toEqual({ message: 'Internal server error' });
    expect(JSON.stringify(body)).not.toContain('implementation detail');
    expect(errorSpy).toHaveBeenCalledWith('[server] unhandled:', weirdBug);

    errorSpy.mockRestore();
  });

  it('never assigns unknown errors one of the 5 fixed codes', () => {
    const result = mcpError(new Error('boom'));
    const body = parseBody(result);
    expect((body['error'] as Record<string, unknown>)['code']).toBeUndefined();
  });
});

describe('withErrorBoundary', () => {
  it('passes through the handler result on success', async () => {
    const handler = withErrorBoundary(async (x: number) => x * 2);
    await expect(handler(21)).resolves.toBe(42);
  });

  it('catches a thrown typed error and maps it through mcpError', async () => {
    const handler = withErrorBoundary(() => {
      throw new NotFoundError('card-x');
    });

    const result = await handler();
    const body = parseBody(result as { content: Array<{ type: 'text'; text: string }>; isError: true });
    expect((body['error'] as Record<string, unknown>)['code']).toBe('not_found');
  });
});
