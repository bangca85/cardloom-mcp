const SUPERSEDED_BY = /^superseded by (\S+)$/;

/**
 * The successor id named by the exact deprecation reason `superseded by <id>` that two-phase supersede
 * (AD-13) writes, or null. The reason is trimmed first. This only parses: use `resolveSupersededBy` to also
 * check that the named card exists and declares `supersedes` = the deprecated card.
 */
export function parseSupersededBy(reason: string | null | undefined): string | null {
  if (typeof reason !== 'string') return null;
  return SUPERSEDED_BY.exec(reason.trim())?.[1] ?? null;
}

/**
 * The one "already replaced" rule (AD-13): the successor id named by a deprecated card's reason, but only when
 * that successor exists and declares `supersedes` = `cardId`. `supersedesOf` looks a card up by id and returns
 * its `supersedes` value (null when it declares none) or undefined when no such card exists. Pure: callers
 * supply the lookup from the index (or from rows already in memory).
 */
export function resolveSupersededBy(
  cardId: string,
  reason: string | null | undefined,
  supersedesOf: (id: string) => string | null | undefined,
): string | null {
  const successorId = parseSupersededBy(reason);
  if (successorId === null) return null;
  return supersedesOf(successorId) === cardId ? successorId : null;
}
