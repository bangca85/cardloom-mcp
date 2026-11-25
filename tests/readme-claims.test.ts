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

  it.each([/poison/i, /prompt[- ]injection/i, /better than/i, /\d+(\.\d+)?k stars/i])(
    'does not match the forbidden claim pattern %s',
    (pattern) => {
      expect(readme).not.toMatch(pattern);
    },
  );
});

describe('README FAQ attribution', () => {
  const paragraphs = readme.split(/\n\s*\n/);

  it('does not credit trust-guarantees with upgrade-check, reconfirm, report or the SessionStart hook', () => {
    const linked = paragraphs.filter((p) => p.includes('tests/integration/trust-guarantees.test.ts'));
    expect(linked.length).toBeGreaterThan(0);
    for (const p of linked) {
      expect(p).not.toMatch(/upgrade-check/);
      expect(p).not.toMatch(/reconfirm/i);
      expect(p).not.toMatch(/\breport\b/);
      expect(p).not.toMatch(/SessionStart/);
    }
  });

  it('keeps the FAQ under 220 words', () => {
    const start = readme.indexOf('## How is cardloom different from other agent memory tools?');
    const end = readme.indexOf('\n## ', start + 1);
    const words = readme.slice(start, end).split(/\s+/).filter(Boolean).length;
    expect(words).toBeLessThan(220);
  });
});
