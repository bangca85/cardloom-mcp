export type ErrorCode = 'not_found' | 'validation_error' | 'secret_detected' | 'invalid_transition' | 'conflict';

export abstract class KnowledgeError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export interface ValidationIssue {
  field: string;
  message: string;
}

export class NotFoundError extends KnowledgeError {
  constructor(id: string) {
    super(`Not found: ${id}`, 'not_found');
  }
}

export class ValidationError extends KnowledgeError {
  constructor(issues: ValidationIssue[]) {
    super(`Card validation failed: ${issues.map((i) => `${i.field}: ${i.message}`).join('; ')}`, 'validation_error', issues);
  }
}

export class SecretDetectedError extends KnowledgeError {
  constructor(pattern: string) {
    super(`Potential secret detected: ${pattern}. Please sanitize content and retry.`, 'secret_detected');
  }
}

export class InvalidTransitionError extends KnowledgeError {
  /**
   * `message` and `extraDetails` let a specific refusal (e.g. verifying a draft whose supersede target was
   * already replaced) say why, while keeping the standard `{from, action, validTransitions}` details.
   */
  constructor(
    from: string,
    action: string,
    validTransitions: string[],
    message?: string,
    extraDetails?: Record<string, unknown>,
  ) {
    super(
      message ?? `Cannot apply action "${action}" from status "${from}". Valid transitions: ${validTransitions.join(', ')}`,
      'invalid_transition',
      { from, action, validTransitions, ...extraDetails },
    );
  }
}

export interface ConflictPayload {
  conflicting_card_id: string;
  diff_summary: string;
  options: Array<'supersede' | 'scope-split'>;
}

export class ConflictError extends KnowledgeError {
  constructor(payload: ConflictPayload) {
    super(`Conflict with card ${payload.conflicting_card_id}: ${payload.diff_summary}`, 'conflict', payload);
  }
}
