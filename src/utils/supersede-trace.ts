const SUPERSEDED_BY = /^superseded by (\S+)$/;

/**
 * The successor id named by the exact deprecation reason `superseded by <id>` that two-phase supersede
 * (AD-13) writes, or null. The reason is trimmed first. This only parses: callers still check that the named
 * card exists and declares `supersedes` = the deprecated card before reporting it.
 */
export function parseSupersededBy(reason: string | null | undefined): string | null {
  if (typeof reason !== 'string') return null;
  return SUPERSEDED_BY.exec(reason.trim())?.[1] ?? null;
}
