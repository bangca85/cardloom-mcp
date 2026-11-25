import type Database from 'better-sqlite3';
import { renderCard } from '../services/card-service.js';
import { WRITE_BACK_REMINDER } from '../config/messages.js';

export interface GetCardArgs {
  id: string;
  compact?: boolean;
}

/** `overrides.now` is not part of the MCP input schema (the server never passes it): the eval harness pins the clock with it. */
export function handleGetCard(db: Database.Database, args: GetCardArgs, overrides: { now?: Date } = {}) {
  const card = renderCard(db, args.id, overrides.now ?? new Date(), { compact: args.compact });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ card, write_back_reminder: WRITE_BACK_REMINDER }),
      },
    ],
  };
}
