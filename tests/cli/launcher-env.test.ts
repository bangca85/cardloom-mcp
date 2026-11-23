import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveLauncherEnv } from '../../src/cli/launcher-env.js';

const HOME = path.resolve('/home/someone');

describe('resolveLauncherEnv', () => {
  it('defaults both paths to ~/.cardloom when env is empty', () => {
    expect(resolveLauncherEnv({}, HOME)).toEqual({
      KNOWLEDGE_STORE_PATH: path.join(HOME, '.cardloom', 'knowledge-store'),
      INDEX_DB_PATH: path.join(HOME, '.cardloom', 'index.db'),
    });
  });

  it('keeps values that are already set', () => {
    const store = path.resolve('/data/store');
    const db = path.resolve('/data/idx/index.db');
    expect(resolveLauncherEnv({ KNOWLEDGE_STORE_PATH: store, INDEX_DB_PATH: db }, HOME)).toEqual({
      KNOWLEDGE_STORE_PATH: store,
      INDEX_DB_PATH: db,
    });
  });

  it('keeps one set value and defaults the other', () => {
    const store = path.resolve('/data/store');
    expect(resolveLauncherEnv({ KNOWLEDGE_STORE_PATH: store }, HOME)).toEqual({
      KNOWLEDGE_STORE_PATH: store,
      INDEX_DB_PATH: path.join(HOME, '.cardloom', 'index.db'),
    });
  });

  it('treats blank strings as unset', () => {
    expect(resolveLauncherEnv({ KNOWLEDGE_STORE_PATH: '', INDEX_DB_PATH: '   ' }, HOME)).toEqual({
      KNOWLEDGE_STORE_PATH: path.join(HOME, '.cardloom', 'knowledge-store'),
      INDEX_DB_PATH: path.join(HOME, '.cardloom', 'index.db'),
    });
  });

  it('never returns a relative path, even for relative env values or home', () => {
    const fromEnv = resolveLauncherEnv({ KNOWLEDGE_STORE_PATH: 'rel/store', INDEX_DB_PATH: 'rel/index.db' }, HOME);
    expect(path.isAbsolute(fromEnv.KNOWLEDGE_STORE_PATH)).toBe(true);
    expect(path.isAbsolute(fromEnv.INDEX_DB_PATH)).toBe(true);
    const fromRelHome = resolveLauncherEnv({}, 'relhome');
    expect(path.isAbsolute(fromRelHome.KNOWLEDGE_STORE_PATH)).toBe(true);
    expect(path.isAbsolute(fromRelHome.INDEX_DB_PATH)).toBe(true);
  });

  it('does not mutate the env passed in', () => {
    const env: NodeJS.ProcessEnv = { OTHER: 'x' };
    resolveLauncherEnv(env, HOME);
    expect(env).toEqual({ OTHER: 'x' });
  });
});
