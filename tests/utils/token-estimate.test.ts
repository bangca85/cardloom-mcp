import { describe, it, expect } from 'vitest';
import { estimateToolJsonTokens } from '../../src/utils/token-estimate.js';

describe('estimateToolJsonTokens', () => {
  it('is the JSON length divided by four, rounded up', () => {
    expect(estimateToolJsonTokens('')).toBe(0);
    expect(estimateToolJsonTokens('abcd')).toBe(1);
    expect(estimateToolJsonTokens('abcde')).toBe(2);
    expect(estimateToolJsonTokens('x'.repeat(400))).toBe(100);
  });
});
