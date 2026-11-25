const SHA_RE = /\b[0-9a-f]{7,40}\b/g;

/**
 * The commit named in `source_commit`: the first 7-40 hex token that has both a digit and a letter.
 * An abbreviation made only of digits is a real sha about 4% of the time (7 characters), but it also
 * looks like a ticket number, so it is used only when no mixed token exists. Resolution still has to
 * find that commit in the repo, so a ticket number ends as "unresolvable", not as a promotion.
 * Tokens made only of letters (words such as "defaced") are never taken.
 */
export function extractSha(sourceCommit: string): string | null {
  let digitsOnly: string | null = null;
  for (const m of sourceCommit.toLowerCase().matchAll(SHA_RE)) {
    const token = m[0];
    const hasLetter = /[a-f]/.test(token);
    const hasDigit = /[0-9]/.test(token);
    if (hasLetter && hasDigit) return token;
    if (hasDigit && digitsOnly === null) digitsOnly = token;
  }
  return digitsOnly;
}

/** `extractSha` shortened to 7 characters (the usual abbreviation shown to people), or null when there is none. */
export function shortSha(sourceCommit: string): string | null {
  return extractSha(sourceCommit)?.slice(0, 7) ?? null;
}
