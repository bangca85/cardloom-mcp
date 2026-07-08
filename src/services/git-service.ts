import { simpleGit, type SimpleGit } from 'simple-git';
import fs from 'node:fs';

let git: SimpleGit | null = null;
let gitPath: string | null = null;

export function getGit(knowledgeStorePath: string): SimpleGit {
  if (git && gitPath === knowledgeStorePath) return git;
  git = simpleGit(knowledgeStorePath);
  gitPath = knowledgeStorePath;
  return git;
}

export function resetGit(): void {
  git = null;
  gitPath = null;
}

export async function initGitRepo(knowledgeStorePath: string): Promise<void> {
  const gitDir = `${knowledgeStorePath}/.git`;
  if (fs.existsSync(gitDir)) return;

  const g = simpleGit(knowledgeStorePath);
  await g.init();
  await g.addConfig('user.email', 'cardloom-mcp@local');
  await g.addConfig('user.name', 'cardloom-mcp');
  await g.raw(['commit', '--allow-empty', '-m', 'knowledge: init knowledge store']);
  console.error('Git repo initialized in knowledge store');
}

export async function gitCommit(knowledgeStorePath: string, files: string | string[], message: string): Promise<void> {
  const g = getGit(knowledgeStorePath);
  const fileArray = Array.isArray(files) ? files : [files];
  await g.add(fileArray);
  await g.commit(message);
}

export async function gitCommitAll(knowledgeStorePath: string, message: string): Promise<void> {
  const g = getGit(knowledgeStorePath);
  await g.add('.');
  await g.commit(message);
}

export async function getFileHistory(
  knowledgeStorePath: string,
  filePath: string,
  limit: number = 10,
): Promise<Array<{ hash: string; date: string; message: string }>> {
  const g = getGit(knowledgeStorePath);
  const log = await g.log({ file: filePath, maxCount: limit });
  return log.all.map(entry => ({
    hash: entry.hash,
    date: entry.date,
    message: entry.message,
  }));
}

export async function getFileDiffSummary(
  knowledgeStorePath: string,
  hash: string,
  filePath: string,
): Promise<string> {
  const g = getGit(knowledgeStorePath);
  try {
    const diff = await g.diff([`${hash}~1`, hash, '--stat', '--', filePath]);
    const match = diff.match(/(\d+) insertion.+?(\d+) deletion/);
    if (match) return `+${match[1]} lines, -${match[2]} lines`;
    return diff.trim() || 'initial commit';
  } catch {
    return 'initial commit';
  }
}
