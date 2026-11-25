import fs from 'node:fs';
import { config } from '../config/env.js';
import { getDatabase, closeDatabase } from '../db/database.js';
import { initKnowledgeStore } from '../services/knowledge-store.js';
import { reconcileIndex } from '../services/index-reconciler.js';
import { listStaleCards, reconfirmCards, type StaleCard } from '../services/reconfirm-service.js';
import { buildFreshIndex } from './benchmark.js';

export const RECONFIRM_USAGE = [
  'Usage: reconfirm --stale [--json]',
  '       reconfirm --confirm <id>@<hash>[,<id>@<hash>...] [--by <name>]',
  '',
  '  --stale    list verified cards last verified more than STALE_THRESHOLD_DAYS ago, oldest first, with the hash to confirm them with',
  '  --confirm  re-confirm the listed cards (a human re-checked them and they are still right); refused if the file changed since it was listed',
  '             or the card needs review; the others are still applied, and the exit code is 1 if any was refused',
  '  --by       who re-confirmed; defaults to REVIEWER_NAME. It is recorded in the git commit message, not in the card file',
].join('\n');

export interface ReconfirmEntry {
  id: string;
  hash: string;
}

/** `help` is set only when `--help` / `-h` was given: the caller prints the usage and exits 0. */
export type ReconfirmArgs = { help: true } | { stale: true; json: boolean } | { confirm: ReconfirmEntry[]; by?: string };

const ENTRY = /^([a-z0-9][a-z0-9-]*)@([0-9a-f]{64})$/;

function parseEntries(raw: string): ReconfirmEntry[] | null {
  const entries: ReconfirmEntry[] = [];
  for (const part of raw.split(',')) {
    const m = ENTRY.exec(part);
    if (!m) return null;
    entries.push({ id: m[1]!, hash: m[2]! });
  }
  return entries;
}

export function parseReconfirmArgs(argv: string[]): ReconfirmArgs | null {
  let stale = false;
  let json = false;
  let confirm: ReconfirmEntry[] | undefined;
  let by: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--stale') stale = true;
    else if (a === '--json') json = true;
    else if (a === '--confirm') {
      const raw = argv[++i];
      const entries = raw === undefined ? null : parseEntries(raw);
      if (entries === null) return null;
      confirm = entries;
    } else if (a === '--by') {
      const raw = argv[++i];
      if (raw === undefined || raw.trim() === '') return null;
      by = raw;
    } else return null;
  }
  if (stale && confirm === undefined && by === undefined) return { stale: true, json };
  if (!stale && confirm !== undefined && !json) return by === undefined ? { confirm } : { confirm, by };
  return null;
}

function isDirectory(p: string | undefined): boolean {
  if (p === undefined) return false;
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function formatStaleList(list: StaleCard[]): string {
  if (list.length === 0) return 'No stale cards.';
  const out = [`${list.length} stale card(s) (last verified more than ${config.staleThresholdDays} days ago, oldest first):`];
  for (const c of list) {
    out.push(
      `  ${c.id}  ${c.title}  ${plural(c.ageDays, 'day', 'days')}  ${c.hash}${c.needsReview ? '  needs_review (cannot be re-confirmed: supersede it)' : ''}`,
    );
  }
  out.push('Re-confirm with: cardloom-mcp reconfirm --confirm <id>@<hash>[,<id>@<hash>...] [--by <name>]');
  return out.join('\n');
}

/** Read-only: a throwaway in-memory index built from the card files and events; never creates the store. */
export async function runReconfirmStale(storePath: string | undefined, opts: { json: boolean; now?: Date }): Promise<string> {
  let list: StaleCard[] = [];
  if (storePath !== undefined && isDirectory(storePath)) {
    const db = await buildFreshIndex(storePath);
    try {
      list = listStaleCards(db, storePath, opts.now ?? new Date());
    } finally {
      db.close();
    }
  }
  return opts.json ? JSON.stringify(list, null, 2) : formatStaleList(list);
}

export interface CommandOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Writes through `updateCardStatus` (so through the MutationPipeline, AD-3) on the live index. */
export async function runReconfirmConfirm(
  storePath: string | undefined,
  indexDbPath: string | undefined,
  entries: ReconfirmEntry[],
  by?: string,
): Promise<CommandOutput> {
  const actor = by ?? config.reviewerName;
  if (storePath === undefined || indexDbPath === undefined || !isDirectory(storePath)) {
    // Nothing to re-confirm in a store that does not exist; do not create one.
    return {
      stdout: '',
      stderr: entries.map((e) => `refused ${e.id}: Not found: ${e.id}`).join('\n'),
      exitCode: entries.length > 0 ? 1 : 0,
    };
  }
  await initKnowledgeStore(storePath);
  const db = getDatabase(indexDbPath);
  try {
    // The server may not be running; make sure the index sees the same cards and refutations the files hold.
    await reconcileIndex(db, storePath);
    const res = await reconfirmCards(db, storePath, entries, actor);
    return {
      stdout: res.reconfirmed.map((id) => `reconfirmed ${id} (by ${actor})`).join('\n'),
      stderr: res.refused.map((r) => `refused ${r.id}: ${r.reason}`).join('\n'),
      exitCode: res.refused.length > 0 ? 1 : 0,
    };
  } finally {
    closeDatabase();
  }
}

/** Dispatches parsed (non-help) arguments; the launcher and `npm run reconfirm` share it. */
export async function runReconfirmCommand(
  storePath: string | undefined,
  indexDbPath: string | undefined,
  args: Exclude<ReconfirmArgs, { help: true }>,
): Promise<CommandOutput> {
  if ('stale' in args) {
    return { stdout: await runReconfirmStale(storePath, { json: args.json }), stderr: '', exitCode: 0 };
  }
  return runReconfirmConfirm(storePath, indexDbPath, args.confirm, args.by);
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = parseReconfirmArgs(process.argv.slice(2));
  if (args === null) {
    console.error(RECONFIRM_USAGE);
    process.exit(1);
  }
  if ('help' in args) {
    console.log(RECONFIRM_USAGE);
    process.exit(0);
  }
  runReconfirmCommand(config.knowledgeStorePath, config.indexDbPath, args)
    .then(({ stdout, stderr, exitCode }) => {
      if (stdout !== '') console.log(stdout);
      if (stderr !== '') console.error(stderr);
      process.exit(exitCode);
    })
    .catch((err: unknown) => {
      console.error('[reconfirm] failed:', err);
      process.exit(1);
    });
}
