import { describe, it, expect } from 'vitest';
import { buildDistillProjectKnowledgePrompt } from '../../src/prompts/distill-project-knowledge.js';

describe('buildDistillProjectKnowledgePrompt', () => {
  it('embeds the given project_path into the instruction text', () => {
    const result = buildDistillProjectKnowledgePrompt({ project_path: '/repo/sample-app' });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.role).toBe('user');
    const text = (result.messages[0]?.content as { text: string }).text;
    expect(text).toContain('/repo/sample-app');
  });

  it('falls back to a cwd placeholder when project_path is omitted', () => {
    const result = buildDistillProjectKnowledgePrompt({});
    const text = (result.messages[0]?.content as { text: string }).text;
    expect(text).toContain('current working directory');
  });

  it('instructs full enumeration of numbered decision docs and story debug logs, not just a summary', () => {
    const result = buildDistillProjectKnowledgePrompt({});
    const text = (result.messages[0]?.content as { text: string }).text;
    expect(text).toContain('Debug Log References');
    expect(text).toContain('FULL history');
    expect(text.toLowerCase()).toContain('do not sample');
  });

  it('requires error_signature for gotcha cards and real facets for save_learning_draft', () => {
    const result = buildDistillProjectKnowledgePrompt({});
    const text = (result.messages[0]?.content as { text: string }).text;
    expect(text).toContain('error_signature');
    expect(text).toContain('no placeholders');
  });

  it('requires a search_knowledge duplicate check before saving and gates verify on human approval', () => {
    const result = buildDistillProjectKnowledgePrompt({});
    const text = (result.messages[0]?.content as { text: string }).text;
    expect(text).toContain('search_knowledge');
    expect(text).toContain('supersedes');
    expect(text).toContain('Never call `update_card_status` to verify your own card.');
  });

  it('warns that default search hides drafts (AD-10), so the dedup check must pass include_drafts/include_deprecated', () => {
    const result = buildDistillProjectKnowledgePrompt({});
    const text = (result.messages[0]?.content as { text: string }).text;
    expect(text).toContain('include_drafts: true');
    expect(text).toContain('include_deprecated: true');
    expect(text).toContain('AD-10');
    expect(text).toContain('not evidence the hub is empty');
  });

  it('instructs reading PRD/business docs and using domain: product for business-rule cards', () => {
    const result = buildDistillProjectKnowledgePrompt({});
    const text = (result.messages[0]?.content as { text: string }).text;
    expect(text).toContain('PRD');
    expect(text).toContain('not technical');
    expect(text).toContain('domain: product');
  });
});
