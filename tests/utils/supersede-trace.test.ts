import { describe, it, expect } from 'vitest';
import { parseSupersededBy } from '../../src/utils/supersede-trace.js';

describe('parseSupersededBy', () => {
  it('returns the successor id from the exact reason', () => {
    expect(parseSupersededBy('superseded by pattern-new')).toBe('pattern-new');
  });

  it('trims the reason before matching', () => {
    expect(parseSupersededBy('  superseded by pattern-new\n')).toBe('pattern-new');
  });

  it.each([
    ['superseded by'],
    ['superseded by a b'],
    ['superseded by pattern-new, see notes'],
    ['Superseded by pattern-new'],
    ['rejected: superseded by pattern-new'],
    ['outdated'],
    [''],
  ])('returns null for %j', (reason) => {
    expect(parseSupersededBy(reason)).toBeNull();
  });

  it('returns null for null and undefined', () => {
    expect(parseSupersededBy(null)).toBeNull();
    expect(parseSupersededBy(undefined)).toBeNull();
  });
});
