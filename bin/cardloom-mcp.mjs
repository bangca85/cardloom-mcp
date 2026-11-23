#!/usr/bin/env node
// npx entry point. stdout is the MCP JSON-RPC channel (AD-12): this file never writes to it.
import os from 'node:os';
import { resolveLauncherEnv } from '../dist/cli/launcher-env.js';

const USAGE = [
  'Usage: cardloom-mcp            start the MCP server on stdio',
  '       cardloom-mcp doctor     check the store and index',
].join('\n');

// Unknown arguments must not start the server (or create ~/.cardloom): print usage to stderr only.
const arg = process.argv[2];
if (arg !== undefined && arg !== 'doctor') {
  console.error(USAGE);
  process.exit(arg === '--help' || arg === '-h' ? 0 : 1);
}

const resolved = resolveLauncherEnv(process.env, os.homedir());
for (const [key, value] of Object.entries(resolved)) {
  const current = process.env[key];
  if (current === undefined || current.trim() === '') process.env[key] = value;
}

if (process.argv[2] === 'doctor') {
  // doctor's own isMain guard is false when imported, so run it explicitly (a CLI: stdout is fine).
  try {
    const { runDoctor, formatDoctorReport } = await import('../dist/cli/doctor.js');
    const report = await runDoctor(process.env.KNOWLEDGE_STORE_PATH, process.env.INDEX_DB_PATH);
    console.log(formatDoctorReport(report));
  } catch (err) {
    console.error('[doctor] failed:', err);
    process.exitCode = 1;
  }
} else {
  await import('../dist/index.js');
}
