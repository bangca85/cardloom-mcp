/** How drafts are being reviewed. A card is "ever approved" when `verified_by` is set (deprecation keeps it). */
export interface ReviewStats {
  pendingDrafts: number;
  /**
   * Age in whole days of the oldest draft, counted from the commit that added the card when the store is a
   * git repository, else from the card file's mtime; `null` when there are no drafts.
   */
  oldestDraftDays: number | null;
  approvedByHuman: number;
  approvedByMergePromotion: number;
  /** Deprecated, never approved, reason starts with `rejected:`. */
  rejectedByHuman: number;
  /** Deprecated, never approved, not a rejection (e.g. superseded while still a draft). */
  retiredUnreviewed: number;
  /** approvedByHuman / (approvedByHuman + rejectedByHuman); `null` when that denominator is 0. */
  humanApprovalRate: number | null;
}

export function emptyReview(): ReviewStats {
  return {
    pendingDrafts: 0,
    oldestDraftDays: null,
    approvedByHuman: 0,
    approvedByMergePromotion: 0,
    rejectedByHuman: 0,
    retiredUnreviewed: 0,
    humanApprovalRate: null,
  };
}
