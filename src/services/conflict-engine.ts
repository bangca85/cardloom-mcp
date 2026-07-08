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
  const activeRows = db
    .prepare("SELECT id, type, scope, stack, applies_to, version_range FROM cards WHERE status IN ('draft', 'verified')")
    .all() as ActiveCardRow[];

  const excludedId = newCard.supersedes ?? undefined;
  const activeById = new Map(activeRows.map((row) => [row.id, row]));

  for (const declaredId of newCard.conflicts_with) {
    if (declaredId === newCardId || declaredId === excludedId) continue;
    const row = activeById.get(declaredId);
    if (row) {
      throw new ConflictError({
        conflicting_card_id: row.id,
        diff_summary: 'explicitly declared in conflicts_with',
        options: ['supersede', 'scope-split'],
      });
    }
  }

  const newFacets: FacetSet = {
    scope: newCard.scope,
    stack: newCard.stack,
    applies_to: newCard.applies_to,
    version_range: newCard.version_range,
  };

  for (const row of activeRows) {
    if (row.id === newCardId || row.id === excludedId) continue;
    if (row.type !== newCard.type) continue;

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
