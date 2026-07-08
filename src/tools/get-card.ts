import type Database from 'better-sqlite3';
import { renderCard } from '../services/card-service.js';
import { WRITE_BACK_REMINDER } from '../config/messages.js';

export interface GetCardArgs {
  id: string;
}

export function handleGetCard(db: Database.Database, args: GetCardArgs) {
  const card = renderCard(db, args.id);

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ card, write_back_reminder: WRITE_BACK_REMINDER }),
      },
    ],
  };
}
