import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

/**
 * The MCP Registry checks that `mcpName` in the published package equals `name` in server.json, and
 * that the versions match what is on npm. A mismatch only shows up when publishing, so pin it here.
 */
describe('MCP Registry metadata', () => {
  const read = (file: string) => JSON.parse(fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf-8'));
  const pkg = read('package.json');
  const server = read('server.json');

  it('mcpName in package.json equals the name in server.json', () => {
    expect(pkg.mcpName).toBe(server.name);
    expect(server.name).toMatch(/^io\.github\.[^/]+\/[^/]+$/);
  });

  it('versions in server.json equal the package version', () => {
    expect(server.version).toBe(pkg.version);
    expect(server.packages).toHaveLength(1);
    expect(server.packages[0].identifier).toBe(pkg.name);
    expect(server.packages[0].version).toBe(pkg.version);
  });

  it('keeps the description within the Registry limit of 100 characters', () => {
    expect(server.description.length).toBeLessThanOrEqual(100);
  });

  it('does not ship server.json in the npm package', () => {
    expect(pkg.files).not.toContain('server.json');
  });
});
