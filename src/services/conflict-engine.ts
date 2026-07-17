import type Database from 'better-sqlite3';
import { facetsIntersect, type FacetSet } from '../utils/facets-intersect.js';
import { ConflictError } from '../types/errors.js';
import type { Card } from '../types/card-schema.js';

interface ActiveCardRow {
  id: string;
  type: string;
  scope: string;
  stack: string;
  applies_to: string;
  version_range: string;
}

function overlappingTags(a: string[], b: string[]): string[] {
  const normalized = new Set(b.map((tag) => tag.toLowerCase().replace(/\s+/g, '-')));
  return a.filter((tag) => normalized.has(tag.toLowerCase().replace(/\s+/g, '-')));
}

function buildDiffSummary(type: string, a: FacetSet, b: FacetSet): string {
  const stackOverlap = overlappingTags(a.stack, b.stack);
  return `same type=${type}, stack ∩ [${stackOverlap.join(', ')}], version_range ∩ (${a.version_range} vs ${b.version_range})`;
}

export function checkConflict(db: Database.Database, newCard: Card, newCardId: string): void {
  // Explicit conflicts_with can reference a card of ANY type — this lookup must stay
  // unfiltered by type, unlike the facet-intersection loop below.
  const activeIds = db
    .prepare("SELECT id FROM cards WHERE status IN ('draft', 'verified')")
    .all() as { id: string }[];
  const activeIdSet = new Set(activeIds.map((row) => row.id));

  const excludedId = newCard.supersedes ?? undefined;

  for (const declaredId of newCard.conflicts_with) {
    if (declaredId === newCardId || declaredId === excludedId) continue;
    if (activeIdSet.has(declaredId)) {
      throw new ConflictError({
        conflicting_card_id: declaredId,
        diff_summary: 'explicitly declared in conflicts_with',
        options: ['supersede', 'scope-split'],
      });
    }
  }

  const activeRows = db
    .prepare(
      "SELECT id, type, scope, stack, applies_to, version_range FROM cards WHERE status IN ('draft', 'verified') AND type = @type",
    )
    .all({ type: newCard.type }) as ActiveCardRow[];

  const newFacets: FacetSet = {
    scope: newCard.scope,
    stack: newCard.stack,
    applies_to: newCard.applies_to,
    version_range: newCard.version_range,
  };

  for (const row of activeRows) {
    if (row.id === newCardId || row.id === excludedId) continue;

    const rowFacets: FacetSet = {
      scope: row.scope as FacetSet['scope'],
      stack: JSON.parse(row.stack) as string[],
      applies_to: JSON.parse(row.applies_to) as string[],
      version_range: row.version_range,
    };

    if (facetsIntersect(newFacets, rowFacets)) {
      throw new ConflictError({
        conflicting_card_id: row.id,
        diff_summary: buildDiffSummary(newCard.type, newFacets, rowFacets),
        options: ['supersede', 'scope-split'],
      });
    }
  }
}
