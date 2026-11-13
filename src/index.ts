import path from 'node:path';
import { loadIgnoreFile, scan, sortFindings, type IgnoreEntry } from './engine.js';
import { extractAll } from './extract/index.js';
import {
  resolveInstalled,
  resolveTarget,
  type ResolvedTarget,
  type TargetType,
} from './inputs/index.js';
import { compareLock, driftFindings, readLock, type Drift } from './lock/index.js';
import { loadRules } from './rules/loader.js';
import type { RuleDef } from './rules/schema.js';
import type { ScanResult, Severity } from './types.js';

export * from './types.js';
export { scan, parseIgnoreFile, meetsThreshold } from './engine.js';
export { extractAll, extractFile } from './extract/index.js';
export { loadRules, parseRuleFile, builtinRulesDir } from './rules/loader.js';
export type { RuleDef, MatchSpec } from './rules/schema.js';
export {
  buildLock,
  compareLock,
  readLock,
  writeLock,
  hashDefinition,
  LOCK_FILE,
} from './lock/index.js';
export { formatPretty, formatJson, formatSarif, formatDrift } from './report/index.js';
export { resolveTarget, resolveInstalled } from './inputs/index.js';
export { walk } from './inputs/walk.js';

export interface RunScanOptions {
  target?: string;
  installed?: boolean;
  type?: TargetType;
  rulesDirs?: string[];
  builtinRules?: boolean;
  ignoreFile?: string;
  inlineSuppressions?: boolean;
  minSeverity?: Severity;
  /** Path to a lockfile; when set, drift is reported as findings. */
  lockFile?: string;
  cwd?: string;
}

export interface RunScanResult {
  result: ScanResult;
  rules: RuleDef[];
  target: ResolvedTarget;
  drifts?: Drift[];
}

export async function loadTarget(opts: RunScanOptions): Promise<ResolvedTarget> {
  return opts.installed
    ? resolveInstalled()
    : resolveTarget(opts.target ?? '.', opts.type ?? 'auto');
}

/** Resolves a target, runs all rules and (optionally) lockfile verification. */
export async function runScan(
  opts: RunScanOptions,
  target?: ResolvedTarget,
): Promise<RunScanResult> {
  const cwd = opts.cwd ?? process.cwd();
  const rules = loadRules({ builtin: opts.builtinRules, extraDirs: opts.rulesDirs });
  const resolved = target ?? (await loadTarget(opts));
  const ignore: IgnoreEntry[] = [...loadIgnoreFile(path.join(cwd, '.preflightignore'))];
  // A target's own .preflightignore only counts when the target is trusted local content.
  if (resolved.trusted && resolved.root && path.resolve(resolved.root) !== path.resolve(cwd))
    ignore.push(...loadIgnoreFile(path.join(resolved.root, '.preflightignore')));
  if (opts.ignoreFile) ignore.push(...loadIgnoreFile(opts.ignoreFile));

  const extraction = extractAll(resolved.files);
  const result = scan({
    files: resolved.files,
    rules,
    target: resolved.label,
    extraction,
    options: {
      ignore,
      inlineSuppressions: resolved.trusted && opts.inlineSuppressions !== false,
      minSeverity: opts.minSeverity,
    },
  });
  let drifts: Drift[] | undefined;
  if (opts.lockFile) {
    drifts = compareLock(readLock(opts.lockFile), extraction.definitions);
    result.findings = sortFindings([...result.findings, ...driftFindings(drifts, rules)]);
  }
  return { result, rules, target: resolved, drifts };
}
