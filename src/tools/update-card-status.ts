import type Database from 'better-sqlite3';
import { updateCardStatus, type UpdateCardStatusInput } from '../services/card-service.js';

export interface UpdateCardStatusArgs {
  id: string;
  action: string;
  reason?: string;
  by?: string;
}

export async function handleUpdateCardStatus(
  db: Database.Database,
  storePath: string,
  args: UpdateCardStatusArgs,
) {
  const input: UpdateCardStatusInput = {
    id: args.id,
    action: args.action,
    ...(args.reason !== undefined && { reason: args.reason }),
    ...(args.by !== undefined && { by: args.by }),
  };

  const result = await updateCardStatus(db, storePath, input);

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
  };
}
