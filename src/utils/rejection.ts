/** Deprecation reasons that start with this prefix mean "a human turned this draft down". */
export const REJECTED_PREFIX = 'rejected:';

/**
 * The exact `verification_method` `promote-merged` writes in `PROMOTION_MODE=auto`:
 * `merged:<repo>@<sha> (<via> <date>)`. In review mode a human approves in chat and the agent appends
 * `+chat-approval` to that same evidence, so a suffix after the closing parenthesis means a human approved.
 */
const MERGE_PROMOTION_METHOD = /^merged:\S+@[0-9a-f]+ \([^)]*\)$/i;

/** `reconfirm` prefixes the existing method with this; it changes who last confirmed, not who first approved. */
const RECONFIRMED_PREFIX = /^(?:reconfirmed:)+/i;

/** True when a deprecation reason is a rejection (case-insensitive, leading whitespace ignored). */
export function isRejectionReason(reason: string | null | undefined): boolean {
  if (typeof reason !== 'string') return false;
  return reason.trimStart().toLowerCase().startsWith(REJECTED_PREFIX);
}

/**
 * True when merge promotion verified the card on its own: `verification_method` is exactly the auto-mode form.
 * The same evidence with a `+chat-approval` suffix (review mode) is a human approval and returns false.
 * Every leading `reconfirmed:` (added by `reconfirm`) is stripped first, so a re-confirmed auto-promoted card
 * still counts as merge promotion: reconfirm does not change who first approved the card.
 * Identified by `verification_method`, never `verified_by`.
 */
export function isMergePromotion(verificationMethod: string | null | undefined): boolean {
  if (typeof verificationMethod !== 'string') return false;
  return MERGE_PROMOTION_METHOD.test(verificationMethod.replace(RECONFIRMED_PREFIX, ''));
}
