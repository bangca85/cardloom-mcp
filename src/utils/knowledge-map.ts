import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

export const KNOWLEDGE_MAP_FILE = '.knowledge-map.yaml';

/**
 * The one reader of `.knowledge-map.yaml` (shared by `upgrade-check` and `context`): the parsed document of the
 * map in `cwd`, or the user-facing message of why there is none. Read-only.
 */
export function readKnowledgeMapDocument(cwd: string): { ok: true; doc: unknown } | { ok: false; message: string } {
  const file = path.join(cwd, KNOWLEDGE_MAP_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { ok: false, message: `no ${KNOWLEDGE_MAP_FILE} in ${cwd}` };
  }
  try {
    return { ok: true, doc: parseYaml(text) };
  } catch (err) {
    return { ok: false, message: `could not parse ${file}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}` };
  }
}

export function normalizeTech(tech: string): string {
  return tech.trim().toLowerCase().replace(/\s+/g, '-');
}

/** Splits `tech@version` at the last `@` (so a scoped name like `@scope/pkg@1` keeps its first `@`). */
export function splitTechVersion(entry: string): { tech: string; version: string | undefined } {
  const at = entry.lastIndexOf('@');
  if (at <= 0) return { tech: normalizeTech(entry), version: undefined };
  const version = entry.slice(at + 1).trim();
  return { tech: normalizeTech(entry.slice(0, at)), version: version === '' ? undefined : version };
}
