import fs from 'node:fs';
import { parse } from 'yaml';
import type { EvalTask } from './types.js';

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

export function parseTasks(yamlText: string): EvalTask[] {
  const raw = parse(yamlText) as unknown;
  if (!Array.isArray(raw)) throw new Error('tasks file must be a YAML list');
  const seen = new Set<string>();
  return raw.map((entry: Record<string, unknown>, i) => {
    const where = `task #${i + 1}`;
    if (typeof entry.id !== 'string' || entry.id === '') throw new Error(`${where}: id is required`);
    if (seen.has(entry.id)) throw new Error(`${where}: duplicate id ${entry.id}`);
    seen.add(entry.id);
    if (typeof entry.prompt !== 'string' || typeof entry.repo !== 'string') throw new Error(`${entry.id}: prompt and repo are required`);
    if (!isStringArray(entry.required_cards)) throw new Error(`${entry.id}: required_cards must be a list of ids`);
    if (entry.exceptions !== undefined && !isStringArray(entry.exceptions)) throw new Error(`${entry.id}: exceptions must be a list of strings`);
    if (!Array.isArray(entry.rubric) || entry.rubric.length === 0) throw new Error(`${entry.id}: rubric must be a non-empty list`);
    const rubric = (entry.rubric as Array<Record<string, unknown>>).map((item) => {
      if (item.must_include !== undefined && !isStringArray(item.must_include)) throw new Error(`${entry.id}: must_include must be a list of strings`);
      if (item.must_not_include !== undefined && !isStringArray(item.must_not_include)) throw new Error(`${entry.id}: must_not_include must be a list of strings`);
      return { ...(item.must_include && { must_include: item.must_include as string[] }), ...(item.must_not_include && { must_not_include: item.must_not_include as string[] }) };
    });
    return {
      id: entry.id,
      prompt: entry.prompt,
      repo: entry.repo,
      required_cards: entry.required_cards,
      ...(entry.exceptions !== undefined && { exceptions: entry.exceptions }),
      rubric,
    };
  });
}

export function loadTasks(file: string): EvalTask[] {
  return parseTasks(fs.readFileSync(file, 'utf-8'));
}
