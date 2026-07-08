import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { Mutex } from 'async-mutex';
import { lock } from 'proper-lockfile';
import { gitCommit, gitCommitAll } from './git-service.js';
import { scanForSecrets } from './secret-scanner.js';

type MaybePromise<T> = T | Promise<T>;

export interface WriteFilesResult<T> {
  result: T;
  tempFiles?: string[];
}

export interface PipelineParams<T> {
  /** Raw content to run through the secret scanner before anything is written. */
  scanContent?: string;
  /** Schema validation (strict mode) — throws on invalid card. */
  validate?: () => void;
  /** Conflict check against active cards — throws ConflictError. Only for card-creating mutations. */
  conflictCheck?: () => void;
  /** Writes the source-of-truth file(s) (temp+rename). Runs OUTSIDE any DB transaction. */
  writeFiles: () => MaybePromise<WriteFilesResult<T>>;
  filesToCommit: string[];
  /** Fixed string, or a function evaluated after writeFiles() resolves (for messages that depend on data only known at write time). */
  commitMessage: string | (() => string);
  commitAll?: boolean;
  /** Updates SQLite index. Best-effort — failure here does not undo the file write. */
  updateIndex: (db: Database.Database) => void;
}

export interface PipelineOutcome<T> {
  result: T;
  gitCommitted: boolean;
  gitError?: string;
  indexUpdated: boolean;
  indexError?: string;
}

// In-process guard, in addition to the cross-process file lock below.
const inProcessMutex = new Mutex();

export class MutationPipeline {
  private readonly lockDir: string;

  constructor(
    private readonly db: Database.Database,
    private readonly knowledgeStorePath: string,
    lockDir?: string,
    private readonly lockOptions: { stale?: number; update?: number } = {},
  ) {
    // Derive from the DB's actual open path, not knowledgeStorePath/.metadata — under AD-16
    // (Docker named volume) INDEX_DB_PATH can point outside the knowledge-store bind mount
    // entirely, and the lockfile must always live next to index.db, wherever that really is.
    this.lockDir = lockDir ?? path.dirname(db.name);
  }

  async execute<T>(params: PipelineParams<T>): Promise<PipelineOutcome<T>> {
    const releaseMutex = await inProcessMutex.acquire();

    fs.mkdirSync(this.lockDir, { recursive: true });
    const lockTarget = path.join(this.lockDir, 'write');
    const lockFilePath = path.join(this.lockDir, 'write.lock');

    let compromised = false;
    const assertNotCompromised = (): void => {
      if (compromised) {
        throw new Error('Mutation aborted: write lock compromised');
      }
    };

    let releaseLock: (() => Promise<void>) | undefined;

    try {
      releaseLock = await lock(lockTarget, {
        realpath: false,
        lockfilePath: lockFilePath,
        stale: this.lockOptions.stale ?? 10000,
        update: this.lockOptions.update,
        retries: { retries: 5, minTimeout: 100, maxTimeout: 2000 },
        onCompromised: (err: Error) => {
          compromised = true;
          console.error(`[pipeline] lock compromised: ${err.message}`);
        },
      });

      assertNotCompromised();

      if (params.scanContent !== undefined) {
        scanForSecrets(params.scanContent);
      }
      params.validate?.();
      params.conflictCheck?.();

      assertNotCompromised();

      // Source of truth: write file(s) FIRST, outside any DB transaction.
      let tempFiles: string[] = [];
      let result: T;
      try {
        const written = await params.writeFiles();
        result = written.result;
        tempFiles = written.tempFiles ?? [];
      } catch (error) {
        for (const tempFile of tempFiles) {
          try {
            if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
          } catch {
            // ignore cleanup errors
          }
        }
        throw error;
      }

      let gitCommitted = false;
      let gitError: string | undefined;
      if (compromised) {
        console.error('[pipeline] skip git commit: lock compromised after file write, reconcile will heal');
      } else {
        try {
          const commitMessage = typeof params.commitMessage === 'function' ? params.commitMessage() : params.commitMessage;
          if (params.commitAll) {
            await gitCommitAll(this.knowledgeStorePath, commitMessage);
          } else {
            await gitCommit(this.knowledgeStorePath, params.filesToCommit, commitMessage);
          }
          gitCommitted = true;
        } catch (error) {
          gitError = error instanceof Error ? error.message : String(error);
          console.error('[pipeline] git commit failed (will reconcile on next startup):', gitError);
        }
      }

      let indexUpdated = false;
      let indexError: string | undefined;
      if (compromised) {
        console.error('[pipeline] skip index update: lock compromised after file write, reconcile will heal');
      } else {
        try {
          const txn = this.db.transaction(() => params.updateIndex(this.db));
          txn();
          indexUpdated = true;
        } catch (error) {
          indexError = error instanceof Error ? error.message : String(error);
          console.error('[pipeline] index update failed, reconcile will heal:', indexError);
        }
      }

      return { result: result!, gitCommitted, gitError, indexUpdated, indexError };
    } finally {
      if (releaseLock) {
        try {
          await releaseLock();
        } catch {
          // lock may already be gone (e.g. compromised/removed externally)
        }
      }
      releaseMutex();
    }
  }
}
