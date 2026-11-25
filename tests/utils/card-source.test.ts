import { describe, it, expect } from 'vitest';
import { cardSource } from '../../src/utils/card-source.js';

const base = { applies_to: ['api'], source_commit: 'abc123', last_verified: null };

describe('cardSource', () => {
  it('carries source_repo, the 7-character sha and the date part of last_verified', () => {
    expect(
      cardSource({
        source_repo: 'acme/billing',
        applies_to: ['api'],
        source_commit: '9f1c2ab0 (story 5.26)',
        last_verified: '2026-10-03T08:15:00.000Z',
      }),
    ).toEqual({ repo: 'acme/billing', commit: '9f1c2ab', approved_at: '2026-10-03' });
  });

  it('falls back to the first applies_to entry when source_repo is not set and that entry looks like owner/name', () => {
    expect(cardSource({ ...base, applies_to: ['acme/payments', 'api'] }).repo).toBe('acme/payments');
    expect(cardSource({ ...base, source_repo: null, applies_to: ['acme/billing'] }).repo).toBe('acme/billing');
  });

  it('has repo null when the first applies_to entry is a component name, not a repo', () => {
    expect(cardSource({ ...base, applies_to: ['api'] }).repo).toBeNull();
    expect(cardSource({ ...base, applies_to: ['node', 'acme/billing'] }).repo).toBeNull();
    expect(cardSource({ ...base, applies_to: ['not a/repo'] }).repo).toBeNull();
  });

  it('prefers source_repo over applies_to', () => {
    expect(cardSource({ ...base, source_repo: 'acme/billing', applies_to: ['acme/payments'] }).repo).toBe('acme/billing');
  });

  it('has repo null when neither source_repo nor applies_to exists', () => {
    expect(cardSource({ ...base, applies_to: [] }).repo).toBeNull();
  });

  it('has approved_at null for a draft (last_verified null)', () => {
    expect(cardSource({ ...base, source_commit: '9f1c2ab0' }).approved_at).toBeNull();
  });

  it('accepts an all-digit abbreviation by the extractSha rules, preferring a mixed token', () => {
    expect(cardSource({ ...base, source_commit: 'commit 20261124 on main' }).commit).toBe('2026112');
    expect(cardSource({ ...base, source_commit: 'ticket 12345678 then 0a1b2c3d' }).commit).toBe('0a1b2c3');
  });

  it.each(['working tree', 'local changes', 'abc123', 'defaced decade', ''])(
    'has commit null for an unparsable source_commit (%s)',
    (source_commit) => {
      expect(cardSource({ ...base, source_commit }).commit).toBeNull();
    },
  );
});
