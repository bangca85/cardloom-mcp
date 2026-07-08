import type Database from 'better-sqlite3';
import { searchCards, type SearchOptions } from '../services/search-service.js';
import { WRITE_BACK_REMINDER } from '../config/messages.js';

export interface SearchKnowledgeArgs {
  query: string;
  context?: { stack?: string[]; versions?: Record<string, string> };
  include_drafts?: boolean;
  include_deprecated?: boolean;
  include_restricted?: boolean;
  limit?: number;
}

export { WRITE_BACK_REMINDER };

export function handleSearchKnowledge(db: Database.Database, args: SearchKnowledgeArgs) {
  const opts: SearchOptions = {
    context: args.context,
    includeDrafts: args.include_drafts,
    includeDeprecated: args.include_deprecated,
    includeRestricted: args.include_restricted,
    limit: args.limit,
  };

  const results = searchCards(db, args.query, opts).map((item) => ({
    id: item.id,
    type: item.type,
    status: item.status,
    snippet: item.preview,
    trust: item.trust,
    flags: item.flags,
    ...(item.untrusted !== undefined && { untrusted: item.untrusted }),
    ...(item.deprecated !== undefined && { deprecated: item.deprecated }),
    ...(item.restricted !== undefined && { restricted: item.restricted }),
  }));

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ results, write_back_reminder: WRITE_BACK_REMINDER }),
      },
    ],
  };
}
