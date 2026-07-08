import type Database from 'better-sqlite3';
import { saveLearningDraft, type SaveLearningDraftInput } from '../services/card-service.js';

export async function handleSaveLearningDraft(
  db: Database.Database,
  knowledgeStorePath: string,
  args: SaveLearningDraftInput,
) {
  const result = await saveLearningDraft(db, knowledgeStorePath, args);

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
  };
}
