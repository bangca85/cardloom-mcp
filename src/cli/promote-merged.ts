import { config, type PromotionMode } from '../config/env.js';
import { getDatabase, closeDatabase } from '../db/database.js';
import { initKnowledgeStore } from '../services/knowledge-store.js';
import { reconcileIndex } from '../services/index-reconciler.js';
import { runPromotion, type PromotionEntry, type PromotionReport } from '../services/promotion-service.js';

/**
 * Host-side, never inside the container: it reads other repos and calls `gh`, and the container
 * holds no credentials by design (AD-11). Usage:
 *
 *   npm run promote-merged                 # mode from PROMOTION_MODE (default review)
 *   npm run promote-merged -- --dry-run    # auto mode reports would_verify, writes nothing
 *   npm run promote-merged -- --mode=review --json
 *
 * Output goes to stdout: this is a CLI, not the MCP server, so stdout is free here.
 */

interface CliArgs {
  dryRun: boolean;
  json: boolean;
  mode?: PromotionMode;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false, json: false };
  for (const a of argv) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--json') args.json = true;
    else if (a.startsWith('--mode=')) {
      const m = a.slice('--mode='.length);
      if (m !== 'off' && m !== 'review' && m !== 'auto') throw new Error(`--mode must be off, review or auto, not "${m}"`);
      args.mode = m;
    } else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

function line(e: PromotionEntry): string {
  return `  ${e.id}\n      ${e.evidence ?? ''}${e.decision === 'candidate' ? `  [not auto: ${e.reason}]` : ''}`;
}

export function formatReport(r: PromotionReport): string {
  const by = (d: PromotionEntry['decision']) => r.entries.filter((e) => e.decision === d);
  const out = [`promote-merged: mode=${r.mode}${r.dryRun ? ' (dry run)' : ''}, ${r.checked} draft(s) checked`];
  if (r.mode === 'off') {
    out.push('PROMOTION_MODE=off: nothing looked at.');
    return out.join('\n');
  }
  const sections: Array<[PromotionEntry['decision'], string]> = [
    ['verified', 'VERIFIED automatically'],
    ['would_verify', 'WOULD VERIFY (dry run)'],
    ['candidate', 'CANDIDATES — approve in chat: update_card_status(id, "verify", verification_method="<evidence>+chat-approval")'],
    ['error', 'ERRORS'],
  ];
  for (const [d, title] of sections) {
    const list = by(d);
    if (list.length === 0) continue;
    out.push('', `${title} (${list.length}):`);
    for (const e of list) out.push(d === 'error' ? `  ${e.id}: ${e.reason}` : line(e));
  }
  const skipped = by('skipped');
  if (skipped.length > 0) {
    const counts = new Map<string, number>();
    for (const e of skipped) counts.set(e.reason, (counts.get(e.reason) ?? 0) + 1);
    out.push('', `SKIPPED (${skipped.length}):`);
    for (const [reason, n] of [...counts].sort((a, b) => b[1] - a[1])) out.push(`  ${n} × ${reason}`);
  }
  return out.join('\n');
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const mode = args.mode ?? config.promotionMode;
  const storePath = config.knowledgeStorePath;
  await initKnowledgeStore(storePath);
  const db = getDatabase(config.indexDbPath);
  try {
    // The server may not be running; make sure the index sees the same drafts the files hold.
    await reconcileIndex(db, storePath);
    const report = await runPromotion(db, storePath, {
      mode,
      autoTypes: config.promotionAutoTypes,
      repoRoots: config.promotionRepoRoots,
      fetch: config.promotionFetch,
      botName: config.promotionBotName,
      dryRun: args.dryRun,
    });
    process.stdout.write((args.json ? JSON.stringify(report, null, 2) : formatReport(report)) + '\n');
    return report.entries.some((e) => e.decision === 'error') ? 1 : 0;
  } finally {
    closeDatabase();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`[promote-merged] ${(err as Error).message}`);
    process.exit(2);
  },
);
