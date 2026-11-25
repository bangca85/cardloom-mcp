import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { MutationPipeline } from './mutation-pipeline.js';
import { checkConflict } from './conflict-engine.js';
import { computeTrust } from './trust-service.js';
import { validateCardStrict, type Card } from '../types/card-schema.js';
import { normalizeProjectKey } from '../utils/facets-intersect.js';
import { generateSlug } from '../utils/slug-generator.js';
import { daysSince } from '../utils/date.js';
import { resolveSupersededBy } from '../utils/supersede-trace.js';
import { cardSource, type CardSource } from '../utils/card-source.js';
import { config } from '../config/env.js';
import { ConflictError, NotFoundError, ValidationError, InvalidTransitionError } from '../types/errors.js';
import { insertCardRelationsAndStacks } from '../db/schema.js';
import { cardFileHash } from '../utils/card-file-hash.js';

/** Shared shape-builder for card frontmatter — used by every write path so no two places drift. */
function cardToFrontmatter(card: Card): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    type: card.type,
    scope: card.scope,
    applies_to: card.applies_to,
    stack: card.stack,
    version_range: card.version_range,
    status: card.status,
    supersedes: card.supersedes,
    conflicts_with: card.conflicts_with,
    sensitivity: card.sensitivity,
    source_commit: card.source_commit,
    // Listed here or lost: this builder is a whitelist, and a field missing from it is dropped on
    // every save AND every status change, so the card a merge promotion reads no longer names its repo.
    source_repo: card.source_repo,
    // Same whitelist rule as source_repo: omit it and verify/deprecate silently strip the project key.
    project: card.project,
    provenance: card.provenance,
    title: card.title,
    domain: card.domain,
    task_type: card.task_type,
    error_signature: card.error_signature,
    verified_by: card.verified_by,
    verification_method: card.verification_method,
    last_verified: card.last_verified,
    ...(card.status === 'deprecated' && {
      deprecation_reason: card.deprecation_reason,
      deprecated_at: card.deprecated_at,
      deprecated_by: card.deprecated_by,
    }),
  };
  // js-yaml can't dump `undefined` — drop absent optional facets instead of writing them as null.
  return Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined));
}

export interface SaveLearningDraftInput {
  title: string;
  type: Card['type'];
  scope: Card['scope'];
  applies_to: string[];
  stack: string[];
  version_range: string;
  body: string;
  domain?: Card['domain'];
  task_type?: string;
  error_signature?: string;
  supersedes?: string;
  conflicts_with?: string[];
  sensitivity?: Card['sensitivity'];
  source_commit: string;
  source_repo?: string;
  project?: string;
  provenance: string;
}

export interface SaveLearningDraftResult {
  id: string;
  status: 'draft';
  git_committed: boolean;
  git_error?: string;
}

export async function saveLearningDraft(
  db: Database.Database,
  storePath: string,
  input: SaveLearningDraftInput,
): Promise<SaveLearningDraftResult> {
  const id = `${input.type}-${generateSlug(input.title)}`;
  const cardsDir = path.join(storePath, 'cards');
  const cardPath = path.resolve(cardsDir, `${id}.md`);

  const relative = path.relative(cardsDir, cardPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ValidationError([{ field: 'title', message: 'Invalid card title or ID leading to path traversal.' }]);
  }

  // status is always forced to 'draft' — the server never trusts agent input for this (FR2).
  const cardData = {
    type: input.type,
    scope: input.scope,
    applies_to: input.applies_to,
    stack: input.stack,
    version_range: input.version_range,
    sensitivity: input.sensitivity ?? 'normal',
    source_commit: input.source_commit,
    source_repo: input.source_repo,
    // Normalised before validation; the strict schema checks the value as stored.
    project: input.project === undefined ? undefined : normalizeProjectKey(input.project),
    provenance: input.provenance,
    title: input.title,
    domain: input.domain,
    task_type: input.task_type,
    error_signature: input.error_signature,
    supersedes: input.supersedes ?? null,
    conflicts_with: input.conflicts_with ?? [],
    status: 'draft' as const,
    verified_by: null,
    verification_method: null,
    last_verified: null,
  };

  let validatedCard!: Card;

  const pipeline = new MutationPipeline(db, storePath);

  const outcome = await pipeline.execute<{ id: string }>({
    scanContent: input.body,
    validate: () => {
      validatedCard = validateCardStrict(cardData);

      // supersedes is a pending marker only (AD-13) — the old card must exist, but is never touched here.
      if (validatedCard.supersedes) {
        const existing = db.prepare('SELECT id FROM cards WHERE id = ?').get(validatedCard.supersedes);
        if (!existing) {
          throw new NotFoundError(validatedCard.supersedes);
        }
      }
    },
    conflictCheck: () => {
      // Card ids are permanent (AD-8) — an existing id/file always wins, regardless of its status.
      const existingRow = db.prepare('SELECT id FROM cards WHERE id = ?').get(id);
      if (existingRow || fs.existsSync(cardPath)) {
        throw new ConflictError({
          conflicting_card_id: id,
          diff_summary: 'id collision — đổi title/slug',
          options: ['supersede', 'scope-split'],
        });
      }

      checkConflict(db, validatedCard, id);
    },
    writeFiles: () => {
      fs.mkdirSync(path.dirname(cardPath), { recursive: true });

      const fileContent = matter.stringify(input.body, cardToFrontmatter(validatedCard));
      const tempPath = `${cardPath}.tmp`;
      try {
        fs.writeFileSync(tempPath, fileContent);
        fs.renameSync(tempPath, cardPath);
      } catch (err) {
        try {
          if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        } catch {}
        throw err;
      }

      return { result: { id }, tempFiles: [tempPath] };
    },
    filesToCommit: [`cards/${id}.md`],
    commitMessage: `knowledge: add ${id}`,
    updateIndex: (idxDb) => {
      const stat = fs.statSync(cardPath);

      idxDb.prepare(`
        INSERT INTO cards (
          id, type, status, title, domain, stack, applies_to, task_type, error_signature,
          scope, project, version_range, sensitivity, supersedes, conflicts_with, source_commit, source_repo, provenance,
          verified_by, verification_method, last_verified, deprecation_reason, deprecated_at, deprecated_by,
          body, created_at, updated_at, file_mtime
        ) VALUES (
          @id, @type, @status, @title, @domain, @stack, @applies_to, @task_type, @error_signature,
          @scope, @project, @version_range, @sensitivity, @supersedes, @conflicts_with, @source_commit, @source_repo, @provenance,
          @verified_by, @verification_method, @last_verified, NULL, NULL, NULL,
          @body, @created_at, @updated_at, @file_mtime
        )
      `).run({
        id,
        type: validatedCard.type,
        status: validatedCard.status,
        title: validatedCard.title,
        domain: validatedCard.domain ?? null,
        stack: JSON.stringify(validatedCard.stack),
        applies_to: JSON.stringify(validatedCard.applies_to),
        task_type: validatedCard.task_type ?? null,
        error_signature: validatedCard.error_signature ?? null,
        scope: validatedCard.scope,
        project: validatedCard.project ?? null,
        version_range: validatedCard.version_range,
        sensitivity: validatedCard.sensitivity,
        supersedes: validatedCard.supersedes,
        conflicts_with: JSON.stringify(validatedCard.conflicts_with),
        source_commit: validatedCard.source_commit,
        source_repo: validatedCard.source_repo ?? null,
        provenance: validatedCard.provenance,
        verified_by: validatedCard.verified_by,
        verification_method: validatedCard.verification_method,
        last_verified: validatedCard.last_verified,
        body: input.body,
        created_at: stat.mtime.toISOString(),
        updated_at: stat.mtime.toISOString(),
        file_mtime: stat.mtime.toISOString(),
      });

      insertCardRelationsAndStacks(idxDb, id, validatedCard);
    },
  });

  return {
    id: outcome.result.id,
    status: 'draft',
    git_committed: outcome.gitCommitted,
    git_error: outcome.gitError,
  };
}

export interface CardLabels {
  untrusted?: true;
  deprecated?: true;
  deprecation_reason?: string;
  restricted?: true;
}

/**
 * Single source of the status/sensitivity labels stamped onto every card-reading path
 * (search results, get_card, Resource) — AD-15. Never re-derive these inline elsewhere.
 */
export function computeCardLabels(input: {
  status: Card['status'];
  sensitivity: 'normal' | 'restricted';
  deprecationReason?: string | null;
}): CardLabels {
  const labels: CardLabels = {};

  if (input.status === 'draft') {
    labels.untrusted = true;
  }
  if (input.status === 'deprecated') {
    labels.deprecated = true;
    if (input.deprecationReason) {
      labels.deprecation_reason = input.deprecationReason;
    }
  }
  if (input.sensitivity === 'restricted') {
    labels.restricted = true;
  }

  return labels;
}

interface CardRow {
  id: string;
  type: string;
  status: Card['status'];
  title: string;
  domain: string | null;
  stack: string;
  applies_to: string;
  task_type: string | null;
  error_signature: string | null;
  scope: string;
  version_range: string;
  sensitivity: 'normal' | 'restricted';
  supersedes: string | null;
  conflicts_with: string;
  source_commit: string;
  source_repo: string | null;
  provenance: string;
  verified_by: string | null;
  verification_method: string | null;
  last_verified: string | null;
  deprecation_reason: string | null;
  deprecated_at: string | null;
  deprecated_by: string | null;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface RenderedCardFlags {
  stale?: boolean;
  needs_review?: boolean;
}

export interface CardReplacement {
  superseded_by?: string;
  pending: string[];
}

export interface RenderedCard extends CardLabels {
  id: string;
  type: string;
  status: Card['status'];
  title: string;
  domain: string | null;
  stack: string[];
  applies_to: string[];
  task_type: string | null;
  error_signature: string | null;
  scope: string;
  version_range: string;
  sensitivity: 'normal' | 'restricted';
  supersedes: string | null;
  conflicts_with: string[];
  source_commit: string;
  /** Where the card came from: repo, 7-character commit, approval date (each null when unknown). */
  source: CardSource;
  provenance: string;
  verified_by: string | null;
  verification_method: string | null;
  last_verified: string | null;
  deprecated_at: string | null;
  deprecated_by: string | null;
  body: string;
  created_at: string;
  updated_at: string;
  trust: number;
  flags: RenderedCardFlags;
  replacement?: CardReplacement;
  /** Present (true) only when a compact render cut the body; absent for a full or short body. */
  truncated?: true;
}

/** `resolveSupersededBy` over the index: the one rule shared by `get_card`, triage and the D6 refusal. */
function supersededByInIndex(db: Database.Database, cardId: string, reason: string | null | undefined): string | null {
  const stmt = db.prepare('SELECT supersedes FROM cards WHERE id = ?');
  return resolveSupersededBy(cardId, reason, (id) => (stmt.get(id) as { supersedes: string | null } | undefined)?.supersedes);
}

/**
 * Pending and completed replacement for one card (AD-13 trace). `superseded_by` is the id parsed from the
 * exact `superseded by <id>` deprecation reason, kept only if that card exists and declares `supersedes` = this
 * id. `pending` lists normal-sensitivity drafts that declare `supersedes` = this id; a deprecated card has none.
 * Returns undefined when there is nothing to report.
 */
function computeReplacement(db: Database.Database, row: CardRow): CardReplacement | undefined {
  const replacement: CardReplacement = { pending: [] };

  const successorId = supersededByInIndex(db, row.id, row.deprecation_reason);
  if (successorId !== null) replacement.superseded_by = successorId;

  if (row.status !== 'deprecated') {
    const drafts = db
      .prepare(
        "SELECT id FROM cards WHERE supersedes = ? AND status = 'draft' AND sensitivity = 'normal' ORDER BY id",
      )
      .all(row.id) as Array<{ id: string }>;
    replacement.pending = drafts.map((d) => d.id);
  }

  return replacement.superseded_by !== undefined || replacement.pending.length > 0 ? replacement : undefined;
}

export function computeCardFlags(
  input: { last_verified: string | null; failure: number },
  now: Date,
): RenderedCardFlags {
  const flags: RenderedCardFlags = {};
  if (input.last_verified !== null) {
    const days = daysSince(input.last_verified, now);
    if (!isNaN(days) && days > config.staleThresholdDays) {
      flags.stale = true;
    }
  }
  if (input.failure >= config.reviewFailureThreshold) {
    flags.needs_review = true;
  }
  return flags;
}

/** Longest body (in characters, i.e. code points) a compact render keeps before the ellipsis. */
const COMPACT_BODY_LIMIT = 600;

/**
 * First `COMPACT_BODY_LIMIT` characters of `body` plus `…`, cut on a code point boundary so a surrogate pair is never
 * split. A body of that many characters or fewer is returned as is (`cut: false`).
 */
function compactBody(body: string): { body: string; cut: boolean } {
  // A string with at most LIMIT UTF-16 units has at most LIMIT code points: skip the scan.
  if (body.length <= COMPACT_BODY_LIMIT) return { body, cut: false };
  let end = 0;
  let kept = 0;
  while (kept < COMPACT_BODY_LIMIT && end < body.length) {
    end += body.codePointAt(end)! > 0xffff ? 2 : 1;
    kept += 1;
  }
  if (end >= body.length) return { body, cut: false };
  return { body: `${body.slice(0, end)}…`, cut: true };
}

/**
 * The ONE function that renders a full card (metadata + body + trust + flags + labels).
 * get_card and the knowledge://card/{id} Resource both call this — neither serializes a
 * raw card row directly (AD-15, NFR3: no unlabeled draft/deprecated content ever reaches context).
 */
export function renderCard(
  db: Database.Database,
  id: string,
  now: Date = new Date(),
  opts: { compact?: boolean } = {},
): RenderedCard {
  const row = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow | undefined;
  if (!row) {
    throw new NotFoundError(id);
  }

  const counters = db.prepare('SELECT success, failure FROM counters WHERE card_id = ?').get(id) as
    | { success: number; failure: number }
    | undefined;
  const success = counters?.success ?? 0;
  const failure = counters?.failure ?? 0;

  const trust = computeTrust({ status: row.status, lastVerified: row.last_verified, success, failure }, now);

  const flags = computeCardFlags({ last_verified: row.last_verified, failure }, now);

  const labels = computeCardLabels({
    status: row.status,
    sensitivity: row.sensitivity,
    deprecationReason: row.deprecation_reason,
  });

  let stack: string[] = [];
  let appliesTo: string[] = [];
  let conflictsWith: string[] = [];
  try {
    const parsed = JSON.parse(row.stack);
    stack = Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn(`[card-service] Failed to parse stack for card ${row.id}:`, err);
  }
  try {
    const parsed = JSON.parse(row.applies_to);
    appliesTo = Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn(`[card-service] Failed to parse applies_to for card ${row.id}:`, err);
  }
  try {
    const parsed = JSON.parse(row.conflicts_with);
    conflictsWith = Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn(`[card-service] Failed to parse conflicts_with for card ${row.id}:`, err);
  }

  const replacement = computeReplacement(db, row);
  const body = opts.compact === true ? compactBody(row.body) : { body: row.body, cut: false };

  return {
    id: row.id,
    type: row.type,
    status: row.status,
    title: row.title,
    domain: row.domain,
    stack,
    applies_to: appliesTo,
    task_type: row.task_type,
    error_signature: row.error_signature,
    scope: row.scope,
    version_range: row.version_range,
    sensitivity: row.sensitivity,
    supersedes: row.supersedes,
    conflicts_with: conflictsWith,
    source_commit: row.source_commit,
    source: cardSource({
      source_repo: row.source_repo,
      applies_to: appliesTo,
      source_commit: row.source_commit,
      last_verified: row.last_verified,
    }),
    provenance: row.provenance,
    verified_by: row.verified_by,
    verification_method: row.verification_method,
    last_verified: row.last_verified,
    deprecated_at: row.deprecated_at,
    deprecated_by: row.deprecated_by,
    body: body.body,
    created_at: row.created_at,
    updated_at: row.updated_at,
    trust,
    flags,
    ...(replacement ? { replacement } : {}),
    ...(body.cut ? { truncated: true as const } : {}),
    ...labels,
  };
}

/** Actor for a commit subject: whitespace collapsed, control characters stripped, at most 80 characters, `unknown` if nothing is left. */
export function sanitizeActor(actor: string): string {
  // eslint-disable-next-line no-control-regex
  // Drop the non-whitespace control characters first, so collapsing whitespace afterwards leaves single spaces.
  const clean = actor.replace(/[\x00-\x08\x0e-\x1f\x7f-\x9f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80).trimEnd();
  return clean === '' ? 'unknown' : clean;
}

export type UpdateCardStatusAction = 'verify' | 'deprecate' | 'reconfirm';

// Closed transition table (AD-9): keyed by current status, values are the target statuses
// reachable from it. `deprecated` is terminal — no un-deprecate, ever.
const VALID_TRANSITIONS: Record<Card['status'], Card['status'][]> = {
  draft: ['verified', 'deprecated'],
  verified: ['deprecated'],
  deprecated: [],
};

const ACTION_TARGET_STATUS: Record<string, Card['status']> = {
  verify: 'verified',
  deprecate: 'deprecated',
};

export interface UpdateCardStatusInput {
  id: string;
  action: string;
  reason?: string;
  by?: string;
  method?: string;
  /** reconfirm only: sha256 of the card file as it was listed; checked under the lock, a mismatch refuses. */
  expected_hash?: string;
}

export interface UpdateCardStatusResult {
  id: string;
  status: Card['status'];
  git_committed: boolean;
  git_error?: string;
  index_updated: boolean;
  index_error?: string;
}

/**
 * D6 (AD-13 amendment): verifying a draft whose `supersedes` target is already deprecated with the reason
 * `superseded by <other-id>` (another card than the one being verified) is refused, where "already replaced"
 * is the same rule `get_card` uses: <other-id> exists and declares `supersedes` = the target. A target
 * deprecated for any other reason (or naming a successor that does not exist), or one that does not exist,
 * is not this function's business.
 */
function assertNotAlreadySuperseded(
  db: Database.Database,
  targetId: string,
  newId: string,
  fromStatus: Card['status'],
): void {
  const target = db.prepare('SELECT status, deprecation_reason FROM cards WHERE id = ?').get(targetId) as
    | { status: Card['status']; deprecation_reason: string | null }
    | undefined;
  if (target?.status !== 'deprecated') return;
  const other = supersededByInIndex(db, targetId, target.deprecation_reason);
  if (other === null || other === newId) return;
  throw new InvalidTransitionError(
    fromStatus,
    'verify',
    VALID_TRANSITIONS[fromStatus].filter((s) => s !== 'verified'),
    `${targetId} is already superseded by ${other}`,
    { supersedes: targetId, superseded_by: other },
  );
}

/**
 * The only place a card's status ever changes (AD-9). `verify` and `deprecate` are the sole
 * actions that change it; deprecate is invalidate-and-preserve (FR3) — the file is rewritten, never deleted.
 * `reconfirm` (AD-9 amendment 2026-11-25) keeps a verified card verified and only refreshes `last_verified`;
 * who did it goes in the commit message (`(by <actor>)`), never in the card file.
 */
export async function updateCardStatus(
  db: Database.Database,
  storePath: string,
  input: UpdateCardStatusInput,
): Promise<UpdateCardStatusResult> {
  const cardPath = path.resolve(storePath, 'cards', `${input.id}.md`);
  const cardsDir = path.resolve(storePath, 'cards');
  const relative = path.relative(cardsDir, cardPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ValidationError([{ field: 'id', message: 'Invalid card ID leading to path traversal.' }]);
  }

  let currentRaw: string;
  try {
    currentRaw = fs.readFileSync(cardPath, 'utf-8');
  } catch (err) {
    throw new NotFoundError(input.id);
  }

  const row = db.prepare('SELECT status FROM cards WHERE id = ?').get(input.id) as { status: Card['status'] } | undefined;
  if (!row) {
    throw new NotFoundError(input.id);
  }

  const validTargets = VALID_TRANSITIONS[row.status];
  const isReconfirm = input.action === 'reconfirm';
  if (isReconfirm) {
    // AD-9 amendment 2026-11-25: not a transition (status stays `verified`), so it is not in VALID_TRANSITIONS.
    if (row.status !== 'verified') throw new InvalidTransitionError(row.status, input.action, validTargets);
  } else {
    const targetStatus = ACTION_TARGET_STATUS[input.action];
    if (!targetStatus || !validTargets.includes(targetStatus)) {
      throw new InvalidTransitionError(row.status, input.action, validTargets);
    }
  }

  if (input.action === 'deprecate' && !input.reason) {
    throw new ValidationError([{ field: 'reason', message: 'deprecation_reason is required when deprecating a card' }]);
  }

  const parsedNew = matter(currentRaw);

  // Supersede two-phase, part 2 (AD-13): save_learning_draft (1.6) only ever recorded `supersedes`
  // as a pending marker on the NEW card. The old card is deprecated here and ONLY here, in the
  // SAME pipeline execute as the verify — one lock, one txn, one commit. Sized up front (before
  // the lock) because filesToCommit/updateIndex below must know the shape; re-checked fresh inside
  // `validate()` under the lock, so a race just means this outer guess is (harmlessly) ignored.
  let supersedeTargetId: string | undefined;
  let oldCardPath: string | undefined;
  if (input.action === 'verify') {
    const supersedes = parsedNew.data['supersedes'];
    if (typeof supersedes === 'string' && supersedes.length > 0) {
      if (supersedes === input.id) {
        throw new ValidationError([{ field: 'supersedes', message: 'A card cannot supersede itself.' }]);
      }
      const potentialOldCardPath = path.resolve(storePath, 'cards', `${supersedes}.md`);
      const relativeOld = path.relative(cardsDir, potentialOldCardPath);
      if (relativeOld.startsWith('..') || path.isAbsolute(relativeOld)) {
        throw new ValidationError([{ field: 'supersedes', message: 'Invalid supersede target ID leading to path traversal.' }]);
      }

      const oldRow = db.prepare('SELECT status FROM cards WHERE id = ?').get(supersedes) as
        | { status: Card['status'] }
        | undefined;
      const oldExistsOnDisk = fs.existsSync(potentialOldCardPath);

      if (!oldRow || !oldExistsOnDisk) {
        console.error(`[card-service] supersedes target ${supersedes} not found`);
      } else if (oldRow.status !== 'deprecated') {
        supersedeTargetId = supersedes;
        oldCardPath = potentialOldCardPath;
      } else {
        // D6 (AD-13 amendment): the target is already replaced by another card — refuse before any write.
        assertNotAlreadySuperseded(db, supersedes, input.id, row.status);
      }
    }
  }

  let validatedCard!: Card;
  let body = '';
  let validatedOldCard: Card | undefined;
  let oldBody = '';
  let supersedeApplies = false;

  const filesToCommit = [`cards/${input.id}.md`];
  if (oldCardPath && supersedeTargetId) {
    filesToCommit.push(`cards/${supersedeTargetId}.md`);
  }

  const pipeline = new MutationPipeline(db, storePath);

  const outcome = await pipeline.execute<{ id: string; status: Card['status'] }>({
    validate: () => {
      // Re-read under lock to avoid TOCTOU race
      const raw = fs.readFileSync(cardPath, 'utf-8');
      const parsed = matter(raw);
      body = parsed.content;

      const now = new Date().toISOString();
      const nextFrontmatter: Record<string, unknown> = { ...parsed.data };

      if (isReconfirm) {
        // Under the lock: the file may have changed since it was listed, been deprecated, or collected refutations.
        if (input.expected_hash !== undefined && cardFileHash(storePath, input.id) !== input.expected_hash) {
          throw new InvalidTransitionError(row.status, input.action, validTargets, `${input.id} changed since it was listed; list it again`);
        }
        const currentStatus = String(parsed.data['status']);
        if (currentStatus !== 'verified') {
          throw new InvalidTransitionError(currentStatus, input.action, VALID_TRANSITIONS[currentStatus as Card['status']] ?? []);
        }
        const counters = db.prepare('SELECT failure FROM counters WHERE card_id = ?').get(input.id) as { failure: number } | undefined;
        const failure = counters?.failure ?? 0;
        if (computeCardFlags({ last_verified: null, failure }, new Date()).needs_review) {
          throw new InvalidTransitionError(
            row.status,
            input.action,
            validTargets,
            `${input.id} needs review (${failure} refutations): supersede it with a corrected card instead`,
          );
        }
        // One `reconfirmed:` prefix, however many times it is reconfirmed. status and verified_by stay as they are.
        const previous = String(parsed.data['verification_method'] ?? '').replace(/^(reconfirmed:)+/, '');
        nextFrontmatter['verification_method'] = `reconfirmed:${previous === '' ? 'unknown' : previous}`;
        nextFrontmatter['last_verified'] = now;
      } else if (input.action === 'verify') {
        nextFrontmatter['status'] = 'verified';
        nextFrontmatter['verified_by'] = input.by ?? 'bradley';
        nextFrontmatter['verification_method'] = input.method ?? 'chat-approval';
        nextFrontmatter['last_verified'] = now;
      } else {
        nextFrontmatter['status'] = 'deprecated';
        nextFrontmatter['deprecation_reason'] = input.reason;
        nextFrontmatter['deprecated_at'] = now;
        nextFrontmatter['deprecated_by'] = input.by ?? 'bradley';
      }

      validatedCard = validateCardStrict(nextFrontmatter);

      if (oldCardPath && supersedeTargetId) {
        // Under the lock: another verify may have replaced the target since the pre-check above (D6).
        assertNotAlreadySuperseded(db, supersedeTargetId, input.id, row.status);
        const freshOldRow = db.prepare('SELECT status FROM cards WHERE id = ?').get(supersedeTargetId) as
          | { status: Card['status'] }
          | undefined;
        if (freshOldRow && freshOldRow.status !== 'deprecated' && fs.existsSync(oldCardPath)) {
          const parsedOld = matter(fs.readFileSync(oldCardPath, 'utf-8'));
          oldBody = parsedOld.content;
          validatedOldCard = validateCardStrict({
            ...parsedOld.data,
            status: 'deprecated',
            deprecation_reason: `superseded by ${input.id}`,
            deprecated_at: now,
            deprecated_by: input.by ?? 'bradley',
          });
          supersedeApplies = true;
        }
      }
    },
    writeFiles: () => {
      const tempFiles: string[] = [];

      try {
        const fileContent = matter.stringify(body, cardToFrontmatter(validatedCard));
        const tempPath = `${cardPath}.tmp`;
        tempFiles.push(tempPath);
        fs.writeFileSync(tempPath, fileContent);
        fs.renameSync(tempPath, cardPath);

        if (supersedeApplies && validatedOldCard && oldCardPath) {
          const oldFileContent = matter.stringify(oldBody, cardToFrontmatter(validatedOldCard));
          const oldTempPath = `${oldCardPath}.tmp`;
          tempFiles.push(oldTempPath);
          fs.writeFileSync(oldTempPath, oldFileContent);
          fs.renameSync(oldTempPath, oldCardPath);
        }
      } catch (err) {
        for (const tempFile of tempFiles) {
          try {
            if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
          } catch {}
        }
        throw err;
      }

      return { result: { id: input.id, status: validatedCard.status }, tempFiles };
    },
    filesToCommit,
    commitMessage: () =>
      isReconfirm
        ? `knowledge: reconfirm ${input.id} (by ${sanitizeActor(input.by ?? config.reviewerName)})`
        : supersedeApplies && supersedeTargetId
        ? `knowledge: verify ${input.id} (supersedes ${supersedeTargetId})`
        : `knowledge: ${input.action} ${input.id}${input.reason ? ` (${input.reason})` : ''}`,
    updateIndex: (idxDb) => {
      const stat = fs.statSync(cardPath);

      idxDb
        .prepare(
          `
          UPDATE cards SET
            status = @status, verified_by = @verified_by, verification_method = @verification_method,
            last_verified = @last_verified, deprecation_reason = @deprecation_reason,
            deprecated_at = @deprecated_at, deprecated_by = @deprecated_by,
            updated_at = @updated_at, file_mtime = @file_mtime
          WHERE id = @id
          `,
        )
        .run({
          id: input.id,
          status: validatedCard.status,
          verified_by: validatedCard.verified_by,
          verification_method: validatedCard.verification_method,
          last_verified: validatedCard.last_verified,
          deprecation_reason: validatedCard.status === 'deprecated' ? validatedCard.deprecation_reason : null,
          deprecated_at: validatedCard.status === 'deprecated' ? validatedCard.deprecated_at : null,
          deprecated_by: validatedCard.status === 'deprecated' ? validatedCard.deprecated_by : null,
          updated_at: stat.mtime.toISOString(),
          file_mtime: stat.mtime.toISOString(),
        });

      if (supersedeApplies && validatedOldCard && oldCardPath && supersedeTargetId) {
        const oldStat = fs.statSync(oldCardPath);
        idxDb
          .prepare(
            `
            UPDATE cards SET
              status = @status, deprecation_reason = @deprecation_reason,
              deprecated_at = @deprecated_at, deprecated_by = @deprecated_by,
              updated_at = @updated_at, file_mtime = @file_mtime
            WHERE id = @id
            `,
          )
          .run({
            id: supersedeTargetId,
            status: validatedOldCard.status,
            deprecation_reason: validatedOldCard.status === 'deprecated' ? validatedOldCard.deprecation_reason : null,
            deprecated_at: validatedOldCard.status === 'deprecated' ? validatedOldCard.deprecated_at : null,
            deprecated_by: validatedOldCard.status === 'deprecated' ? validatedOldCard.deprecated_by : null,
            updated_at: oldStat.mtime.toISOString(),
            file_mtime: oldStat.mtime.toISOString(),
          });
      }
    },
  });

  return {
    id: outcome.result.id,
    status: outcome.result.status,
    git_committed: outcome.gitCommitted,
    git_error: outcome.gitError,
    index_updated: outcome.indexUpdated,
    index_error: outcome.indexError,
  };
}
