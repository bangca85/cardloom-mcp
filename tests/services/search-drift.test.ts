import { describe, it, expect } from 'vitest';
import { cardDriftsFor } from '../../src/services/search-service.js';

const card = (stack: string[], version_range: string, status = 'verified') => ({
  status,
  stack: JSON.stringify(stack),
  version_range,
});

describe('cardDriftsFor (the one drift rule, AD-10)', () => {
  it('is true when a shared tech version does not intersect the card range', () => {
    expect(cardDriftsFor(card(['node'], '^18.0.0'), ['node'], { node: '^20.0.0' })).toBe(true);
  });

  it('is false when the version intersects the range', () => {
    expect(cardDriftsFor(card(['node'], '>=18.0.0'), ['node'], { node: '^20.0.0' })).toBe(false);
  });

  it('is false for a wildcard range', () => {
    expect(cardDriftsFor(card(['node'], '*'), ['node'], { node: '20.1.0' })).toBe(false);
  });

  it('is false for a card that is not verified', () => {
    expect(cardDriftsFor(card(['node'], '^18.0.0', 'draft'), ['node'], { node: '^20.0.0' })).toBe(false);
    expect(cardDriftsFor(card(['node'], '^18.0.0', 'deprecated'), ['node'], { node: '^20.0.0' })).toBe(false);
  });

  it('is false when the tech is not in the caller stack or has no version', () => {
    expect(cardDriftsFor(card(['node'], '^18.0.0'), ['python'], { python: '3.12.0' })).toBe(false);
    expect(cardDriftsFor(card(['node'], '^18.0.0'), ['node'], {})).toBe(false);
  });

  it('is false for an unparseable stack column', () => {
    expect(cardDriftsFor({ status: 'verified', stack: 'not json', version_range: '^18.0.0' }, ['node'], { node: '20.0.0' })).toBe(false);
  });

  it('matches tags case and space insensitively', () => {
    expect(cardDriftsFor(card(['Next JS'], '>=14 <15'), ['next-js'], { 'next-js': '15.0.0' })).toBe(true);
  });
});
