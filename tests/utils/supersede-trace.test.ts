import { describe, it, expect } from 'vitest';
import { parseSupersededBy, resolveSupersededBy } from '../../src/utils/supersede-trace.js';

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

describe('resolveSupersededBy', () => {
  const cards: Record<string, string | null> = { 'pattern-new': 'pattern-old', 'pattern-other': null };
  const lookup = (id: string): string | null | undefined => cards[id];

  it('returns the successor when it exists and declares supersedes = the card', () => {
    expect(resolveSupersededBy('pattern-old', 'superseded by pattern-new', lookup)).toBe('pattern-new');
  });

  it('returns null when the successor is missing, declares nothing, or declares another card', () => {
    expect(resolveSupersededBy('pattern-old', 'superseded by pattern-typo', lookup)).toBeNull();
    expect(resolveSupersededBy('pattern-old', 'superseded by pattern-other', lookup)).toBeNull();
    expect(resolveSupersededBy('pattern-x', 'superseded by pattern-new', lookup)).toBeNull();
  });

  it('returns null for a reason that does not parse, without calling the lookup', () => {
    const never = (): never => {
      throw new Error('lookup must not run');
    };
    expect(resolveSupersededBy('pattern-old', 'obsolete', never)).toBeNull();
    expect(resolveSupersededBy('pattern-old', null, never)).toBeNull();
  });
});
