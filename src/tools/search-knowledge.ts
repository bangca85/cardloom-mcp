import type Database from 'better-sqlite3';
import { searchCards, hasVerifiedCards, type SearchContext, type SearchOptions } from '../services/search-service.js';
import { WRITE_BACK_REMINDER, EMPTY_STORE_HINT } from '../config/messages.js';

export interface SearchKnowledgeArgs {
  query: string;
  context?: SearchContext;
  include_drafts?: boolean;
  include_deprecated?: boolean;
  include_restricted?: boolean;
  limit?: number;
}

export { WRITE_BACK_REMINDER };

// FR10: responses stay compact even when an FTS excerpt is one very long token.
const SNIPPET_MAX_CHARS = 200;

/**
 * `overrides` is not part of the MCP input schema: the server never passes it. The benchmark uses it to pin
 * ranking/fallback per run while still measuring the exact JSON this tool serialises.
 */
export function handleSearchKnowledge(
  db: Database.Database,
  args: SearchKnowledgeArgs,
  overrides: Pick<SearchOptions, 'ranking' | 'fallback'> = {},
) {
  const opts: SearchOptions = {
    ...overrides,
    context: args.context,
    includeDrafts: args.include_drafts,
    includeDeprecated: args.include_deprecated,
    includeRestricted: args.include_restricted,
    limit: args.limit,
  };

  const found = searchCards(db, args.query, opts);

  const results = found.map((item) => ({
    id: item.id,
    type: item.type,
    status: item.status,
    title: item.title,
    snippet: item.excerpt.slice(0, SNIPPET_MAX_CHARS),
    match: item.match,
    trust: Math.round(item.trust * 100) / 100,
    flags: item.flags,
    ...(item.scope_layer !== null && { scope_layer: item.scope_layer }),
    ...(item.scope_layer === 'unknown' && { applies_to: item.applies_to }),
    ...(item.scope_layer === 'other_project' && item.project !== null && { applies_to_project: item.project }),
    ...(item.untrusted !== undefined && { untrusted: item.untrusted }),
    ...(item.deprecated !== undefined && { deprecated: item.deprecated }),
    ...(item.restricted !== undefined && { restricted: item.restricted }),
  }));

  const noDirectMatch = found.length > 0 && found.every((item) => item.match === 'related');

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          results,
          ...(noDirectMatch && { no_direct_match: true }),
          ...(!hasVerifiedCards(db) && { hint: EMPTY_STORE_HINT }),
          write_back_reminder: WRITE_BACK_REMINDER,
        }),
      },
    ],
  };
}
