import type { Card } from '../types/card-schema.js';

const BASE_BY_STATUS: Record<Card['status'], number> = {
  draft: 0.3,
  verified: 1.0,
  deprecated: 0,
};

const HALF_LIFE_DAYS = 180;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface ComputeTrustInput {
  status: Card['status'];
  lastVerified: string | null;
  success: number;
  failure: number;
}

export function computeTrust(input: ComputeTrustInput, now: Date = new Date()): number {
  const base = BASE_BY_STATUS[input.status] ?? 0;
  const nowTime = now.getTime();
  if (isNaN(nowTime)) return 0;

  let decay = 1;
  if (input.lastVerified !== null) {
    const verifiedTime = new Date(input.lastVerified).getTime();
    if (isNaN(verifiedTime)) {
      decay = 0; // treat invalid verification date as completely decayed (untrusted)
    } else {
      const diffMs = Math.max(0, nowTime - verifiedTime);
      decay = 0.5 ** (diffMs / MS_PER_DAY / HALF_LIFE_DAYS);
    }
  }

  const success = isNaN(input.success) ? 0 : Math.max(0, input.success);
  const failure = isNaN(input.failure) ? 0 : Math.max(0, input.failure);
  const signal = (success + 1) / (success + failure + 2);

  return base * decay * signal;
}
