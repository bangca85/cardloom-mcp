import { describe, it, expect } from 'vitest';
import { titleSimilarity } from '../../src/utils/title-similarity.js';

describe('titleSimilarity', () => {
  it('ignores case, order and punctuation', () => {
    expect(titleSimilarity('Use WAL mode in SQLite', 'SQLite: use WAL mode')).toBe(1);
  });

  it('is 0 when either side has no usable tokens', () => {
    expect(titleSimilarity('a', '')).toBe(0);
    expect(titleSimilarity('', 'retries')).toBe(0);
    expect(titleSimilarity('a b c', 'a b c')).toBe(0);
  });

  it('is the Jaccard overlap of the token sets', () => {
    expect(
      titleSimilarity('Enable retries for payment requests', 'Disable retries for payment requests'),
    ).toBeCloseTo(4 / 6, 5);
  });

  it('handles non-ASCII letters', () => {
    expect(titleSimilarity('Đặt giờ chạy', 'giờ chạy đặt')).toBe(1);
  });
});
