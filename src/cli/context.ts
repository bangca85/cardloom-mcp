import { openIndexReadOnly } from '../db/open-readonly.js';
import { buildSessionContext } from '../services/session-context-service.js';
import { PROJECT_KEY_RE, normalizeProjectKey } from '../utils/facets-intersect.js';
import { readKnowledgeMapDocument, splitTechVersion } from '../utils/knowledge-map.js';

// `cardloom-mcp context`: prints a short list of verified cards for the current project, for a SessionStart
// hook (`install --hooks` registers one). A CLI: stdout is the hook's output. It only ever reads the existing
// index; whatever is wrong (no index, an old index, no map) it prints nothing and exits 0 so a session never breaks.

const DEFAULT_MAX_CARDS = 5;
const DEFAULT_MAX_ESTIMATED_TOKENS = 800;

export const CONTEXT_USAGE = [
  'Usage: context [--project <key>] [--max-cards 5] [--max-estimated-tokens 800]',
  '',
  '  Prints the verified, normal-sensitivity cards of the current project (and global ones) as a short list,',
  '  for a Claude Code SessionStart hook. Read-only: it never builds an index and prints nothing when there is',
  '  no index, no eligible card, or no project.',
  '  The project, its aliases and the stack come from .knowledge-map.yaml in the current directory;',
  '  --project <key> uses that key instead and does not read the map.',
  '  --max-cards              most cards to print (default 5)',
  '  --max-estimated-tokens   estimated-token budget of the whole output (default 800)',
].join('\n');

export interface ContextArgs {
  project?: string;
  maxCards: number;
  maxEstimatedTokens: number;
}

function positiveInt(value: string | undefined): number | null {
  if (value === undefined || !/^[0-9]+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** `help` is set only when `--help` / `-h` was given: the caller prints the usage and exits 0. `null`: a usage error. */
export function parseContextArgs(argv: string[]): (ContextArgs & { help?: true }) | null {
  const args: ContextArgs = { maxCards: DEFAULT_MAX_CARDS, maxEstimatedTokens: DEFAULT_MAX_ESTIMATED_TOKENS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { ...args, help: true };
    if (a === '--project') {
      const value = argv[++i];
      if (value === undefined) return null;
      const key = normalizeProjectKey(value);
      if (!PROJECT_KEY_RE.test(key)) return null;
      args.project = key;
    } else if (a === '--max-cards') {
      const n = positiveInt(argv[++i]);
      if (n === null) return null;
      args.maxCards = n;
    } else if (a === '--max-estimated-tokens') {
      const n = positiveInt(argv[++i]);
      if (n === null) return null;
      args.maxEstimatedTokens = n;
    } else return null;
  }
  return args;
}

interface MapContext {
  project?: string;
  aliases: string[];
  stack: string[];
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string | number => typeof v === 'string' || typeof v === 'number').map(String) : [];

/** `project:` (or the legacy `repo:`), `aliases:` and the tech names of `stack:` from the map in `cwd`; `{}`-like when unusable. */
function readMapContext(cwd: string): MapContext {
  const read = readKnowledgeMapDocument(cwd);
  const empty: MapContext = { aliases: [], stack: [] };
  if (!read.ok || typeof read.doc !== 'object' || read.doc === null) return empty;
  const doc = read.doc as Record<string, unknown>;
  const key = [doc['project'], doc['repo']]
    .map((v) => (typeof v === 'string' ? normalizeProjectKey(v) : ''))
    .find((v) => v !== '');
  return {
    project: key !== undefined && PROJECT_KEY_RE.test(key) ? key : undefined,
    aliases: strings(doc['aliases']).map(normalizeProjectKey).filter((a) => PROJECT_KEY_RE.test(a)),
    stack: strings(doc['stack']).map((entry) => splitTechVersion(entry).tech).filter((t) => t !== ''),
  };
}

/**
 * Whatever goes wrong comes back as empty output and exit 0. Nothing is written or created: the index is opened
 * read-only (`openIndexReadOnly`), the map is only read.
 */
export async function runContext(
  env: { INDEX_DB_PATH?: string },
  cwd: string,
  args: ContextArgs,
): Promise<{ stdout: string; exitCode: 0 | 1 }> {
  const nothing = { stdout: '', exitCode: 0 as const };
  try {
    const map: MapContext = args.project !== undefined ? { project: args.project, aliases: [], stack: [] } : readMapContext(cwd);
    if (map.project === undefined) return nothing;
    const db = openIndexReadOnly(env.INDEX_DB_PATH ?? '');
    if (db === null) return nothing;
    try {
      const result = buildSessionContext(db, {
        project: map.project,
        aliases: map.aliases,
        stack: map.stack,
        maxCards: args.maxCards,
        maxEstimatedTokens: args.maxEstimatedTokens,
      });
      return { stdout: result.text, exitCode: 0 };
    } finally {
      db.close();
    }
  } catch {
    return nothing;
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = parseContextArgs(process.argv.slice(2));
  if (args === null) {
    console.error(CONTEXT_USAGE);
    process.exit(1);
  }
  if ('help' in args) {
    console.log(CONTEXT_USAGE);
    process.exit(0);
  }
  runContext(process.env, process.cwd(), args)
    .then(({ stdout }) => {
      if (stdout !== '') console.log(stdout);
    })
    .catch(() => {
      // a hook never breaks the session
    });
}
