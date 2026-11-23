import path from 'node:path';

export interface LauncherEnv {
  KNOWLEDGE_STORE_PATH: string;
  INDEX_DB_PATH: string;
}

function pick(value: string | undefined, fallback: string): string {
  const v = value === undefined || value.trim() === '' ? fallback : value;
  return path.resolve(v);
}

/**
 * Store/index locations for the `npx cardloom-mcp` launcher: values already in `env` win (blank
 * counts as unset), otherwise they live under `<home>/.cardloom`. Always absolute; `env` is not
 * mutated. `config` defaults in `config/env.ts` are untouched (Docker and `npm run dev` keep
 * `./knowledge-store`).
 */
export function resolveLauncherEnv(env: NodeJS.ProcessEnv, home: string): LauncherEnv {
  const root = path.resolve(home, '.cardloom');
  return {
    KNOWLEDGE_STORE_PATH: pick(env['KNOWLEDGE_STORE_PATH'], path.join(root, 'knowledge-store')),
    INDEX_DB_PATH: pick(env['INDEX_DB_PATH'], path.join(root, 'index.db')),
  };
}
