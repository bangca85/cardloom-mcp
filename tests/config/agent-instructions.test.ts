import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_INSTRUCTIONS } from '../../src/config/agent-instructions.js';

const readme = readFileSync(resolve(__dirname, '..', '..', 'README.md'), 'utf8');

describe('AGENT_INSTRUCTIONS', () => {
  it('is the block under "Enforcing usage" in the README, verbatim', () => {
    expect(readme).toContain(AGENT_INSTRUCTIONS);
  });

  it('starts at the Knowledge Hub heading and ends with the mismatch rule', () => {
    expect(AGENT_INSTRUCTIONS.startsWith('## Knowledge Hub (MCP `cardloom`) — required')).toBe(true);
    expect(AGENT_INSTRUCTIONS.endsWith('architecture or security call.')).toBe(true);
  });

  it('carries no cardloom markers of its own', () => {
    expect(AGENT_INSTRUCTIONS).not.toContain('cardloom:start');
    expect(AGENT_INSTRUCTIONS).not.toContain('cardloom:end');
  });
});
