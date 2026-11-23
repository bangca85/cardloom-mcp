import { describe, it, expect, vi } from 'vitest';
import {
  arraysIntersect,
  scopesIntersect,
  versionRangesIntersect,
  facetsIntersect,
  classifyScopeLayer,
  normalizeProjectKey,
  PROJECT_KEY_RE,
  type FacetSet,
} from '../../src/utils/facets-intersect';

function facet(overrides: Partial<FacetSet> = {}): FacetSet {
  return {
    scope: 'project',
    stack: ['node'],
    applies_to: ['api'],
    version_range: '>=1.0.0',
    ...overrides,
  };
}

describe('arraysIntersect', () => {
  it('returns true when arrays share a normalized tag', () => {
    expect(arraysIntersect(['react'], ['React', 'vue'])).toBe(true);
  });

  it('normalizes case and whitespace to kebab-case before comparing', () => {
    expect(arraysIntersect(['Node JS'], ['node-js'])).toBe(true);
  });

  it('returns false when neither array is empty but no tags overlap', () => {
    expect(arraysIntersect(['react'], ['vue'])).toBe(false);
  });

  it('returns false when the left array is empty (missing = no match)', () => {
    expect(arraysIntersect([], ['react'])).toBe(false);
  });

  it('returns false when the right array is empty (missing = no match)', () => {
    expect(arraysIntersect(['react'], [])).toBe(false);
  });

  it('returns false when both arrays are empty', () => {
    expect(arraysIntersect([], [])).toBe(false);
  });
});

describe('scopesIntersect', () => {
  it('global scope intersects with any other scope', () => {
    expect(scopesIntersect(facet({ scope: 'global' }), facet({ scope: 'project', applies_to: ['other'] }))).toBe(true);
    expect(scopesIntersect(facet({ scope: 'project' }), facet({ scope: 'global' }))).toBe(true);
  });

  it('two global scopes intersect', () => {
    expect(scopesIntersect(facet({ scope: 'global' }), facet({ scope: 'global' }))).toBe(true);
  });

  it('different non-global scope levels never intersect', () => {
    expect(scopesIntersect(facet({ scope: 'stack' }), facet({ scope: 'project' }))).toBe(false);
  });

  it('same "stack" scope level intersects via the stack field', () => {
    expect(scopesIntersect(facet({ scope: 'stack', stack: ['node'] }), facet({ scope: 'stack', stack: ['node'] }))).toBe(true);
    expect(scopesIntersect(facet({ scope: 'stack', stack: ['node'] }), facet({ scope: 'stack', stack: ['python'] }))).toBe(false);
  });

  it('same "project" scope level intersects via the applies_to field', () => {
    expect(scopesIntersect(facet({ scope: 'project', applies_to: ['app-a'] }), facet({ scope: 'project', applies_to: ['app-a'] }))).toBe(true);
    expect(scopesIntersect(facet({ scope: 'project', applies_to: ['app-a'] }), facet({ scope: 'project', applies_to: ['app-b'] }))).toBe(false);
  });
});

describe('versionRangesIntersect', () => {
  it('intersecting semver ranges return true', () => {
    expect(versionRangesIntersect('>=1.0.0 <3.0.0', '2.x')).toBe(true);
  });

  it('non-intersecting semver ranges return false', () => {
    expect(versionRangesIntersect('^1.0.0', '^2.0.0')).toBe(false);
  });

  it('missing range on either side is treated as "*" (intersects everything)', () => {
    expect(versionRangesIntersect(undefined, '^2.0.0')).toBe(true);
    expect(versionRangesIntersect('^2.0.0', null)).toBe(true);
    expect(versionRangesIntersect(undefined, undefined)).toBe(true);
  });

  it('an unparsable range is treated as "*" and logs a warning to stderr', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(versionRangesIntersect('not-a-range', '^1.0.0')).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[facets-intersect]'));

    errorSpy.mockRestore();
  });
});

describe('facetsIntersect', () => {
  it('intersects when stack, scope/applies_to, and version_range all overlap', () => {
    const a = facet({ scope: 'project', stack: ['node'], applies_to: ['app-a'], version_range: '^1.0.0' });
    const b = facet({ scope: 'project', stack: ['node'], applies_to: ['app-a'], version_range: '1.2.0' });
    expect(facetsIntersect(a, b)).toBe(true);
  });

  it('does not intersect when stack tags differ', () => {
    const a = facet({ stack: ['node'] });
    const b = facet({ stack: ['python'] });
    expect(facetsIntersect(a, b)).toBe(false);
  });

  it('does not intersect when applies_to differs under project scope', () => {
    const a = facet({ scope: 'project', applies_to: ['app-a'] });
    const b = facet({ scope: 'project', applies_to: ['app-b'] });
    expect(facetsIntersect(a, b)).toBe(false);
  });

  it('does not intersect when version ranges differ', () => {
    const a = facet({ version_range: '^1.0.0' });
    const b = facet({ version_range: '^2.0.0' });
    expect(facetsIntersect(a, b)).toBe(false);
  });

  it('global scope card intersects any card sharing a stack tag and version range', () => {
    const a = facet({ scope: 'global', applies_to: [] });
    const b = facet({ scope: 'project', applies_to: ['app-a'] });
    expect(facetsIntersect(a, b)).toBe(true);
  });
});

describe('project key and scope layers', () => {
  const caller = { project: 'acme/billing-api', aliases: ['billing-api'] };
  it('legacy card matches through an alias', () =>
    expect(classifyScopeLayer({ scope: 'project', applies_to: ['billing-api', 'cmd/api'] }, caller)).toBe('this_project'));
  it('case and spacing are normalised (Review Focus 4)', () =>
    expect(classifyScopeLayer({ scope: 'project', applies_to: ['widgetkit'] }, { project: 'WidgetKit' })).toBe('this_project'));
  it('legacy card with only paths is unknown, not other_project', () =>
    expect(classifyScopeLayer({ scope: 'project', applies_to: ['lib/core/db', 'test/'] }, caller)).toBe('unknown'));
  it('card with an explicit other project key is other_project', () =>
    expect(classifyScopeLayer({ scope: 'project', project: 'notes-app', applies_to: ['Notes-App'] }, caller)).toBe('other_project'));
  it('explicit project wins over applies_to', () =>
    expect(classifyScopeLayer({ scope: 'project', project: 'notes-app', applies_to: ['billing-api'] }, caller)).toBe('other_project'));
  it('stack and global cards are shared', () => {
    expect(classifyScopeLayer({ scope: 'stack', applies_to: ['Notes-App'] }, caller)).toBe('shared');
    expect(classifyScopeLayer({ scope: 'global', applies_to: [] }, caller)).toBe('shared');
  });
  it('no caller project → null', () =>
    expect(classifyScopeLayer({ scope: 'project', applies_to: ['x'] }, {})).toBeNull());
  it('blank caller project → null', () =>
    expect(classifyScopeLayer({ scope: 'project', applies_to: ['x'] }, { project: '   ' })).toBeNull());
  it('never prefix-matches sub-paths against a short key', () =>
    expect(classifyScopeLayer({ scope: 'project', applies_to: ['lib/core/db'] }, { project: 'lib' })).toBe('unknown'));
  it('blank aliases are ignored', () =>
    expect(classifyScopeLayer({ scope: 'project', applies_to: [''] }, { project: 'acme/x', aliases: ['', '  '] })).toBe('unknown'));
  it('explicit card project matches through an alias', () =>
    expect(classifyScopeLayer({ scope: 'project', project: 'Billing-API', applies_to: [] }, caller)).toBe('this_project'));
  it('normalizeProjectKey trims, lowercases and dashes whitespace', () =>
    expect(normalizeProjectKey('  Acme  Billing API ')).toBe('acme-billing-api'));
  it('PROJECT_KEY_RE rejects absolute paths and spaces', () => {
    expect(PROJECT_KEY_RE.test('acme/billing-api')).toBe(true);
    expect(PROJECT_KEY_RE.test('notes-app')).toBe(true);
    expect(PROJECT_KEY_RE.test('/Users/me/app')).toBe(false);
    expect(PROJECT_KEY_RE.test('my app')).toBe(false);
  });
});
