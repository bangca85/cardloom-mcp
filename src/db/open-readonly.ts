import fs from 'node:fs';
import BetterSqlite3 from 'better-sqlite3';
import type Database from 'better-sqlite3';

// An index above this is not worth copying into memory for a session-start hook (RAM budget, NFR1).
const MAX_COPY_BYTES = 200 * 1024 * 1024;

/**
 * Opens an EXISTING index for reading and guarantees it creates and writes nothing next to it: no -wal/-shm
 * files, no schema work. Returns `null` when the file is missing or cannot be read as a database.
 *
 * A plain read-only open of a WAL-mode index (what the server leaves behind) creates empty `-wal`/`-shm` files.
 * So a WAL index is opened in place only when both files already exist (a server holds it open, and the
 * committed rows in the WAL are then visible); otherwise the database file, which a clean shutdown has fully
 * checkpointed, is read into memory with its header switched to rollback-journal mode.
 */
export function openIndexReadOnly(file: string): Database.Database | null {
  try {
    if (file.trim() === '' || !fs.statSync(file).isFile()) return null;
    const header = Buffer.alloc(20);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, header, 0, 20, 0);
    } finally {
      fs.closeSync(fd);
    }
    const walMode = header[18] === 2 || header[19] === 2;
    if (!walMode || (fs.existsSync(`${file}-wal`) && fs.existsSync(`${file}-shm`))) {
      return new BetterSqlite3(file, { readonly: true, fileMustExist: true });
    }
    if (fs.statSync(file).size > MAX_COPY_BYTES) return null;
    const bytes = fs.readFileSync(file);
    bytes[18] = 1;
    bytes[19] = 1;
    return new BetterSqlite3(bytes, { readonly: true });
  } catch {
    return null;
  }
}
