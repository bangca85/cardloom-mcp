import { FULL_REPO_RE } from './repo-name.js';
import { shortSha } from './sha.js';

export interface CardSource {
  repo: string | null;
  commit: string | null;
  approved_at: string | null;
}

export interface CardSourceInput {
  source_repo?: string | null;
  applies_to: string[];
  source_commit: string;
  last_verified: string | null;
}

/**
 * Where a card came from, so an agent can tell the user "this is from repo X, commit Y, approved on Z".
 * `repo` is `source_repo`, else the first `applies_to` entry when it looks like an `owner/name` repo (a guess, as
 * in merge promotion; component names such as `api` or `node` are not repos), else null; `commit` is the
 * sha found in `source_commit` shortened to 7 (null when none can be parsed); `approved_at` is the date part
 * (YYYY-MM-DD) of `last_verified`, null for drafts. Always returns an object; its fields may be null.
 */
export function cardSource(input: CardSourceInput): CardSource {
  const first = input.applies_to[0];
  return {
    repo: input.source_repo ?? (first !== undefined && FULL_REPO_RE.test(first) ? first : null),
    commit: shortSha(input.source_commit),
    approved_at: input.last_verified === null ? null : input.last_verified.slice(0, 10),
  };
}
