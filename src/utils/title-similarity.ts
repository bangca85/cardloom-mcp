/** Words of one or two letters ("in", "to") carry no meaning here: `Use WAL mode in SQLite` equals `SQLite: use WAL mode`. */
const MIN_TOKEN_LENGTH = 3;
const TOKEN_RE = /[\p{L}\p{N}]+/gu;

function tokens(title: string): Set<string> {
  const out = new Set<string>();
  for (const match of title.toLowerCase().matchAll(TOKEN_RE)) {
    if (match[0].length >= MIN_TOKEN_LENGTH) out.add(match[0]);
  }
  return out;
}

/** Jaccard overlap (0..1) of the lowercase letter/digit tokens (length >= 3) of two titles; 0 if either has none. */
export function titleSimilarity(a: string, b: string): number {
  return jaccard(tokens(a), tokens(b));
}

/** Same measure on token sets built once by `titleTokens`, for callers comparing many titles. */
export function titleTokens(title: string): Set<string> {
  return tokens(title);
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}
