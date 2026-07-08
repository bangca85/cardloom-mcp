import fs from 'node:fs';
import path from 'node:path';

export function generateDummyCards(count: number, outputDir: string): void {
  fs.mkdirSync(outputDir, { recursive: true });
  const cardsDir = path.join(outputDir, 'cards');
  fs.mkdirSync(cardsDir, { recursive: true });

  const stacks = ['typescript', 'javascript', 'node', 'react', 'sqlite', 'docker', 'go', 'python'];
  const domains = ['frontend', 'backend', 'infra', 'AI', 'product'];
  const types = ['decision', 'pattern', 'snippet', 'gotcha', 'playbook'];

  for (let i = 1; i <= count; i++) {
    const id = `decision-dummy-${i}`;
    const cardType = types[i % types.length];
    const cardDomain = domains[i % domains.length];
    const cardStack = [stacks[i % stacks.length], stacks[(i + 1) % stacks.length]];
    
    // Create relation links
    const supersedes = i > 1 ? `decision-dummy-${i - 1}` : '';
    
    const conflicts: string[] = [];
    if (i > 5 && i % 3 === 0) {
      const randomPrev = Math.floor(Math.random() * (i - 1)) + 1;
      conflicts.push(`decision-dummy-${randomPrev}`);
    }

    const frontmatter = [
      '---',
      `title: Dummy Card ${i}`,
      `type: ${cardType}`,
      `scope: project`,
      `applies_to: [api]`,
      `stack: [${cardStack.join(', ')}]`,
      `version_range: '*'`,
      `status: verified`,
      `sensitivity: normal`,
      `verified_by: human-reviewer`,
      `verification_method: benchmark-tool`,
      `last_verified: '${new Date().toISOString()}'`,
      `source_commit: 'dummy-commit-${i}'`,
      `provenance: 'benchmark-generation'`,
    ];

    if (supersedes) {
      frontmatter.push(`supersedes: ${supersedes}`);
    }
    if (conflicts.length > 0) {
      frontmatter.push(`conflicts_with: [${conflicts.join(', ')}]`);
    }
    if (cardType === 'gotcha') {
      frontmatter.push(`error_signature: 'Error signature for gotcha ${i}'`);
    }
    if (cardDomain) {
      frontmatter.push(`domain: ${cardDomain}`);
    }

    frontmatter.push('---');
    frontmatter.push(`Body for dummy card ${i} describing some random technical pattern.`);

    fs.writeFileSync(path.join(cardsDir, `${id}.md`), frontmatter.join('\n') + '\n');
  }
  console.error(`[generator] Successfully generated ${count} dummy cards in ${outputDir}`);
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = process.argv.slice(2);
  const count = parseInt(args[0] || '100', 10);
  const outputDir = args[1] || './benchmark-vault';
  if (isNaN(count) || count <= 0) {
    console.error('Usage: npx tsx src/cli/generate-dummy-cards.ts <count> [output_directory]');
    process.exit(1);
  }
  generateDummyCards(count, outputDir);
}
