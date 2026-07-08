import { describe, it, expect } from 'vitest';
import {
  NotFoundError,
  ValidationError,
  SecretDetectedError,
  InvalidTransitionError,
  ConflictError,
  KnowledgeError,
} from '../../src/types/errors';

describe('typed error classes', () => {
  it('NotFoundError carries code not_found', () => {
    const err = new NotFoundError('pattern-missing');
    expect(err).toBeInstanceOf(KnowledgeError);
    expect(err.code).toBe('not_found');
    expect(err.message).toContain('pattern-missing');
  });

  it('ValidationError carries code validation_error with field/message details', () => {
    const err = new ValidationError([{ field: 'stack', message: 'Required' }]);
    expect(err.code).toBe('validation_error');
    expect(err.details).toEqual([{ field: 'stack', message: 'Required' }]);
  });

  it('SecretDetectedError carries code secret_detected and keeps the sanitize hint', () => {
    const err = new SecretDetectedError('AWS Access Key pattern found');
    expect(err.code).toBe('secret_detected');
    expect(err.message).toContain('Please sanitize content and retry');
  });

  it('InvalidTransitionError carries code invalid_transition with valid transitions listed', () => {
    const err = new InvalidTransitionError('deprecated', 'verify', ['draft->verified', 'draft->deprecated']);
    expect(err.code).toBe('invalid_transition');
    expect(err.details).toEqual({
      from: 'deprecated',
      action: 'verify',
      validTransitions: ['draft->verified', 'draft->deprecated'],
    });
  });

  it('ConflictError carries code conflict with full FR14 payload', () => {
    const err = new ConflictError({
      conflicting_card_id: 'pattern-existing',
      diff_summary: 'same type=pattern, stack ∩ [node]',
      options: ['supersede', 'scope-split'],
    });
    expect(err.code).toBe('conflict');
    expect(err.details).toEqual({
      conflicting_card_id: 'pattern-existing',
      diff_summary: 'same type=pattern, stack ∩ [node]',
      options: ['supersede', 'scope-split'],
    });
  });
});
