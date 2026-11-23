import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

/**
 * The image has no global git identity. For a brand-new knowledge store the entrypoint runs
 * `git init` and then an empty commit; if the commit runs before user.email / user.name are set,
 * git aborts ("Author identity unknown") and `set -e` ends the container on its very first start.
 * The maintainer never saw it because an existing store already has a .git directory.
 */
describe('docker-entrypoint.sh', () => {
  const script = fs.readFileSync(new URL('../docker-entrypoint.sh', import.meta.url), 'utf-8');

  it('sets the git identity between `git init` and the first commit for a fresh store', () => {
    const start = script.indexOf('if [ ! -d "$KNOWLEDGE_STORE_PATH/.git" ]; then');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = script.indexOf('\nfi', start);
    const block = script.slice(start, end);

    const init = block.indexOf(' init');
    const email = block.indexOf('config user.email');
    const name = block.indexOf('config user.name');
    const commit = block.indexOf(' commit ');

    expect(init).toBeGreaterThan(-1);
    expect(commit).toBeGreaterThan(-1);
    expect(email).toBeGreaterThan(init);
    expect(name).toBeGreaterThan(init);
    expect(email).toBeLessThan(commit);
    expect(name).toBeLessThan(commit);
  });

  it('still sets the identity for a store that already exists (pre-cloned or created on the host)', () => {
    const afterBlock = script.slice(script.indexOf('\nfi', script.indexOf('if [ ! -d "$KNOWLEDGE_STORE_PATH/.git" ]')));
    expect(afterBlock).toContain('config user.email "cardloom-mcp@local"');
    expect(afterBlock).toContain('config user.name "cardloom-mcp"');
  });
});
