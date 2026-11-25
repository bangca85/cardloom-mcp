import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * sha256 hex of a card file's bytes. Lives in `utils/` (not the reconfirm service) so `card-service` can check
 * it under the lock without importing a service that imports `card-service`.
 */
export function cardFileHash(storePath: string, id: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(path.resolve(storePath, 'cards', `${id}.md`))).digest('hex');
}
