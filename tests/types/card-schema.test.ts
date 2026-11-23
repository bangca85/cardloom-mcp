import { describe, it, expect, vi } from 'vitest';
import {
  validateCardStrict,
  validateCardLenient,
} from '../../src/types/card-schema';
import { ValidationError, type ValidationIssue } from '../../src/types/errors';

function validDraftCard(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'pattern',
    scope: 'project',
    applies_to: ['api'],
    stack: ['node'],
    version_range: '>=1.0.0',
    sensitivity: 'normal',
    source_commit: 'abc123',
    provenance: 'agent-observation',
    title: 'Use X pattern',
    status: 'draft',
    ...overrides,
  };
}

describe('validateCardStrict', () => {
  it('rejects a card missing a required field (stack) and lists the field', () => {
    const card = validDraftCard();
    delete card.stack;

    let error: ValidationError | undefined;
    try {
      validateCardStrict(card);
    } catch (e) {
      error = e as ValidationError;
    }

    expect(error).toBeInstanceOf(ValidationError);
    expect((error!.details as ValidationIssue[]).some((i) => i.field === 'stack')).toBe(true);
  });

  it('rejects a gotcha card missing error_signature', () => {
    const card = validDraftCard({ type: 'gotcha' });

    let error: ValidationError | undefined;
    try {
      validateCardStrict(card);
    } catch (e) {
      error = e as ValidationError;
    }

    expect(error).toBeInstanceOf(ValidationError);
    expect((error!.details as ValidationIssue[]).some((i) => i.field === 'error_signature')).toBe(true);
  });

  it('accepts a gotcha card that has error_signature', () => {
    const card = validDraftCard({ type: 'gotcha', error_signature: 'TypeError: x is not a function' });
    const result = validateCardStrict(card);
    expect(result.type).toBe('gotcha');
  });

  it('passes a draft card with verified_by/verification_method/last_verified all null', () => {
    const card = validDraftCard({
      verified_by: null,
      verification_method: null,
      last_verified: null,
    });

    const result = validateCardStrict(card);
    expect(result.status).toBe('draft');
  });

  it('passes a draft card that omits verify fields entirely (default null)', () => {
    const card = validDraftCard();
    const result = validateCardStrict(card);
    expect(result.status).toBe('draft');
    if (result.status === 'draft') {
      expect(result.verified_by).toBeNull();
    }
  });

  it('rejects a verified card missing verified_by', () => {
    const card = validDraftCard({
      status: 'verified',
      verification_method: 'manual-review',
      last_verified: '2026-07-05T00:00:00Z',
    });

    let error: ValidationError | undefined;
    try {
      validateCardStrict(card);
    } catch (e) {
      error = e as ValidationError;
    }

    expect(error).toBeInstanceOf(ValidationError);
  });

  it('rejects a verified card with null last_verified', () => {
    const card = validDraftCard({
      status: 'verified',
      verified_by: 'bradley',
      verification_method: 'manual-review',
      last_verified: null,
    });

    expect(() => validateCardStrict(card)).toThrow(ValidationError);
  });

  it('accepts a verified card with all verify fields populated', () => {
    const card = validDraftCard({
      status: 'verified',
      verified_by: 'bradley',
      verification_method: 'manual-review',
      last_verified: '2026-07-05T00:00:00Z',
    });

    const result = validateCardStrict(card);
    expect(result.status).toBe('verified');
  });

  it('rejects a deprecated card missing deprecation_reason/deprecated_at/deprecated_by', () => {
    const card = validDraftCard({ status: 'deprecated' });

    let error: ValidationError | undefined;
    try {
      validateCardStrict(card);
    } catch (e) {
      error = e as ValidationError;
    }

    expect(error).toBeInstanceOf(ValidationError);
    const fields = (error!.details as ValidationIssue[]).map((i) => i.field);
    expect(fields).toEqual(
      expect.arrayContaining(['deprecation_reason', 'deprecated_at', 'deprecated_by'])
    );
  });

  it('accepts a deprecated card with deprecation fields populated', () => {
    const card = validDraftCard({
      status: 'deprecated',
      deprecation_reason: 'superseded by pattern-x-v2',
      deprecated_at: '2026-07-05T00:00:00Z',
      deprecated_by: 'bradley',
    });

    const result = validateCardStrict(card);
    expect(result.status).toBe('deprecated');
  });

  it('rejects unknown top-level fields (strict mode)', () => {
    const card = validDraftCard({ some_random_field: 'oops' });
    expect(() => validateCardStrict(card)).toThrow(ValidationError);
  });
});

describe('project key', () => {
  it('accepts a project key on a project-scoped card and rejects it on stack scope', () => {
    const ok = validateCardStrict(validDraftCard({ project: 'acme/billing-api' }));
    expect(ok.project).toBe('acme/billing-api');

    let error: ValidationError | undefined;
    try {
      validateCardStrict(validDraftCard({ scope: 'stack', project: 'acme/billing-api' }));
    } catch (e) {
      error = e as ValidationError;
    }
    expect(error).toBeInstanceOf(ValidationError);
    expect(error!.details as ValidationIssue[]).toContainEqual({
      field: 'project',
      message: 'project is only allowed when scope is "project"',
    });
  });

  it('rejects absolute paths as project keys', () => {
    let error: ValidationError | undefined;
    try {
      validateCardStrict(validDraftCard({ project: '/Users/me/app' }));
    } catch (e) {
      error = e as ValidationError;
    }
    expect(error).toBeInstanceOf(ValidationError);
    expect((error!.details as ValidationIssue[]).some((i) => i.field === 'project')).toBe(true);
  });

  it('keeps project optional', () => {
    expect(validateCardStrict(validDraftCard()).project).toBeUndefined();
  });
});

describe('validateCardLenient', () => {
  it('strips counters from frontmatter and warns, while keeping unknown fields', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const card = validDraftCard({
      usage: 42,
      success: 10,
      failure: 2,
      counters: { foo: 1 },
      hand_written_note: 'kept as-is',
    });

    const result = validateCardLenient(card);

    expect((result.card as Record<string, unknown>).usage).toBeUndefined();
    expect((result.card as Record<string, unknown>).success).toBeUndefined();
    expect((result.card as Record<string, unknown>).failure).toBeUndefined();
    expect((result.card as Record<string, unknown>).counters).toBeUndefined();
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.unknownFields.hand_written_note).toBe('kept as-is');
    expect((result.card as Record<string, unknown>).hand_written_note).toBe('kept as-is');
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it('defaults missing status to draft', () => {
    const card = validDraftCard();
    delete card.status;

    const result = validateCardLenient(card);
    expect(result.card.status).toBe('draft');
    expect(result.warnings.some((w) => w.includes('status'))).toBe(true);
  });

  it('coerces a string stack/applies_to into a single-element array', () => {
    const card = validDraftCard({ stack: 'node', applies_to: 'api' });

    const result = validateCardLenient(card);
    expect(result.card.stack).toEqual(['node']);
    expect(result.card.applies_to).toEqual(['api']);
  });

  it('drops an invalid project with a warning instead of failing', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = validateCardLenient(validDraftCard({ project: '/Users/me/app' }));
    expect(result.card.project).toBeUndefined();
    expect(result.warnings.some((w) => w.includes('project'))).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[card-schema]'));
    errorSpy.mockRestore();
  });

  it('drops a project on a non-project-scoped card with a warning', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = validateCardLenient(validDraftCard({ scope: 'global', project: 'acme/billing-api' }));
    expect(result.card.project).toBeUndefined();
    expect(result.warnings.some((w) => w.includes('project'))).toBe(true);
    errorSpy.mockRestore();
  });

  it('keeps a valid project on a project-scoped card', () => {
    const result = validateCardLenient(validDraftCard({ project: 'acme/billing-api' }));
    expect(result.card.project).toBe('acme/billing-api');
    expect(result.warnings).toEqual([]);
  });
});
