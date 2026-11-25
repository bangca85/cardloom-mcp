import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { renderCard } from '../../src/services/card-service.js';
import { handleGetCard } from '../../src/tools/get-card.js';

interface CardFixture {
  id: string;
  body: string;
  status?: 'draft' | 'verified' | 'deprecated';
  sensitivity?: 'normal' | 'restricted';
  deprecation_reason?: string | null;
  supersedes?: string | null;
}

function insertCard(db: Database.Database, f: CardFixture): void {
  db.prepare(
    `INSERT INTO cards (
      id, type, status, title, stack, applies_to, scope, version_range, sensitivity,
      supersedes, conflicts_with, source_commit, provenance, deprecation_reason,
      body, created_at, updated_at, file_mtime
    ) VALUES (
      @id, 'pattern', @status, @title, '["node"]', '["api"]', 'project', '>=1.0.0', @sensitivity,
      @supersedes, '[]', 'abc123', 'agent-observation', @deprecation_reason,
      @body, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
    )`,
  ).run({
    id: f.id,
    status: f.status ?? 'verified',
    title: `Title for ${f.id}`,
    sensitivity: f.sensitivity ?? 'normal',
    supersedes: f.supersedes ?? null,
    deprecation_reason: f.deprecation_reason ?? null,
    body: f.body,
  });
}

const codePoints = (s: string): number => Array.from(s).length;

describe('renderCard compact option', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('cuts a 1000-character body to 600 characters plus an ellipsis and sets truncated: true', () => {
    const body = 'a'.repeat(1000);
    insertCard(db, { id: 'pattern-long', body });

    const card = renderCard(db, 'pattern-long', new Date(), { compact: true });

    expect(card.body).toBe('a'.repeat(600) + '…');
    expect(card.truncated).toBe(true);
  });

  it('returns a 600-character body unchanged with no truncated key', () => {
    const body = 'b'.repeat(600);
    insertCard(db, { id: 'pattern-600', body });

    const card = renderCard(db, 'pattern-600', new Date(), { compact: true });

    expect(card.body).toBe(body);
    expect('truncated' in card).toBe(false);
  });

  it('returns a 599-character body unchanged with no truncated key', () => {
    const body = 'c'.repeat(599);
    insertCard(db, { id: 'pattern-599', body });

    const card = renderCard(db, 'pattern-599', new Date(), { compact: true });

    expect(card.body).toBe(body);
    expect('truncated' in card).toBe(false);
  });

  it('truncates a 601-character body', () => {
    insertCard(db, { id: 'pattern-601', body: 'd'.repeat(601) });

    const card = renderCard(db, 'pattern-601', new Date(), { compact: true });

    expect(card.body).toBe('d'.repeat(600) + '…');
    expect(card.truncated).toBe(true);
  });

  it('does not split a surrogate pair at the boundary (emoji as the 600th character is kept whole)', () => {
    // 599 ASCII characters, then an emoji (2 UTF-16 units, 1 character), then more text.
    const body = 'e'.repeat(599) + '😀' + 'tail'.repeat(50);
    insertCard(db, { id: 'pattern-emoji', body });

    const card = renderCard(db, 'pattern-emoji', new Date(), { compact: true });

    expect(card.body).toBe('e'.repeat(599) + '😀' + '…');
    expect(codePoints(card.body)).toBe(601);
    expect(card.body).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(card.body).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(card.truncated).toBe(true);
  });

  it('counts characters, not UTF-16 units: 600 emoji are returned unchanged', () => {
    const body = '😀'.repeat(600);
    insertCard(db, { id: 'pattern-emoji-600', body });

    const card = renderCard(db, 'pattern-emoji-600', new Date(), { compact: true });

    expect(card.body).toBe(body);
    expect('truncated' in card).toBe(false);
  });

  it('cuts 700 emoji to 600 whole emoji plus an ellipsis (at most 601 code points)', () => {
    insertCard(db, { id: 'pattern-emoji-700', body: '😀'.repeat(700) });

    const card = renderCard(db, 'pattern-emoji-700', new Date(), { compact: true });

    expect(card.body).toBe('😀'.repeat(600) + '…');
    expect(codePoints(card.body)).toBe(601);
  });

  it('keeps the draft label (untrusted) under compact', () => {
    insertCard(db, { id: 'pattern-draft', status: 'draft', body: 'x'.repeat(1000) });

    const card = renderCard(db, 'pattern-draft', new Date(), { compact: true });

    expect(card.untrusted).toBe(true);
    expect(card.truncated).toBe(true);
  });

  it('keeps the deprecated label and reason under compact', () => {
    insertCard(db, {
      id: 'pattern-old',
      status: 'deprecated',
      deprecation_reason: 'no longer true',
      body: 'x'.repeat(1000),
    });

    const card = renderCard(db, 'pattern-old', new Date(), { compact: true });

    expect(card.deprecated).toBe(true);
    expect(card.deprecation_reason).toBe('no longer true');
    expect(card.truncated).toBe(true);
  });

  it('keeps the restricted label under compact', () => {
    insertCard(db, { id: 'pattern-secret', sensitivity: 'restricted', body: 'x'.repeat(1000) });

    const card = renderCard(db, 'pattern-secret', new Date(), { compact: true });

    expect(card.restricted).toBe(true);
    expect(card.truncated).toBe(true);
  });

  it('is identical to the full render except body and truncated (labels, flags, replacement, source, trust)', () => {
    insertCard(db, { id: 'pattern-target', body: 'z'.repeat(1000) });
    insertCard(db, { id: 'pattern-proposal', status: 'draft', supersedes: 'pattern-target', body: 'new' });
    const now = new Date('2026-06-01T00:00:00Z');

    const full = renderCard(db, 'pattern-target', now);
    const compact = renderCard(db, 'pattern-target', now, { compact: true });

    const { body: fullBody, ...fullRest } = full;
    const { body: compactBody, truncated, ...compactRest } = compact;
    expect(compactRest).toEqual(fullRest);
    expect(full.replacement).toEqual({ pending: ['pattern-proposal'] });
    expect(compactBody).toBe(fullBody.slice(0, 600) + '…');
    expect(truncated).toBe(true);
  });

  it('default, compact: undefined and compact: false equal the full render byte for byte', () => {
    insertCard(db, { id: 'pattern-full', body: 'f'.repeat(1000) });
    const now = new Date('2026-06-01T00:00:00Z');

    const full = JSON.stringify(renderCard(db, 'pattern-full', now));

    expect(JSON.stringify(renderCard(db, 'pattern-full', now, {}))).toBe(full);
    expect(JSON.stringify(renderCard(db, 'pattern-full', now, { compact: undefined }))).toBe(full);
    expect(JSON.stringify(renderCard(db, 'pattern-full', now, { compact: false }))).toBe(full);
    expect(renderCard(db, 'pattern-full', now).body).toBe('f'.repeat(1000));
    expect('truncated' in renderCard(db, 'pattern-full', now)).toBe(false);
  });

  it('get_card handler carries truncated in its JSON when compact is true, and omits it otherwise', () => {
    insertCard(db, { id: 'pattern-handler', body: 'h'.repeat(1000) });

    const compact = JSON.parse(handleGetCard(db, { id: 'pattern-handler', compact: true }).content[0]!.text) as {
      card: { body: string; truncated?: boolean };
    };
    const full = JSON.parse(handleGetCard(db, { id: 'pattern-handler' }).content[0]!.text) as {
      card: { body: string; truncated?: boolean };
    };
    const explicitFalse = JSON.parse(
      handleGetCard(db, { id: 'pattern-handler', compact: false }).content[0]!.text,
    ) as { card: { body: string; truncated?: boolean } };

    expect(compact.card.body).toBe('h'.repeat(600) + '…');
    expect(compact.card.truncated).toBe(true);
    expect(full.card.body).toBe('h'.repeat(1000));
    expect('truncated' in full.card).toBe(false);
    expect(explicitFalse.card.body).toBe('h'.repeat(1000));
    expect('truncated' in explicitFalse.card).toBe(false);
  });
});
