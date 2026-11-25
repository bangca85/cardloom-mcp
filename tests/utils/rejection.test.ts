import { describe, it, expect } from 'vitest';
import { REJECTED_PREFIX, isRejectionReason, isMergePromotion } from '../../src/utils/rejection.js';

describe('isRejectionReason', () => {
  it('exposes the prefix', () => {
    expect(REJECTED_PREFIX).toBe('rejected:');
  });

  it.each([
    ['rejected: duplicate of A', true],
    ['Rejected: wrong', true],
    ['REJECTED: shouting', true],
    ['   rejected: leading whitespace', true],
    ['\n\trejected: leading newline and tab', true],
    ['rejected:', true],
    ['superseded by a', false],
    ['not rejected: prefix only counts at the start', false],
    ['rejected without colon', false],
    ['reject: close but no', false],
    ['', false],
  ])('%j -> %s', (reason, expected) => {
    expect(isRejectionReason(reason)).toBe(expected);
  });

  it('is false for null and undefined', () => {
    expect(isRejectionReason(null)).toBe(false);
    expect(isRejectionReason(undefined)).toBe(false);
  });
});

describe('isMergePromotion', () => {
  it('is true when verification_method starts with merged:', () => {
    expect(isMergePromotion('merged:acme/app@abc1234 (pr #1 merged)')).toBe(true);
  });

  it('is false for other methods and empty values', () => {
    expect(isMergePromotion('chat-approval')).toBe(false);
    expect(isMergePromotion('manual-review merged:')).toBe(false);
    expect(isMergePromotion('')).toBe(false);
    expect(isMergePromotion(null)).toBe(false);
    expect(isMergePromotion(undefined)).toBe(false);
  });
});
