import { describe, it, expect } from 'vitest';
import {
  TIER_RANK,
  normalizeForMatch,
  containsAtBoundary,
  extractIdentifiers,
  classifyMatch,
} from '../../src/utils/match-tier.js';

const sig = (s: string) => ({ title: 't', error_signature: s });

describe('classifyMatch', () => {
  it.each([
    ['Error: ERR-42 at line 8', 'ERR-42', 'exact_signature'],
    ['Error: ERR-42 at line 8', 'ERR_42', 'all_terms'],
    ['Error: ERR-42 at line 8', 'ERR-420', 'all_terms'],
    ['(ERR-42)', 'ERR-42', 'exact_signature'],
    ['err-42', 'ERR-42', 'exact_signature'],
    ['C++', 'C#', 'all_terms'],
    [
      'connect ECONNREFUSED 127.0.0.1:5432 at TCPConnectWrap',
      'ECONNREFUSED 127.0.0.1:5432',
      'exact_signature',
    ],
    [
      'at /Users/dev/app/server.start_failed/handler.ts:10:5',
      'server.start_failed',
      'exact_signature',
    ],
    [
      'I keep getting “AccessDeniedException” on deploy',
      'AccessDeniedException: Access was denied (www-authenticate header)',
      'exact_identifier',
    ],
  ])('classifyMatch(%s, sig=%s) = %s', (q, s, tier) => {
    expect(classifyMatch(q, sig(s), true)).toBe(tier);
  });

  it('generic words never produce an exact tier (Review Focus 5)', () => {
    expect(
      classifyMatch(
        'error timeout failed',
        sig('Error: request timeout after 30s, upload failed'),
        false,
      ),
    ).toBe('related');
    expect(extractIdentifiers('ERROR: something FAILED')).toEqual([]);
  });

  it('query contained in signature is not exact (one-directional)', () => {
    expect(
      classifyMatch('timeout', sig('Gateway timeout when calling payments API'), true),
    ).toBe('all_terms');
  });

  it('exact_title needs the whole title', () => {
    expect(
      classifyMatch(
        '  Retry  With BACKOFF ',
        { title: 'Retry with backoff', error_signature: null },
        true,
      ),
    ).toBe('exact_title');
    expect(
      classifyMatch('retry with', { title: 'Retry with backoff', error_signature: null }, true),
    ).toBe('all_terms');
  });
});

describe('helpers', () => {
  it('TIER_RANK orders exact < all_terms < related', () => {
    expect(TIER_RANK.exact_signature).toBe(0);
    expect(TIER_RANK.exact_identifier).toBe(0);
    expect(TIER_RANK.exact_title).toBe(0);
    expect(TIER_RANK.all_terms).toBe(1);
    expect(TIER_RANK.related).toBe(2);
  });

  it('normalizeForMatch lowercases, collapses whitespace, maps smart quotes', () => {
    expect(normalizeForMatch('  Foo \t\n BAR ')).toBe('foo bar');
    expect(normalizeForMatch('‘a’ “b” `c`')).toBe('\'a\' "b" \'c\'');
  });

  it('containsAtBoundary rejects empty needle and embedded matches', () => {
    expect(containsAtBoundary('abc', '')).toBe(false);
    expect(containsAtBoundary('err-420', 'err-42')).toBe(false);
    expect(containsAtBoundary('(err-42)', 'err-42')).toBe(true);
    expect(containsAtBoundary('xerr-42', 'err-42')).toBe(false);
    expect(containsAtBoundary('err-42', 'err-42')).toBe(true);
  });

  it('extractIdentifiers lowercases and de-duplicates', () => {
    expect(extractIdentifiers('AccessDeniedException then AccessDeniedException')).toEqual([
      'accessdeniedexception',
    ]);
    expect(extractIdentifiers('got foo_bar from Foo_Bar')).toEqual(['foo_bar']);
  });
});
