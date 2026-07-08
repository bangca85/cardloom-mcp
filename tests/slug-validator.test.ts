import { describe, it, expect } from 'vitest';
import { validateSlug } from '../src/utils/slug-validator';

describe('validateSlug', () => {
  // Valid cases
  it('should accept valid slugs with alphanumeric and hyphens', () => {
    expect(() => validateSlug('google-oauth-setup')).not.toThrow();
    expect(() => validateSlug('game-app-prd')).not.toThrow();
    expect(() => validateSlug('setup')).not.toThrow();
    expect(() => validateSlug('a')).not.toThrow();
  });

  // Invalid cases - empty
  it('should reject empty slugs', () => {
    expect(() => validateSlug('')).toThrow();
  });

  it('should reject hyphens-only slugs', () => {
    expect(() => validateSlug('-')).toThrow();
    expect(() => validateSlug('--')).toThrow();
    expect(() => validateSlug('---')).toThrow();
  });

  // Edge cases that should still be valid after normalization
  it('should accept single character slugs', () => {
    expect(() => validateSlug('a')).not.toThrow();
  });

  it('should accept slugs with numbers', () => {
    expect(() => validateSlug('game1')).not.toThrow();
    expect(() => validateSlug('app-1')).not.toThrow();
  });
});
