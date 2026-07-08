import fs from 'node:fs';
import path from 'node:path';
import { initGitRepo } from './git-service.js';

export async function initKnowledgeStore(knowledgeStorePath: string): Promise<void> {
  const dirs = [
    knowledgeStorePath,
    path.join(knowledgeStorePath, 'cards'),
    path.join(knowledgeStorePath, 'events'),
    path.join(knowledgeStorePath, 'benchmark'),
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  await initGitRepo(knowledgeStorePath);
  console.error('Knowledge store initialized');
}
