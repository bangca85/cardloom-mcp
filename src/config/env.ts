import path from 'node:path';

function parseNumberEnv(val: string | undefined, defaultVal: number): number {
  if (val === undefined || val.trim() === '') return defaultVal;
  const num = Number(val);
  return isNaN(num) ? defaultVal : num;
}

export const config = {
  get knowledgeStorePath(): string {
    return process.env['KNOWLEDGE_STORE_PATH'] ?? path.resolve('knowledge-store');
  },
  get indexDbPath(): string {
    return process.env['INDEX_DB_PATH'] ?? path.join(config.knowledgeStorePath, '.metadata', 'index.db');
  },
  get staleThresholdDays(): number {
    return parseNumberEnv(process.env['STALE_THRESHOLD_DAYS'], 180);
  },
  get reviewFailureThreshold(): number {
    return parseNumberEnv(process.env['REVIEW_FAILURE_THRESHOLD'], 2);
  },
  get machineId(): string | undefined {
    return process.env['KNOWLEDGE_MACHINE_ID'];
  },
  get reviewerName(): string {
    return process.env['REVIEWER_NAME'] ?? 'human-reviewer';
  },
} as const;
