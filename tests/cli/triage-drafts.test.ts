import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { formatTriageReport, runTriage } from '../../src/cli/triage-drafts.js';
import type { TriageReport } from '../../src/services/triage-service.js';

function card(title: string, status: 'draft' | 'verified' | 'deprecated', extra = ''): string {
  const verified =
    status === 'draft'
      ? ''
      : 'verified_by: reviewer\nverification_method: manual-review\nlast_verified: "2026-01-01T00:00:00Z"\n';
  const dep = status === 'deprecated' ? 'deprecated_at: "2026-01-02T00:00:00Z"\ndeprecated_by: reviewer\n' : '';
  return `---
type: pattern
scope: project
applies_to: [api]
stack: [node]
version_range: ">=1.0.0"
sensitivity: normal
source_commit: abc123
provenance: agent-observation
title: ${title}
status: ${status}
${verified}${dep}${extra}---
Body of ${title}.
`;
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cardloom-mcp-triage-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeCard(name: string, content: string): void {
  fs.mkdirSync(path.join(tmp, 'cards'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'cards', name), content);
}

const REPORT: TriageReport = {
  checked: 2,
  withRelated: [
    {
      id: 'pattern-enable',
      title: 'Enable retries for payment requests',
      type: 'pattern',
      ageDays: 3,
      supersedes: null,
      related: [
        {
          id: 'gotcha-x',
          status: 'verified',
          title: 'Disable retries for payment requests',
          titleSimilarity: 0.67,
          facetsOverlap: true,
          sameProject: false,
          isSupersedeTarget: false,
        },
        {
          id: 'pattern-old',
          status: 'deprecated',
          title: 'Old thing',
          titleSimilarity: 0,
          facetsOverlap: false,
          sameProject: true,
          isSupersedeTarget: true,
          alreadySupersededBy: 'pattern-y',
        },
        {
          id: 'pattern-rej',
          status: 'deprecated',
          title: 'Rejected thing',
          titleSimilarity: 0.5,
          facetsOverlap: false,
          sameProject: null,
          isSupersedeTarget: false,
          rejectionReason: 'rejected: duplicate',
        },
      ],
    },
  ],
  withoutRelated: [
    { id: 'pattern-alone', title: 'Lonely idea', type: 'pattern', ageDays: 1, supersedes: null, related: [] },
  ],
};

describe('formatTriageReport', () => {
  it('prints an empty store as "No drafts to triage."', () => {
    expect(formatTriageReport({ checked: 0, withRelated: [], withoutRelated: [] })).toBe('No drafts to triage.');
  });

  it('lists each draft with evidence lines under "Compare before deciding"', () => {
    const out = formatTriageReport(REPORT);
    expect(out).toContain('Compare before deciding');
    expect(out).toContain('pattern-enable');
    expect(out).toContain('verified gotcha-x · title 0.67 · same facets · other project');
    expect(out).toContain('replaces this card');
    expect(out).toContain('already replaced by pattern-y');
    expect(out).toContain('rejected: duplicate');
  });

  it('does not present facet overlap on the supersede target as a finding', () => {
    const out = formatTriageReport({
      ...REPORT,
      withRelated: [
        {
          ...REPORT.withRelated[0]!,
          related: [{ ...REPORT.withRelated[0]!.related[0]!, isSupersedeTarget: true, facetsOverlap: true }],
        },
      ],
    });
    expect(out).not.toContain('same facets');
  });

  it('lists drafts without a related card under "No related card"', () => {
    const out = formatTriageReport(REPORT);
    expect(out).toContain('No related card');
    expect(out).toContain('pattern-alone · Lonely idea');
  });

  it('never uses the word "deprecate" (it states facts, not commands)', () => {
    expect(formatTriageReport(REPORT).toLowerCase()).not.toContain('deprecate');
  });

  it('handles a single draft with no related cards', () => {
    const out = formatTriageReport({ checked: 1, withRelated: [], withoutRelated: REPORT.withoutRelated });
    expect(out).toContain('No related card');
    expect(out).not.toContain('Compare before deciding');
  });
});

describe('runTriage', () => {
  it('returns "No drafts to triage." for a missing store and creates nothing', async () => {
    const store = path.join(tmp, 'missing');
    expect(await runTriage(store, {})).toBe('No drafts to triage.');
    expect(fs.existsSync(store)).toBe(false);
  });

  it('returns "No drafts to triage." when the store has only verified cards', async () => {
    writeCard('pattern-v.md', card('Verified only', 'verified'));
    expect(await runTriage(tmp, {})).toBe('No drafts to triage.');
  });

  it('puts one draft alone under "No related card"', async () => {
    writeCard('pattern-d.md', card('Alone draft', 'draft'));
    const out = await runTriage(tmp, {});
    expect(out).toContain('No related card');
    expect(out).toContain('pattern-d');
  });

  it('shows the "Enable"/"Disable" retries case as evidence without a verdict', async () => {
    writeCard('pattern-enable-retries.md', card('Enable retries for payment requests', 'draft'));
    writeCard('pattern-disable-retries.md', card('Disable retries for payment requests', 'verified'));
    const out = await runTriage(tmp, {});
    expect(out).toContain('Compare before deciding');
    expect(out).toContain('verified pattern-disable-retries · title 0.67');
    expect(out.toLowerCase()).not.toContain('deprecate');
  });

  it('prints the report as JSON with --json', async () => {
    writeCard('pattern-d.md', card('Alone draft', 'draft'));
    const parsed = JSON.parse(await runTriage(tmp, { json: true })) as TriageReport;
    expect(parsed.checked).toBe(1);
    expect(parsed.withoutRelated[0]!.id).toBe('pattern-d');
  });

  it('leaves the store untouched (read-only)', async () => {
    writeCard('pattern-d.md', card('Alone draft', 'draft'));
    const before = fs.readdirSync(tmp).sort();
    await runTriage(tmp, {});
    expect(fs.readdirSync(tmp).sort()).toEqual(before);
  });
});
