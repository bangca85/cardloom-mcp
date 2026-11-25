import path from 'node:path';

function parseNumberEnv(val: string | undefined, defaultVal: number): number {
  if (val === undefined || val.trim() === '') return defaultVal;
  const num = Number(val);
  return isNaN(num) ? defaultVal : num;
}

function parsePositiveIntEnv(val: string | undefined, defaultVal: number): number {
  if (val === undefined || val.trim() === '') return defaultVal;
  const num = Number(val);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num <= 0) return defaultVal;
  return num;
}

export const config = {
  get knowledgeStorePath(): string {
    return process.env['KNOWLEDGE_STORE_PATH'] ?? path.resolve('knowledge-store');
  },
  get indexDbPath(): string {
    return process.env['INDEX_DB_PATH'] ?? path.join(config.knowledgeStorePath, '.metadata', 'index.db');
  },
  get staleThresholdDays(): number {
    return parseNumberEnv(process.env['STALE_THRESHOLD_DAYS'], 180);
  },
  get reviewFailureThreshold(): number {
    return parseNumberEnv(process.env['REVIEW_FAILURE_THRESHOLD'], 2);
  },
  get machineId(): string | undefined {
    return process.env['KNOWLEDGE_MACHINE_ID'];
  },
  get reviewerName(): string {
    return process.env['REVIEWER_NAME'] ?? 'human-reviewer';
  },
  get graphGenericStackTags(): string[] {
    const raw = process.env['GRAPH_GENERIC_STACK_TAGS'];
    if (raw === undefined || raw.trim() === '') return [];
    return raw
      .split(',')
      .map((tag) => tag.trim().toLowerCase())
      .filter((tag) => tag !== '');
  },
  get maxSharedStackGroupSize(): number {
    return parsePositiveIntEnv(process.env['MAX_SHARED_STACK_GROUP_SIZE'], 50);
  },
  get maxSharedStackEdges(): number {
    return parsePositiveIntEnv(process.env['MAX_SHARED_STACK_EDGES'], 5000);
  },
  /**
   * Result ordering for searchCards. AD-10 decision (2026-11-24): the default stays `baseline`; `x` and `y`
   * are opt-in because putting the project layer before the BM25 score buried shared cards in the benchmark.
   *   baseline — facetMatch → ftsRank → trust (the original order).
   *   x        — scopeRank → match tier → ftsRank → trust.
   *   y        — match tier → scopeRank → ftsRank → trust.
   * Unknown or empty → `baseline`.
   */
  get searchRanking(): SearchRankingMode {
    const raw = (process.env['SEARCH_RANKING'] ?? '').trim().toLowerCase();
    return raw === 'x' || raw === 'y' ? raw : 'baseline';
  },
  /**
   * `tiered` (the default since the 2026-11-24 AD-10 decision) adds an OR-query fallback when the AND query
   * returns fewer than `limit` rows; every result then carries a `match` label and partial matches are
   * labelled `related`. `off` restores the original AND-only behaviour. Unknown or empty → `tiered`.
   */
  get searchFallback(): SearchFallbackMode {
    const raw = (process.env['SEARCH_FALLBACK'] ?? '').trim().toLowerCase();
    return raw === 'off' ? 'off' : 'tiered';
  },
  /**
   * What `npm run promote-merged` does with a draft whose source commit reached its repo's
   * default branch AFTER the card was written:
   *   off    — nothing; the CLI exits without looking.
   *   review — lists them as candidates; a human approves in chat (the pre-2026-11-17 rule).
   *   auto   — verifies the auto-eligible ones itself (see promotionAutoTypes), lists the rest.
   * Default is `review`: an unknown or empty value must never widen into auto-verification.
   */
  get promotionMode(): PromotionMode {
    const raw = (process.env['PROMOTION_MODE'] ?? '').trim().toLowerCase();
    return raw === 'off' || raw === 'auto' ? raw : 'review';
  },
  /** Directories scanned (3 levels deep) for local clones whose folder name matches a card's repo. */
  get promotionRepoRoots(): string[] {
    return splitList(process.env['PROMOTION_REPO_ROOTS'], ':');
  },
  /**
   * Card types `auto` may verify. decision/pattern describe the change itself, so "the change was
   * reviewed and merged" is evidence for them; a gotcha or playbook usually describes some OTHER
   * system's behaviour, which a merge says nothing about.
   */
  get promotionAutoTypes(): string[] {
    const list = splitList(process.env['PROMOTION_AUTO_TYPES'], ',').map((t) => t.toLowerCase());
    return list.length > 0 ? list : ['decision', 'pattern'];
  },
  /** `git fetch origin` each local clone before checking it. Off means a stale clone says "not merged yet". */
  get promotionFetch(): boolean {
    return (process.env['PROMOTION_FETCH'] ?? '1').trim() !== '0';
  },
  /** Name written to `verified_by` by an automatic verify, so trust and audit can tell it from a person. */
  get promotionBotName(): string {
    return process.env['PROMOTION_BOT_NAME'] ?? 'merge-bot';
  },
  /**
   * Opt-in local search telemetry (AD-3/AD-4 amendment 2026-11-25). Anything but `local` is `off`, so an unknown
   * or empty value never starts recording.
   */
  get telemetryMode(): TelemetryMode {
    return (process.env['CARDLOOM_TELEMETRY'] ?? '').trim().toLowerCase() === 'local' ? 'local' : 'off';
  },
  /** A second, separate opt-in: also write the text of searches that found no direct answer. */
  get telemetrySamples(): boolean {
    const raw = (process.env['CARDLOOM_TELEMETRY_SAMPLES'] ?? '').trim().toLowerCase();
    return raw === '1' || raw === 'true';
  },
  /** Next to the index (a named volume in Docker), never in the knowledge store, so it is never committed. */
  get telemetryPath(): string {
    return path.join(path.dirname(config.indexDbPath), 'telemetry.jsonl');
  },
} as const;

export type TelemetryMode = 'off' | 'local';
export type PromotionMode = 'off' | 'review' | 'auto';
export type SearchRankingMode = 'baseline' | 'x' | 'y';
export type SearchFallbackMode = 'off' | 'tiered';

function splitList(raw: string | undefined, sep: string): string[] {
  if (raw === undefined || raw.trim() === '') return [];
  return raw
    .split(sep)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}
