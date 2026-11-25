import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readme = readFileSync(resolve(__dirname, '..', 'README.md'), 'utf8');

describe('README claims', () => {
  it('has the FAQ on how cardloom differs from other memory tools', () => {
    expect(readme).toContain('## How is cardloom different from other agent memory tools?');
  });

  it('links to the public trust-guarantees test', () => {
    expect(readme).toContain('tests/integration/trust-guarantees.test.ts');
    expect(existsSync(resolve(__dirname, 'integration', 'trust-guarantees.test.ts'))).toBe(true);
  });

  it.each([/poison/i, /prompt injection/i, /better than/i, /\d+(\.\d+)?k stars/i])(
    'does not match the forbidden claim pattern %s',
    (pattern) => {
      expect(readme).not.toMatch(pattern);
    },
  );
});
