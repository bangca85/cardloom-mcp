/** Deprecation reasons that start with this prefix mean "a human turned this draft down". */
export const REJECTED_PREFIX = 'rejected:';

/** Prefix `source_commit` provenance takes in `verification_method` when merge promotion verified a card. */
const MERGE_PROMOTION_PREFIX = 'merged:';

/** True when a deprecation reason is a rejection (case-insensitive, leading whitespace ignored). */
export function isRejectionReason(reason: string | null | undefined): boolean {
  if (typeof reason !== 'string') return false;
  return reason.trimStart().toLowerCase().startsWith(REJECTED_PREFIX);
}

/** True when a card was verified by merge promotion (identified by `verification_method`, never `verified_by`). */
export function isMergePromotion(verificationMethod: string | null | undefined): boolean {
  if (typeof verificationMethod !== 'string') return false;
  return verificationMethod.startsWith(MERGE_PROMOTION_PREFIX);
}
