import type Database from 'better-sqlite3';
import { renderCard } from '../services/card-service.js';
import { WRITE_BACK_REMINDER } from '../config/messages.js';

export interface GetCardArgs {
  id: string;
  compact?: boolean;
}

export function handleGetCard(db: Database.Database, args: GetCardArgs) {
  const card = renderCard(db, args.id, new Date(), { compact: args.compact });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ card, write_back_reminder: WRITE_BACK_REMINDER }),
      },
    ],
  };
}
