import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type Database from 'better-sqlite3';
import matter from 'gray-matter';
import { updateCardStatus } from './card-service.js';
import type { PromotionMode } from '../config/env.js';

/**
 * Merge promotion: a draft whose source commit reached its repo's default branch AFTER the card
 * was written has been through that repo's own review and merge. In `review` mode that makes it a
 * candidate a human approves in chat; in `auto` mode the eligible ones are verified here, through
 * the ordinary `updateCardStatus` path (AD-3/AD-9) with `verified_by` = the bot name.
 *
 * "Reached the default branch" alone is NOT the test, and the difference is most of the cards:
 * an agent writing about code that is already on main records main's HEAD as source_commit, and
 * that sha is trivially "merged". Promoting it would verify every observation the moment it was
 * saved. The test is that the commit ENTERED the default branch after the card's creation commit.
 *
 * Every sha and repo name here comes out of a card file an agent wrote, so both are checked
 * against a strict pattern and passed to git/gh as argv (execFile, no shell).
 */

export interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  git(cwd: string, args: string[]): Promise<CmdResult>;
  gh(args: string[]): Promise<CmdResult>;
}

export function defaultRunner(timeoutMs = 60_000): CommandRunner {
  const run = (cmd: string, args: string[], cwd?: string) =>
    new Promise<CmdResult>((resolve) => {
      execFile(
        cmd,
        args,
        {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 64 * 1024 * 1024,
          // A fetch that wants a password must fail, not hang a launchd job forever.
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' },
        },
        (err, stdout, stderr) => {
          const raw = err as (Error & { code?: unknown }) | null;
          const code = raw ? (typeof raw.code === 'number' ? raw.code : 1) : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
  return {
    git: (cwd, args) => run('git', args, cwd),
    gh: (args) => run(process.env['GH_BIN'] ?? 'gh', args),
  };
}

const SHA_RE = /\b[0-9a-f]{7,40}\b/g;
const FULL_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const NAME_RE = /^[A-Za-z0-9_.-]+$/;
// "abc1234 working tree 2026-10-16" names the BASE the learning sat on, not a commit holding it:
// the code the card is about was never in that sha, so its merge proves nothing.
const UNCOMMITTED_RE = /working tree|uncommitted|local change|\+\s*local/i;

/**
 * The commit named in `source_commit`: the first 7-40 hex token that has both a digit and a letter.
 * An abbreviation made only of digits is a real sha about 4% of the time (7 characters), but it also
 * looks like a ticket number, so it is used only when no mixed token exists. Resolution still has to
 * find that commit in the repo, so a ticket number ends as "unresolvable", not as a promotion.
 * Tokens made only of letters (words such as "defaced") are never taken.
 */
export function extractSha(sourceCommit: string): string | null {
  let digitsOnly: string | null = null;
  for (const m of sourceCommit.toLowerCase().matchAll(SHA_RE)) {
    const token = m[0];
    const hasLetter = /[a-f]/.test(token);
    const hasDigit = /[0-9]/.test(token);
    if (hasLetter && hasDigit) return token;
    if (hasDigit && digitsOnly === null) digitsOnly = token;
  }
  return digitsOnly;
}

export interface RepoCandidate {
  full?: string;
  name: string;
}

/** `source_repo` is authoritative when present; otherwise `applies_to` is a guess list. */
export function repoCandidates(fm: Record<string, unknown>): RepoCandidate[] {
  const out: RepoCandidate[] = [];
  const seen = new Set<string>();
  const add = (c: RepoCandidate) => {
    const key = c.full ?? c.name;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(c);
    }
  };
  const sourceRepo = fm['source_repo'];
  if (typeof sourceRepo === 'string' && FULL_REPO_RE.test(sourceRepo)) {
    add({ full: sourceRepo, name: sourceRepo.split('/')[1]! });
    return out;
  }
  const appliesTo = Array.isArray(fm['applies_to']) ? fm['applies_to'] : [];
  for (const raw of appliesTo) {
    if (typeof raw !== 'string') continue;
    const v = raw.trim();
    if (FULL_REPO_RE.test(v)) add({ full: v, name: v.split('/')[1]! });
    else if (NAME_RE.test(v)) add({ name: v });
  }
  return out;
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'vendor', 'Pods', 'DerivedData']);

/** basename -> clone paths, for every git work tree within `maxDepth` levels of each root. */
export function findLocalClones(roots: string[], maxDepth = 3): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === '.git')) {
      const name = path.basename(dir);
      found.set(name, [...(found.get(name) ?? []), dir]);
    }
    if (depth >= maxDepth) return;
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  for (const root of roots) walk(root, 0);
  return found;
}

export function parseGithubRemote(url: string): string | null {
  const m = url.trim().match(/github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

export type ResolutionVia = 'first-parent' | 'merge-commit' | 'pull-request' | 'github-ancestor';

export interface Resolution {
  status: 'merged' | 'not_merged' | 'unresolvable';
  repo?: string;
  sha?: string;
  enteredAt?: string;
  via?: ResolutionVia;
  reason: string;
}

class Resolver {
  private readonly fetched = new Set<string>();
  private readonly remoteCache = new Map<string, string | null>();

  constructor(
    private readonly runner: CommandRunner,
    private readonly clones: Map<string, string[]>,
    private readonly fetch: boolean,
  ) {}

  async resolve(sha: string, candidates: RepoCandidate[]): Promise<Resolution> {
    if (candidates.length === 0) {
      return { status: 'unresolvable', reason: 'no repo: set source_repo, or applies_to has no repo name' };
    }
    let lastNotMerged: Resolution | undefined;
    for (const cand of candidates) {
      for (const clone of this.clones.get(cand.name) ?? []) {
        const remote = await this.githubRemote(clone);
        // source_repo "a/x" must not be answered by an unrelated clone that happens to be named x.
        if (cand.full && remote && remote.toLowerCase() !== cand.full.toLowerCase()) continue;
        const r = await this.resolveLocal(clone, sha, remote ?? cand.full);
        if (r?.status === 'merged') return r;
        if (r) lastNotMerged = r;
      }
      if (cand.full && !lastNotMerged) {
        const r = await this.resolveGithub(cand.full, sha);
        if (r?.status === 'merged') return r;
        if (r) lastNotMerged = r;
      }
    }
    return lastNotMerged ?? { status: 'unresolvable', reason: 'commit not found in any matching local clone or GitHub repo' };
  }

  private async githubRemote(clone: string): Promise<string | null> {
    if (!this.remoteCache.has(clone)) {
      const r = await this.runner.git(clone, ['remote', 'get-url', 'origin']);
      this.remoteCache.set(clone, r.code === 0 ? parseGithubRemote(r.stdout) : null);
    }
    return this.remoteCache.get(clone) ?? null;
  }

  private async resolveLocal(clone: string, sha: string, github: string | undefined): Promise<Resolution | null> {
    const git = (args: string[]) => this.runner.git(clone, args);
    if (this.fetch && !this.fetched.has(clone)) {
      this.fetched.add(clone);
      const f = await git(['fetch', '--quiet', 'origin']);
      if (f.code !== 0) console.error(`[promotion] fetch failed in ${clone}; checking its existing refs: ${f.stderr.trim().slice(0, 200)}`);
    }
    const full = await git(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
    const repo = github ?? path.basename(clone);
    const ref = await this.defaultRef(clone);

    if (full.code !== 0) {
      // A squash-merged branch commit is often gone from a clone that never fetched the branch;
      // GitHub keeps it on the pull request.
      return github ? this.resolveGithub(github, sha) : null;
    }
    const fullSha = full.stdout.trim();
    if (!ref) return { status: 'unresolvable', repo, sha: fullSha, reason: `no default branch ref in ${clone}` };

    const anc = await git(['merge-base', '--is-ancestor', fullSha, ref.ref]);
    if (anc.code === 0) {
      const entered = await this.enteredLocally(clone, fullSha, ref.ref);
      if (entered) return { status: 'merged', repo, sha: fullSha, ...entered, reason: `on ${ref.ref}` };
      return { status: 'unresolvable', repo, sha: fullSha, reason: `could not date its arrival on ${ref.ref}` };
    }
    if (anc.code !== 1) return { status: 'unresolvable', repo, sha: fullSha, reason: `git merge-base failed in ${clone}` };

    if (github) {
      const pr = await this.mergedPullRequest(github, fullSha, ref.branch);
      if (pr) return { status: 'merged', repo, sha: fullSha, enteredAt: pr, via: 'pull-request', reason: 'merged pull request' };
    }
    return { status: 'not_merged', repo, sha: fullSha, reason: `not on ${ref.ref} yet` };
  }

  private async defaultRef(clone: string): Promise<{ ref: string; branch: string } | null> {
    const head = await this.runner.git(clone, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
    if (head.code === 0) {
      const ref = head.stdout.trim().replace(/^refs\/remotes\//, '');
      return { ref, branch: ref.replace(/^origin\//, '') };
    }
    for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
      const r = await this.runner.git(clone, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
      if (r.code === 0) return { ref, branch: ref.replace(/^origin\//, '') };
    }
    return null;
  }

  /**
   * When `sha` became part of the default branch: its own date if it sits on the first-parent
   * line (committed or fast-forwarded straight onto it), otherwise the date of the first
   * first-parent commit that contains it — the merge that brought it in. Containment is
   * monotonic along the first-parent line, so a binary search over it is exact.
   */
  private async enteredLocally(
    clone: string,
    sha: string,
    ref: string,
  ): Promise<{ enteredAt: string; via: ResolutionVia } | null> {
    const git = (args: string[]) => this.runner.git(clone, args);
    const list = await git(['rev-list', '--first-parent', ref]);
    if (list.code !== 0) return null;
    const line = list.stdout.split('\n').filter(Boolean).reverse(); // oldest first
    if (line.includes(sha)) {
      const d = await this.commitDate(clone, sha);
      return d ? { enteredAt: d, via: 'first-parent' } : null;
    }
    let lo = 0;
    let hi = line.length - 1;
    let first = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = await git(['merge-base', '--is-ancestor', sha, line[mid]!]);
      if (r.code === 0) {
        first = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    if (first < 0) return null;
    const d = await this.commitDate(clone, line[first]!);
    return d ? { enteredAt: d, via: 'merge-commit' } : null;
  }

  private async commitDate(clone: string, rev: string): Promise<string | null> {
    const r = await this.runner.git(clone, ['show', '-s', '--format=%cI', rev]);
    return r.code === 0 && r.stdout.trim() ? new Date(r.stdout.trim()).toISOString() : null;
  }

  private async resolveGithub(repo: string, sha: string): Promise<Resolution | null> {
    const c = await this.runner.gh(['api', `repos/${repo}/commits/${sha}`, '--jq', '[.sha, .commit.committer.date] | @tsv']);
    if (c.code !== 0) return null;
    const [fullSha, committed] = c.stdout.trim().split('\t');
    if (!fullSha) return null;
    const meta = await this.runner.gh(['api', `repos/${repo}`, '--jq', '.default_branch']);
    const branch = meta.code === 0 ? meta.stdout.trim() : '';
    if (!branch) return { status: 'unresolvable', repo, sha: fullSha, reason: 'could not read the default branch from GitHub' };

    const pr = await this.mergedPullRequest(repo, fullSha, branch);
    if (pr) return { status: 'merged', repo, sha: fullSha, enteredAt: pr, via: 'pull-request', reason: 'merged pull request' };

    const cmp = await this.runner.gh(['api', `repos/${repo}/compare/${branch}...${fullSha}`, '--jq', '.status']);
    const status = cmp.stdout.trim();
    if (cmp.code === 0 && (status === 'behind' || status === 'identical') && committed) {
      // Pushed straight to the default branch with no pull request. The commit date is the best
      // date GitHub gives without a clone; it can only make a card look OLDER than its merge,
      // which skips it rather than promoting it wrongly.
      return { status: 'merged', repo, sha: fullSha, enteredAt: new Date(committed).toISOString(), via: 'github-ancestor', reason: `on ${branch}` };
    }
    return { status: 'not_merged', repo, sha: fullSha, reason: `not on ${branch} yet` };
  }

  /** Earliest merge into `branch` of a pull request that contains `sha` (covers squash merges). */
  private async mergedPullRequest(repo: string, sha: string, branch: string): Promise<string | null> {
    const r = await this.runner.gh(['api', `repos/${repo}/commits/${sha}/pulls`]);
    if (r.code !== 0) return null;
    let prs: unknown;
    try {
      prs = JSON.parse(r.stdout);
    } catch {
      return null;
    }
    if (!Array.isArray(prs)) return null;
    const dates = prs
      .filter((p) => p && typeof p.merged_at === 'string' && p.base?.ref === branch)
      .map((p) => new Date(p.merged_at as string).toISOString())
      .sort();
    return dates[0] ?? null;
  }
}

export type PromotionDecision = 'verified' | 'would_verify' | 'candidate' | 'skipped' | 'error';

export interface PromotionEntry {
  id: string;
  type: string;
  title: string;
  decision: PromotionDecision;
  reason: string;
  evidence?: string;
  createdAt?: string;
  resolution?: Resolution;
}

export interface PromotionReport {
  mode: PromotionMode;
  dryRun: boolean;
  checked: number;
  entries: PromotionEntry[];
}

export interface PromotionOptions {
  mode: PromotionMode;
  autoTypes: string[];
  repoRoots: string[];
  fetch: boolean;
  botName: string;
  dryRun: boolean;
  runner?: CommandRunner;
  clones?: Map<string, string[]>;
}

async function cardCreatedAt(runner: CommandRunner, storePath: string, id: string): Promise<string | null> {
  const r = await runner.git(storePath, ['log', '--diff-filter=A', '--format=%cI', '--', `cards/${id}.md`]);
  if (r.code !== 0) return null;
  const lines = r.stdout.split('\n').filter(Boolean);
  const oldest = lines[lines.length - 1];
  return oldest ? new Date(oldest).toISOString() : null;
}

/** Why `auto` leaves an otherwise-merged card for a person, or null when it may verify it. */
function notAutoReason(fm: Record<string, unknown>, opts: PromotionOptions): string | null {
  if (opts.mode !== 'auto') return 'mode is review';
  const type = String(fm['type'] ?? '');
  if (!opts.autoTypes.includes(type)) return `type "${type}" is not in PROMOTION_AUTO_TYPES`;
  if (fm['sensitivity'] !== 'normal') return 'restricted card';
  // Verifying a card with `supersedes` deprecates the old one in the same step (AD-13). AD-13's
  // promise is that an unapproved draft never kills a verified card, so a person makes that call.
  if (typeof fm['supersedes'] === 'string' && fm['supersedes'] !== '') return `supersedes ${String(fm['supersedes'])}`;
  return null;
}

export async function runPromotion(
  db: Database.Database,
  storePath: string,
  opts: PromotionOptions,
): Promise<PromotionReport> {
  const report: PromotionReport = { mode: opts.mode, dryRun: opts.dryRun, checked: 0, entries: [] };
  if (opts.mode === 'off') return report;

  const runner = opts.runner ?? defaultRunner();
  const resolver = new Resolver(runner, opts.clones ?? findLocalClones(opts.repoRoots), opts.fetch);
  const rows = db.prepare("SELECT id FROM cards WHERE status = 'draft' ORDER BY id").all() as { id: string }[];

  for (const { id } of rows) {
    const cardPath = path.join(storePath, 'cards', `${id}.md`);
    let fm: Record<string, unknown>;
    try {
      fm = matter(fs.readFileSync(cardPath, 'utf-8')).data;
    } catch {
      continue;
    }
    // The index can lag the files (AD-2): trust the file's own status.
    if (fm['status'] !== 'draft') continue;
    report.checked++;

    const base = { id, type: String(fm['type'] ?? ''), title: String(fm['title'] ?? '') };
    const skip = (reason: string, extra: Partial<PromotionEntry> = {}) =>
      report.entries.push({ ...base, decision: 'skipped', reason, ...extra });

    const sourceCommit = String(fm['source_commit'] ?? '');
    const sha = extractSha(sourceCommit);
    if (!sha) {
      skip('source_commit has no sha');
      continue;
    }
    if (UNCOMMITTED_RE.test(sourceCommit)) {
      skip('learning came from uncommitted work on top of the sha');
      continue;
    }

    const resolution = await resolver.resolve(sha, repoCandidates(fm));
    if (resolution.status !== 'merged') {
      skip(resolution.status === 'not_merged' ? 'not merged yet' : `unresolvable: ${resolution.reason}`, { resolution });
      continue;
    }

    const createdAt = await cardCreatedAt(runner, storePath, id);
    if (!createdAt) {
      skip('card has no creation commit in the knowledge store', { resolution });
      continue;
    }
    if (resolution.enteredAt! <= createdAt) {
      skip('commit was already on the default branch when the card was written', { resolution, createdAt });
      continue;
    }

    const evidence = `merged:${resolution.repo}@${resolution.sha!.slice(0, 12)} (${resolution.via} ${resolution.enteredAt})`;
    const blocked = notAutoReason(fm, opts);
    if (blocked) {
      report.entries.push({ ...base, decision: 'candidate', reason: blocked, evidence, createdAt, resolution });
      continue;
    }
    if (opts.dryRun) {
      report.entries.push({ ...base, decision: 'would_verify', reason: 'auto', evidence, createdAt, resolution });
      continue;
    }
    try {
      await updateCardStatus(db, storePath, { id, action: 'verify', by: opts.botName, method: evidence });
      report.entries.push({ ...base, decision: 'verified', reason: 'auto', evidence, createdAt, resolution });
    } catch (err) {
      report.entries.push({ ...base, decision: 'error', reason: (err as Error).message, evidence, createdAt, resolution });
    }
  }
  return report;
}
