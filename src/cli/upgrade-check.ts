import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import type Database from 'better-sqlite3';
import { validRange } from 'semver';
import { parse as parseYaml } from 'yaml';
import { config } from '../config/env.js';
import { initializeSchema } from '../db/schema.js';
import { cardDriftsFor } from '../services/search-service.js';
import { buildFreshIndex } from './benchmark.js';

const LIST_CAP = 20;
const MAP_FILE = '.knowledge-map.yaml';

export interface UpgradeCheck {
  tech: string;
  from: string;
  to: string;
  stopApplying: string[];
  startApplying: string[];
  stillApplying: string[];
}

/** A user-facing failure (bad map, unknown tech): the message is printed as is, exit 1. */
export class UpgradeCheckError extends Error {}

function normalizeTech(tech: string): string {
  return tech.trim().toLowerCase().replace(/\s+/g, '-');
}

/** Splits `tech@version` at the last `@` (so a scoped name like `@scope/pkg@1` keeps its first `@`). */
function splitTechVersion(entry: string): { tech: string; version: string | undefined } {
  const at = entry.lastIndexOf('@');
  if (at <= 0) return { tech: normalizeTech(entry), version: undefined };
  const version = entry.slice(at + 1).trim();
  return { tech: normalizeTech(entry.slice(0, at)), version: version === '' ? undefined : version };
}

interface CardLine {
  id: string;
  stack: string;
  version_range: string;
  status: string;
}

/**
 * For each `tech@version` target: the verified cards (default search visibility: verified + normal, AD-10) that
 * stop applying, start applying, or apply at both the map's version and the target. Read-only. Whether a card
 * "applies" is the search drift rule (`cardDriftsFor`), never a second implementation.
 */
export function runUpgradeCheck(db: Database.Database, map: { stack: string[] }, targets: string[]): UpgradeCheck[] {
  const mapped = new Map<string, string | undefined>();
  for (const entry of map.stack) {
    const { tech, version } = splitTechVersion(entry);
    mapped.set(tech, version);
  }

  const resolved = targets.map((target) => {
    const { tech, version: to } = splitTechVersion(target);
    if (!mapped.has(tech)) {
      const known = [...mapped.keys()].join(', ');
      throw new UpgradeCheckError(`unknown tech "${tech}" in --to: it is not in the stack of ${MAP_FILE} (${known || 'empty stack'})`);
    }
    const from = mapped.get(tech);
    if (from === undefined) {
      throw new UpgradeCheckError(`"${tech}" has no version in ${MAP_FILE}: write it as ${tech}@<version> to check an upgrade`);
    }
    if (to === undefined) {
      throw new UpgradeCheckError(`--to ${target} has no version: write it as ${tech}@<version>`);
    }
    // normalizeRange (facets-intersect) turns a value semver rejects (latest, canary, rc) into "*", which would
    // make every card apply (a bare x, * or empty range is also "*"): refuse such versions instead of printing a confidently wrong list.
    for (const [value, source] of [
      [from, `${tech} in ${MAP_FILE}`],
      [to, `--to ${target}`],
    ] as const) {
      const range = validRange(value);
      if (range === null) {
        throw new UpgradeCheckError(`"${value}" (${source}) is not a semver version or range: write a number such as ${tech}@15.0.0`);
      }
      if (range === '*') {
        throw new UpgradeCheckError(`"${value}" (${source}) is a wildcard, not a version: write a number such as ${tech}@15.0.0`);
      }
    }
    return { tech, from, to };
  });

  const rows = db
    .prepare("SELECT id, stack, version_range, status FROM cards WHERE status = 'verified' AND sensitivity = 'normal' AND version_range != '*' ORDER BY id")
    .all() as CardLine[];

  return resolved.map(({ tech, from, to }) => {
    const check: UpgradeCheck = { tech, from, to, stopApplying: [], startApplying: [], stillApplying: [] };
    for (const row of rows) {
      // An empty or invalid range is read as "*" by normalizeRange: leave it out like a literal "*".
      const normalized = validRange(row.version_range);
      if (normalized === null || normalized === '*') continue;
      let stackTags: unknown;
      try {
        stackTags = JSON.parse(row.stack);
      } catch {
        continue;
      }
      if (!Array.isArray(stackTags) || !stackTags.some((t) => typeof t === 'string' && normalizeTech(t) === tech)) continue;
      const appliesAtFrom = !cardDriftsFor(row, [tech], { [tech]: from });
      const appliesAtTo = !cardDriftsFor(row, [tech], { [tech]: to });
      if (appliesAtFrom && !appliesAtTo) check.stopApplying.push(row.id);
      else if (!appliesAtFrom && appliesAtTo) check.startApplying.push(row.id);
      else if (appliesAtFrom && appliesAtTo) check.stillApplying.push(row.id);
    }
    // rows are ordered by id already; the cap keeps the first 20.
    check.stopApplying = check.stopApplying.slice(0, LIST_CAP);
    check.startApplying = check.startApplying.slice(0, LIST_CAP);
    check.stillApplying = check.stillApplying.slice(0, LIST_CAP);
    return check;
  });
}

/** Reads the `stack` list of `.knowledge-map.yaml` in `cwd`. Throws an `UpgradeCheckError` with the message to print. */
export function loadKnowledgeMap(cwd: string): { stack: string[] } {
  const file = path.join(cwd, MAP_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new UpgradeCheckError(`no ${MAP_FILE} in ${cwd}`);
  }
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new UpgradeCheckError(`could not parse ${file}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
  const stack = typeof doc === 'object' && doc !== null ? (doc as { stack?: unknown }).stack : undefined;
  if (!Array.isArray(stack) || !stack.every((s) => typeof s === 'string' || typeof s === 'number')) {
    throw new UpgradeCheckError(`${file} has no "stack" list of tech@version entries`);
  }
  return { stack: stack.map(String) };
}

function section(label: string, ids: string[], titles: Map<string, string>): string[] {
  const count = ids.length >= LIST_CAP ? `${ids.length}, capped at ${LIST_CAP}` : String(ids.length);
  const lines = [`  ${label} (${count})`];
  for (const id of ids) lines.push(`    ${id} · ${titles.get(id) ?? ''}`.trimEnd());
  return lines;
}

export function formatUpgradeCheck(checks: UpgradeCheck[], titles: Map<string, string>): string {
  const blocks = checks.map((c) => {
    const lines = [`${c.tech} ${c.from} -> ${c.to}`, ''];
    if (c.stopApplying.length === 0 && c.startApplying.length === 0) {
      lines.push(`  Nothing changes for ${c.tech}`);
      if (c.stillApplying.length > 0) lines.push('', ...section('Apply to both', c.stillApplying, titles));
      return lines.join('\n');
    }
    lines.push(
      ...section('Stop applying', c.stopApplying, titles),
      '',
      ...section('Start applying', c.startApplying, titles),
      '',
      ...section('Apply to both', c.stillApplying, titles),
    );
    return lines.join('\n');
  });
  return blocks.join('\n\n');
}

function titlesOf(db: Database.Database, checks: UpgradeCheck[]): Map<string, string> {
  const ids = new Set(checks.flatMap((c) => [...c.stopApplying, ...c.startApplying, ...c.stillApplying]));
  const titles = new Map<string, string>();
  const stmt = db.prepare('SELECT title FROM cards WHERE id = ?');
  for (const id of ids) titles.set(id, (stmt.get(id) as { title: string }).title);
  return titles;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Read-only: builds a throwaway in-memory index from the card files (AD-2), never writes and never creates the
 * store. Failures that the user can fix come back as `exitCode: 1` with the message on `stderr`.
 */
export async function runUpgradeCheckCommand(
  storePath: string,
  cwd: string,
  opts: { targets: string[]; json: boolean },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let db: Database.Database | undefined;
  try {
    const map = loadKnowledgeMap(cwd);
    if (isDirectory(storePath)) {
      db = await buildFreshIndex(storePath);
    } else {
      db = new BetterSqlite3(':memory:');
      initializeSchema(db);
    }
    const checks = runUpgradeCheck(db, map, opts.targets);
    const stdout = opts.json ? JSON.stringify(checks, null, 2) : formatUpgradeCheck(checks, titlesOf(db, checks));
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err) {
    if (err instanceof UpgradeCheckError) return { stdout: '', stderr: err.message, exitCode: 1 };
    throw err;
  } finally {
    db?.close();
  }
}

export const UPGRADE_CHECK_USAGE = 'Usage: upgrade-check --to <tech>@<version> [--to <tech>@<version> ...] [--json]';

/** `help` is set only when `--help` / `-h` was given: the caller prints the usage and exits 0. */
export function parseUpgradeCheckArgs(argv: string[]): { targets: string[]; json: boolean; help?: true } | null {
  const targets: string[] = [];
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { targets, json, help: true };
    if (a === '--json') json = true;
    else if (a === '--to') {
      const value = argv[++i];
      if (value === undefined) return null;
      const at = value.lastIndexOf('@');
      if (at <= 0 || at === value.length - 1) return null;
      targets.push(value);
    } else return null;
  }
  return targets.length === 0 ? null : { targets, json };
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = parseUpgradeCheckArgs(process.argv.slice(2));
  if (args === null) {
    console.error(UPGRADE_CHECK_USAGE);
    process.exit(1);
  }
  if (args.help) {
    console.log(UPGRADE_CHECK_USAGE);
    process.exit(0);
  }
  runUpgradeCheckCommand(config.knowledgeStorePath, process.cwd(), args)
    .then(({ stdout, stderr, exitCode }) => {
      if (stdout !== '') console.log(stdout);
      if (stderr !== '') console.error(stderr);
      process.exitCode = exitCode;
    })
    .catch((err: unknown) => {
      console.error('[upgrade-check] failed:', err);
      process.exit(1);
    });
}
