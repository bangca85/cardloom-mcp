import { SECRET_PATTERNS } from '../config/secrets-patterns.js';
import { SecretDetectedError } from '../types/errors.js';

export function scanForSecrets(content: string): void {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.regex.test(content)) {
      throw new SecretDetectedError(`${pattern.name} pattern found`);
    }
  }
}
