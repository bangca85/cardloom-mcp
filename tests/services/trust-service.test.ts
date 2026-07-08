import { describe, it, expect } from 'vitest';
import { computeTrust } from '../../src/services/trust-service';

describe('computeTrust', () => {
  it('verified, last_verified = now, 0/0 counters -> 1.0 * 1 * 0.5 = 0.5', () => {
    const now = new Date('2026-07-05T00:00:00Z');
    const trust = computeTrust({ status: 'verified', lastVerified: now.toISOString(), success: 0, failure: 0 }, now);
    expect(trust).toBeCloseTo(0.5, 10);
  });

  it('verified, last_verified 180 days ago -> decay 0.5 -> 0.25', () => {
    const now = new Date('2026-07-05T00:00:00Z');
    const lastVerified = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000).toISOString();
    const trust = computeTrust({ status: 'verified', lastVerified, success: 0, failure: 0 }, now);
    expect(trust).toBeCloseTo(0.25, 10);
  });

  it('draft, last_verified null, 0/0 -> 0.3 * 1 * 0.5 = 0.15, never NaN', () => {
    const trust = computeTrust({ status: 'draft', lastVerified: null, success: 0, failure: 0 });
    expect(Number.isNaN(trust)).toBe(false);
    expect(trust).toBeCloseTo(0.15, 10);
  });

  it('deprecated always 0 regardless of counters or last_verified', () => {
    const trust1 = computeTrust({ status: 'deprecated', lastVerified: null, success: 100, failure: 0 });
    const trust2 = computeTrust({
      status: 'deprecated',
      lastVerified: new Date().toISOString(),
      success: 0,
      failure: 0,
    });
    expect(trust1).toBe(0);
    expect(trust2).toBe(0);
  });

  it('signal: success=3/failure=1 -> 4/6, failures pull trust down', () => {
    const now = new Date('2026-07-05T00:00:00Z');
    const highSuccess = computeTrust(
      { status: 'verified', lastVerified: now.toISOString(), success: 3, failure: 1 },
      now,
    );
    const allFailure = computeTrust(
      { status: 'verified', lastVerified: now.toISOString(), success: 0, failure: 4 },
      now,
    );

    expect(highSuccess).toBeCloseTo((3 + 1) / (3 + 1 + 2), 10);
    expect(allFailure).toBeLessThan(highSuccess);
  });

  it('is a pure function of its inputs — no NaN/crash across arbitrary status combos', () => {
    for (const status of ['draft', 'verified', 'deprecated'] as const) {
      const trust = computeTrust({ status, lastVerified: null, success: 5, failure: 5 });
      expect(Number.isNaN(trust)).toBe(false);
      expect(trust).toBeGreaterThanOrEqual(0);
    }
  });
});
