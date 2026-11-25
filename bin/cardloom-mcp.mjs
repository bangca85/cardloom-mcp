#!/usr/bin/env node
// npx entry point. stdout is the MCP JSON-RPC channel (AD-12): this file never writes to it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveLauncherEnv } from '../dist/cli/launcher-env.js';

const USAGE = [
  'Usage: cardloom-mcp            start the MCP server on stdio',
  '       cardloom-mcp doctor     check the store and index',
  '       cardloom-mcp triage     list drafts with the cards to compare them with',
  '       cardloom-mcp install    register the server and instructions with the agent CLIs found (plan; --yes applies)',
].join('\n');

// Unknown arguments must not start the server (or create ~/.cardloom): print usage to stderr only.
const arg = process.argv[2];
if (arg !== undefined && arg !== 'doctor' && arg !== 'triage' && arg !== 'install') {
  console.error(USAGE);
  process.exit(arg === '--help' || arg === '-h' ? 0 : 1);
}

// install talks to the agent CLIs and edits their instruction files, not the store: it runs before the env
// defaults below and never creates ~/.cardloom (a CLI: stdout is fine).
if (arg === 'install') {
  try {
    const { runInstall, parseInstallArgs, createCommandRunner, INSTALL_USAGE } = await import('../dist/cli/install.js');
    const args = parseInstallArgs(process.argv.slice(3));
    if (args === null) {
      console.error(INSTALL_USAGE);
      process.exitCode = 1;
    } else if (args.help) {
      console.log(INSTALL_USAGE);
    } else {
      const env = {
        pathDirs: (process.env.PATH ?? '').split(path.delimiter),
        home: os.homedir(),
        codexHome: process.env.CODEX_HOME?.trim() ? process.env.CODEX_HOME : undefined,
      };
      const { lines, exitCode } = await runInstall(env, args, createCommandRunner(), fs);
      (exitCode === 0 ? console.log : console.error)(lines.join('\n'));
      process.exitCode = exitCode;
    }
  } catch (err) {
    console.error('[install] failed:', err);
    process.exitCode = 1;
  }
} else {
  const resolved = resolveLauncherEnv(process.env, os.homedir());
  for (const [key, value] of Object.entries(resolved)) {
    const current = process.env[key];
    if (current === undefined || current.trim() === '') process.env[key] = value;
  }

  if (arg === 'doctor') {
    // doctor's own isMain guard is false when imported, so run it explicitly (a CLI: stdout is fine).
    try {
      const { runDoctor, formatDoctorReport } = await import('../dist/cli/doctor.js');
      const report = await runDoctor(process.env.KNOWLEDGE_STORE_PATH, process.env.INDEX_DB_PATH);
      console.log(formatDoctorReport(report));
    } catch (err) {
      console.error('[doctor] failed:', err);
      process.exitCode = 1;
    }
  } else if (arg === 'triage') {
    try {
      const { runTriage, parseTriageArgs, TRIAGE_USAGE } = await import('../dist/cli/triage-drafts.js');
      const args = parseTriageArgs(process.argv.slice(3));
      if (args === null) {
        console.error(TRIAGE_USAGE);
        process.exitCode = 1;
      } else if (args.help) {
        console.log(TRIAGE_USAGE);
      } else {
        console.log(await runTriage(process.env.KNOWLEDGE_STORE_PATH, args));
      }
    } catch (err) {
      console.error('[triage] failed:', err);
      process.exitCode = 1;
    }
  } else {
    await import('../dist/index.js');
  }
}
