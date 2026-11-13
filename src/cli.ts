#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { Command, Option } from 'commander';
import pc from 'picocolors';
import { meetsThreshold } from './engine.js';
import { extractAll } from './extract/index.js';
import { loadTarget, runScan, type RunScanOptions } from './index.js';
import { buildLock, compareLock, LOCK_FILE, readLock, writeLock } from './lock/index.js';
import { formatDrift, formatJson, formatPretty, formatSarif } from './report/index.js';
import { loadRules } from './rules/loader.js';
import { SEVERITIES, type Severity } from './types.js';
import { VERSION } from './version.js';

const collect = (value: string, prev: string[] = []) => [...prev, value];

function emit(text: string, output?: string): void {
  if (output) writeFileSync(output, text);
  else process.stdout.write(text);
}

function fail(err: unknown): never {
  process.stderr.write(`${pc.red('error:')} ${(err as Error).message ?? String(err)}\n`);
  process.exit(2);
}

const program = new Command();
program
  .name('preflight')
  .description(
    'Static security scanner for MCP servers and Claude Code plugins, skills and hooks.\n' +
      'Scanning is purely static: scanned code is never executed or installed.',
  )
  .version(VERSION);

interface ScanCliOptions {
  installed?: boolean;
  format: 'pretty' | 'json' | 'sarif';
  output?: string;
  failOn: Severity | 'none';
  minSeverity?: Severity;
  rules?: string[];
  builtinRules: boolean;
  ignoreFile?: string;
  inlineSuppressions: boolean;
  locked?: string | boolean;
  type: RunScanOptions['type'];
}

program
  .command('scan')
  .description(
    'scan a directory, GitHub URL, npm package, or the configs installed on this machine',
  )
  .argument(
    '[target]',
    'local path, GitHub URL (https://github.com/owner/repo[/tree/ref/path]) or npm package[@version]',
  )
  .option(
    '--installed',
    'scan MCP / Claude Code configs, plugins, skills and hooks on this machine (read-only)',
  )
  .addOption(
    new Option('-f, --format <format>', 'output format')
      .choices(['pretty', 'json', 'sarif'])
      .default('pretty'),
  )
  .option('-o, --output <file>', 'write the report to a file instead of stdout')
  .addOption(
    new Option('--fail-on <severity>', 'exit 1 when a finding at or above this severity exists')
      .choices([...SEVERITIES, 'none'])
      .default('high'),
  )
  .addOption(
    new Option(
      '--min-severity <severity>',
      'only report findings at or above this severity',
    ).choices([...SEVERITIES]),
  )
  .option('-r, --rules <dir>', 'load an additional rule pack (repeatable)', collect)
  .option('--no-builtin-rules', 'do not load the built-in rules')
  .option('--ignore-file <file>', 'additional .preflightignore-style file')
  .option('--no-inline-suppressions', 'ignore preflight-ignore comments even in local targets')
  .option(
    '--locked [lockfile]',
    `also verify definitions against a lockfile (default ${LOCK_FILE})`,
  )
  .addOption(
    new Option('--type <type>', 'force the target type')
      .choices(['auto', 'local', 'github', 'npm'])
      .default('auto'),
  )
  .action(async (target: string | undefined, o: ScanCliOptions) => {
    try {
      if (o.installed && target) throw new Error('pass either a target or --installed, not both');
      const resolved = await loadTarget({ target, installed: o.installed, type: o.type });
      try {
        const { result, rules } = await runScan(
          {
            rulesDirs: o.rules,
            builtinRules: o.builtinRules,
            ignoreFile: o.ignoreFile,
            inlineSuppressions: o.inlineSuppressions,
            minSeverity: o.minSeverity,
            lockFile: o.locked ? (typeof o.locked === 'string' ? o.locked : LOCK_FILE) : undefined,
          },
          resolved,
        );
        const text =
          o.format === 'json'
            ? formatJson(result)
            : o.format === 'sarif'
              ? formatSarif(result, rules)
              : formatPretty(result, resolved.notes);
        emit(text, o.output);
        if (o.output && o.format !== 'pretty')
          process.stderr.write(
            `wrote ${o.format} report with ${result.findings.length} finding(s) to ${o.output}\n`,
          );
        process.exitCode = meetsThreshold(result.findings, o.failOn) ? 1 : 0;
      } finally {
        resolved.cleanup();
      }
    } catch (e) {
      fail(e);
    }
  });

program
  .command('lock')
  .description(`pin every tool / skill / hook / server definition into ${LOCK_FILE}`)
  .argument('[target]', 'local path, GitHub URL or npm package', '.')
  .option('--installed', 'lock the configs installed on this machine')
  .option('-o, --output <file>', 'lockfile path', LOCK_FILE)
  .action(async (target: string, o: { installed?: boolean; output: string }) => {
    try {
      const resolved = await loadTarget({ target, installed: o.installed });
      try {
        const lock = buildLock(extractAll(resolved.files).definitions);
        writeLock(o.output, lock);
        const n = Object.keys(lock.definitions).length;
        process.stdout.write(
          `${pc.green('✔')} locked ${n} definition(s) from ${resolved.label} into ${o.output}\n`,
        );
      } finally {
        resolved.cleanup();
      }
    } catch (e) {
      fail(e);
    }
  });

program
  .command('verify')
  .description(
    'fail when a definition changed, was added or removed since the lockfile was written',
  )
  .argument('[target]', 'local path, GitHub URL or npm package', '.')
  .option('--installed', 'verify the configs installed on this machine')
  .option('-l, --lock <file>', 'lockfile path', LOCK_FILE)
  .addOption(
    new Option('-f, --format <format>', 'output format')
      .choices(['pretty', 'json'])
      .default('pretty'),
  )
  .action(async (target: string, o: { installed?: boolean; lock: string; format: string }) => {
    try {
      const lock = readLock(o.lock);
      const resolved = await loadTarget({ target, installed: o.installed });
      try {
        const drifts = compareLock(lock, extractAll(resolved.files).definitions);
        process.stdout.write(
          o.format === 'json'
            ? JSON.stringify({ drift: drifts }, null, 2) + '\n'
            : formatDrift(drifts) + '\n',
        );
        process.exitCode = drifts.length > 0 ? 1 : 0;
      } finally {
        resolved.cleanup();
      }
    } catch (e) {
      fail(e);
    }
  });

program
  .command('rules')
  .description('list the loaded rules')
  .option('-r, --rules <dir>', 'load an additional rule pack (repeatable)', collect)
  .addOption(
    new Option('-f, --format <format>', 'output format')
      .choices(['pretty', 'json'])
      .default('pretty'),
  )
  .action((o: { rules?: string[]; format: string }) => {
    try {
      const rules = loadRules({ extraDirs: o.rules });
      if (o.format === 'json') {
        process.stdout.write(
          JSON.stringify(
            rules.map(({ source: _s, ...r }) => r),
            null,
            2,
          ) + '\n',
        );
        return;
      }
      for (const r of rules)
        process.stdout.write(
          `${pc.bold(r.id.padEnd(12))} ${r.severity.padEnd(9)} ${r.layer.padEnd(9)} ${r.title}\n`,
        );
    } catch (e) {
      fail(e);
    }
  });

program.parseAsync().catch(fail);
