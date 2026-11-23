/**
 * Match-tier classification for search results. Pure helpers: no DB or service imports.
 *
 * FTS finds candidates, but its tokenizer (porter unicode61) treats `ERR-42` and `ERR_42`
 * as the same phrase, so it cannot be trusted to say "exact". classifyMatch decides that
 * with explicit boundary checks over normalised strings.
 */

export type MatchTier =
  | 'exact_signature'
  | 'exact_identifier'
  | 'exact_title'
  | 'all_terms'
  | 'related';

export const TIER_RANK: Record<MatchTier, number> = {
  exact_signature: 0,
  exact_identifier: 0,
  exact_title: 0,
  all_terms: 1,
  related: 2,
};

/** Lowercase, map typographic quotes/backtick, collapse whitespace to one space, trim. */
export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

const BOUNDARY_CHAR = /[\p{L}\p{N}_\-+#]/u;

/**
 * True when `needle` occurs in `haystack` with no boundary char directly before or after.
 * Both inputs must already be normalised. Empty needle never matches.
 */
export function containsAtBoundary(haystack: string, needle: string): boolean {
  if (needle.length === 0) return false;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return false;
    const before = idx > 0 ? haystack.slice(idx - 1, idx) : '';
    const afterIdx = idx + needle.length;
    const after = afterIdx < haystack.length ? haystack.slice(afterIdx, afterIdx + 1) : '';
    const beforeOk = before === '' || !BOUNDARY_CHAR.test(before);
    const afterOk = after === '' || !BOUNDARY_CHAR.test(after);
    if (beforeOk && afterOk) return true;
    from = idx + 1;
  }
}

const GENERIC = new Set([
  'error',
  'errors',
  'warning',
  'warn',
  'failed',
  'failure',
  'fatal',
  'exception',
  'info',
  'debug',
  'null',
  'undefined',
  'true',
  'false',
]);

const strip = (t: string): string =>
  t.replace(/^[^\p{L}\p{N}_]+|[^\p{L}\p{N}_)]+$/gu, '');

const isIdentifier = (t: string): boolean =>
  t.length >= 4 &&
  !GENERIC.has(t.toLowerCase()) &&
  (/[a-z][A-Z]/.test(t) ||
    /_/.test(t) ||
    /\p{L}.*\d|\d.*\p{L}/u.test(t) ||
    /^[A-Z][A-Z0-9]{4,}$/.test(t) ||
    /\p{L}[.:/]\p{L}/u.test(t) ||
    /.(Exception|Error)$/.test(t) ||
    /^\d{3}$/.test(t));

/**
 * Distinctive tokens of an error signature (camelCase, snake_case, codes, dotted names...).
 * Heuristics run on the RAW signature (case matters); results are lowercased and de-duplicated.
 */
export function extractIdentifiers(signature: string): string[] {
  const out = new Set<string>();
  for (const raw of signature.split(/\s+/)) {
    const token = strip(raw);
    if (token && isIdentifier(token)) out.add(token.toLowerCase());
  }
  return [...out];
}

/**
 * Label how strongly a candidate card matches the query. Checks are one-directional:
 * the card's signature/identifier must appear inside the query, never the reverse.
 */
export function classifyMatch(
  query: string,
  card: { title: string; error_signature: string | null },
  inAllTermsSet: boolean,
): MatchTier {
  const q = normalizeForMatch(query);
  if (card.error_signature) {
    const sigNorm = normalizeForMatch(card.error_signature);
    if (containsAtBoundary(q, sigNorm)) return 'exact_signature';
    for (const id of extractIdentifiers(card.error_signature)) {
      if (containsAtBoundary(q, normalizeForMatch(id))) return 'exact_identifier';
    }
  }
  const titleNorm = normalizeForMatch(card.title);
  if (titleNorm.length > 0 && titleNorm === q) return 'exact_title';
  return inAllTermsSet ? 'all_terms' : 'related';
}
