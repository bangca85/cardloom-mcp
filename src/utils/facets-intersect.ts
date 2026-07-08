import { intersects as semverIntersects, validRange } from 'semver';

export interface FacetSet {
  scope: 'project' | 'stack' | 'global';
  stack: string[];
  applies_to: string[];
  version_range: string;
}

function normalizeTag(tag: string): string {
  return tag.toLowerCase().replace(/\s+/g, '-');
}

export function arraysIntersect(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const normalizedA = new Set(a.map(normalizeTag));
  return b.some((tag) => normalizedA.has(normalizeTag(tag)));
}

export function scopesIntersect(a: FacetSet, b: FacetSet): boolean {
  if (a.scope === 'global' || b.scope === 'global') return true;
  if (a.scope !== b.scope) return false;
  if (a.scope === 'stack') return arraysIntersect(a.stack, b.stack);
  return arraysIntersect(a.applies_to, b.applies_to);
}

function normalizeRange(range: any): string {
  if (typeof range !== 'string' || range.trim() === '') return '*';
  if (validRange(range) === null) {
    console.error(`[facets-intersect] invalid version_range "${range}" — treating as "*"`);
    return '*';
  }
  return range;
}

export function versionRangesIntersect(a: string | undefined | null, b: string | undefined | null): boolean {
  return semverIntersects(normalizeRange(a), normalizeRange(b));
}

export function facetsIntersect(a: FacetSet, b: FacetSet): boolean {
  return arraysIntersect(a.stack, b.stack) && scopesIntersect(a, b) && versionRangesIntersect(a.version_range, b.version_range);
}
