import { z } from 'zod';
import { ValidationError, type ValidationIssue } from './errors.js';
import { PROJECT_KEY_RE, normalizeProjectKey } from '../utils/facets-intersect.js';

export const CARD_TYPES = ['decision', 'pattern', 'snippet', 'gotcha', 'playbook'] as const;
export const CARD_SCOPES = ['project', 'stack', 'global'] as const;
export const CARD_SENSITIVITIES = ['normal', 'restricted'] as const;
export const CARD_DOMAINS = ['frontend', 'backend', 'infra', 'AI', 'product'] as const;
export const CARD_STATUSES = ['draft', 'verified', 'deprecated'] as const;

const COUNTER_FIELD_KEYS = ['usage', 'success', 'failure', 'counters'] as const;

function baseFields() {
  return {
    type: z.enum(CARD_TYPES),
    scope: z.enum(CARD_SCOPES),
    applies_to: z.array(z.string()),
    stack: z.array(z.string()),
    version_range: z.string(),
    supersedes: z.string().nullable().default(null),
    conflicts_with: z.array(z.string()).default([]),
    sensitivity: z.enum(CARD_SENSITIVITIES),
    source_commit: z.string(),
    // `owner/name` of the repo `source_commit` lives in. Optional because 300+ cards predate it;
    // without it, merge promotion has to guess the repo from `applies_to`, and a bare name like
    // "billing-api" can match two local clones (e.g. under work/ and forks/) — so new cards should set it.
    source_repo: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'source_repo must be "owner/name"')
      .optional(),
    // Stable key of the project a `scope: project` card belongs to (e.g. "acme/billing-api"), as stored:
    // already normalised by save_learning_draft. Optional because older cards predate it; never a path.
    project: z
      .string()
      .regex(PROJECT_KEY_RE, 'project must be a lowercase key like "name" or "owner/name", not a path')
      .optional(),
    provenance: z.string(),
    title: z.string().min(1),
    domain: z.enum(CARD_DOMAINS).optional(),
    task_type: z.string().optional(),
    error_signature: z.string().optional(),
  };
}

function draftFields() {
  return {
    status: z.literal('draft'),
    verified_by: z.string().nullable().default(null),
    verification_method: z.string().nullable().default(null),
    last_verified: z.string().nullable().default(null),
  };
}

function verifiedFields() {
  return {
    status: z.literal('verified'),
    verified_by: z.string().min(1),
    verification_method: z.string().min(1),
    last_verified: z.string().min(1),
  };
}

function deprecatedFields() {
  return {
    status: z.literal('deprecated'),
    verified_by: z.string().nullable().default(null),
    verification_method: z.string().nullable().default(null),
    last_verified: z.string().nullable().default(null),
    deprecation_reason: z.string().min(1),
    deprecated_at: z.string().min(1),
    deprecated_by: z.string().min(1),
  };
}

function gotchaRefine(val: { type: string; error_signature?: string }, ctx: z.RefinementCtx): void {
  if (val.type === 'gotcha' && (!val.error_signature || val.error_signature.trim() === '')) {
    ctx.addIssue({ code: 'custom', message: 'error_signature is required when type is gotcha', path: ['error_signature'] });
  }
}

function projectScopeRefine(val: { scope: string; project?: string }, ctx: z.RefinementCtx): void {
  if (val.project !== undefined && val.scope !== 'project') {
    ctx.addIssue({ code: 'custom', message: 'project is only allowed when scope is "project"', path: ['project'] });
  }
}

const StrictDraftCard = z.strictObject({ ...baseFields(), ...draftFields() });
const StrictVerifiedCard = z.strictObject({ ...baseFields(), ...verifiedFields() });
const StrictDeprecatedCard = z.strictObject({ ...baseFields(), ...deprecatedFields() });

export const CardSchemaStrict = z
  .discriminatedUnion('status', [StrictDraftCard, StrictVerifiedCard, StrictDeprecatedCard])
  .superRefine((val, ctx) => {
    gotchaRefine(val, ctx);
    projectScopeRefine(val, ctx);
  });

const LooseDraftCard = z.looseObject({ ...baseFields(), ...draftFields() });
const LooseVerifiedCard = z.looseObject({ ...baseFields(), ...verifiedFields() });
const LooseDeprecatedCard = z.looseObject({ ...baseFields(), ...deprecatedFields() });

export const CardSchemaLenient = z
  .discriminatedUnion('status', [LooseDraftCard, LooseVerifiedCard, LooseDeprecatedCard])
  .superRefine(gotchaRefine);

export type DraftCard = z.infer<typeof StrictDraftCard>;
export type VerifiedCard = z.infer<typeof StrictVerifiedCard>;
export type DeprecatedCard = z.infer<typeof StrictDeprecatedCard>;
export type Card = z.infer<typeof CardSchemaStrict>;

function issuesFromZodError(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join('.') : '(root)',
    message: issue.message,
  }));
}

export function validateCardStrict(data: unknown): Card {
  const result = CardSchemaStrict.safeParse(data);
  if (!result.success) {
    throw new ValidationError(issuesFromZodError(result.error));
  }
  return result.data;
}

export interface LenientValidationResult {
  card: Card;
  warnings: string[];
  unknownFields: Record<string, unknown>;
}

export function validateCardLenient(data: unknown): LenientValidationResult {
  const warnings: string[] = [];
  const raw = { ...(data as Record<string, unknown>) };

  for (const key of COUNTER_FIELD_KEYS) {
    if (key in raw) {
      delete raw[key];
      const message = `stripped counter field "${key}" from card frontmatter (counters live in events/*.jsonl, not the card)`;
      warnings.push(message);
      console.error(`[card-schema] ${message}`);
    }
  }

  if (raw.status === undefined || raw.status === null) {
    raw.status = 'draft';
    const message = 'missing "status" field — defaulted to "draft"';
    warnings.push(message);
    console.error(`[card-schema] ${message}`);
  }

  for (const key of ['stack', 'applies_to', 'conflicts_with'] as const) {
    if (typeof raw[key] === 'string') {
      raw[key] = [raw[key]];
      const message = `coerced "${key}" from string to single-element array`;
      warnings.push(message);
      console.error(`[card-schema] ${message}`);
    }
  }

  // A bad project must never make reconcile skip a hand-edited card: normalise it (coerce + warn),
  // and only drop it, with a warning, when it is still invalid afterwards.
  if ('project' in raw) {
    if (typeof raw.project === 'string') {
      const normalised = normalizeProjectKey(raw.project);
      if (normalised !== raw.project) {
        const message = `coerced "project" from "${raw.project}" to "${normalised}"`;
        warnings.push(message);
        console.error(`[card-schema] ${message}`);
        raw.project = normalised;
      }
    }
    const problem =
      typeof raw.project !== 'string' || !PROJECT_KEY_RE.test(raw.project)
        ? 'is not a valid project key'
        : raw.scope !== 'project'
          ? 'is only allowed when scope is "project"'
          : undefined;
    if (problem) {
      delete raw.project;
      const message = `dropped "project" from card frontmatter (value ${problem})`;
      warnings.push(message);
      console.error(`[card-schema] ${message}`);
    }
  }

  const result = CardSchemaLenient.safeParse(raw);
  if (!result.success) {
    throw new ValidationError(issuesFromZodError(result.error));
  }

  const knownKeys = new Set(Object.keys({ ...baseFields(), ...draftFields(), ...verifiedFields(), ...deprecatedFields() }));
  const unknownFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result.data as Record<string, unknown>)) {
    if (!knownKeys.has(key)) {
      unknownFields[key] = value;
    }
  }

  return { card: result.data, warnings, unknownFields };
}
