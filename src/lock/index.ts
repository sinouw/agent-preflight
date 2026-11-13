import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { makeFinding } from '../engine.js';
import type { RuleDef } from '../rules/schema.js';
import type { Definition, Finding } from '../types.js';
import { VERSION } from '../version.js';

export const LOCK_FILE = 'preflight-lock.json';
export const LOCK_VERSION = 1;

export interface LockEntry {
  kind: Definition['kind'];
  name: string;
  file: string;
  sha256: string;
  /** Normalized definition, kept so `verify` can show what changed. */
  content: Record<string, unknown>;
}

export interface LockFile {
  lockfileVersion: number;
  generator: string;
  definitions: Record<string, LockEntry>;
}

/** Normalizes text so formatting noise does not count as drift; invisible characters do. */
function normalizeString(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
}

export function normalize(value: unknown): unknown {
  if (typeof value === 'string') return normalizeString(value);
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort())
      out[k] = normalize((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}

export function hashDefinition(content: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify(normalize(content)))
    .digest('hex');
}

/** Stable key per definition. Duplicate names get the file appended to stay unique. */
export function definitionKeys(defs: Definition[]): Map<string, Definition> {
  const counts = new Map<string, number>();
  for (const d of defs)
    counts.set(`${d.kind}:${d.name}`, (counts.get(`${d.kind}:${d.name}`) ?? 0) + 1);
  const out = new Map<string, Definition>();
  for (const d of defs) {
    const base = `${d.kind}:${d.name}`;
    let key = (counts.get(base) ?? 0) > 1 ? `${base}@${d.file}` : base;
    let n = 2;
    while (out.has(key)) key = `${base}@${d.file}#${n++}`;
    out.set(key, d);
  }
  return out;
}

export function buildLock(defs: Definition[]): LockFile {
  const definitions: Record<string, LockEntry> = {};
  const keyed = [...definitionKeys(defs)].sort(([a], [b]) => a.localeCompare(b));
  for (const [key, d] of keyed) {
    definitions[key] = {
      kind: d.kind,
      name: d.name,
      file: d.file,
      sha256: hashDefinition(d.content),
      content: normalize(d.content) as Record<string, unknown>,
    };
  }
  return { lockfileVersion: LOCK_VERSION, generator: `agent-preflight@${VERSION}`, definitions };
}

export function writeLock(file: string, lock: LockFile): void {
  writeFileSync(file, JSON.stringify(lock, null, 2) + '\n');
}

export function readLock(file: string): LockFile {
  const lock = JSON.parse(readFileSync(file, 'utf8')) as LockFile;
  if (lock.lockfileVersion !== LOCK_VERSION || typeof lock.definitions !== 'object')
    throw new Error(`${file}: unsupported lockfile version ${String(lock.lockfileVersion)}`);
  return lock;
}

export interface Drift {
  key: string;
  change: 'added' | 'removed' | 'changed';
  kind: Definition['kind'];
  name: string;
  file: string;
  line: number;
  diff: string[];
}

function asLines(content: Record<string, unknown> | undefined): string[] {
  if (!content) return [];
  const lines: string[] = [];
  for (const [k, v] of Object.entries(content)) {
    if (typeof v === 'string') {
      const parts = v.split('\n');
      if (parts.length === 1) lines.push(`${k}: ${parts[0]}`);
      else lines.push(`${k}:`, ...parts.map((p) => `  ${p}`));
    } else lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  return lines;
}

/** Minimal LCS line diff, returning lines prefixed with ' ', '-' or '+'. */
export function lineDiff(a: string[], b: string[]): string[] {
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) return [...a.map((l) => `- ${l}`), ...b.map((l) => `+ ${l}`)];
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      (dp[i] as number[])[j] =
        a[i] === b[j]
          ? ((dp[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((dp[i + 1] as number[])[j] as number, (dp[i] as number[])[j + 1] as number);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (
      j < m &&
      (i >= n || ((dp[i] as number[])[j + 1] as number) >= ((dp[i + 1] as number[])[j] as number))
    ) {
      out.push(`+ ${b[j]}`);
      j++;
    } else {
      out.push(`- ${a[i]}`);
      i++;
    }
  }
  return out;
}

export function compareLock(lock: LockFile, defs: Definition[]): Drift[] {
  const current = buildLock(defs);
  const keyed = definitionKeys(defs);
  const drifts: Drift[] = [];
  for (const [key, entry] of Object.entries(current.definitions)) {
    const old = lock.definitions[key];
    const def = keyed.get(key);
    if (!old) {
      drifts.push({
        key,
        change: 'added',
        kind: entry.kind,
        name: entry.name,
        file: entry.file,
        line: def?.line ?? 1,
        diff: asLines(entry.content).map((l) => `+ ${l}`),
      });
    } else if (old.sha256 !== entry.sha256) {
      drifts.push({
        key,
        change: 'changed',
        kind: entry.kind,
        name: entry.name,
        file: entry.file,
        line: def?.line ?? 1,
        diff: lineDiff(asLines(old.content), asLines(entry.content)),
      });
    }
  }
  for (const [key, old] of Object.entries(lock.definitions)) {
    if (!current.definitions[key])
      drifts.push({
        key,
        change: 'removed',
        kind: old.kind,
        name: old.name,
        file: old.file,
        line: 1,
        diff: asLines(old.content).map((l) => `- ${l}`),
      });
  }
  return drifts.sort((a, b) => a.key.localeCompare(b.key));
}

/** Converts drift into findings using the `drift` rules from the loaded rule set. */
export function driftFindings(drifts: Drift[], rules: RuleDef[]): Finding[] {
  const out: Finding[] = [];
  for (const d of drifts) {
    const rule = rules.find((r) => r.match.type === 'drift' && r.match.change === d.change);
    if (!rule) continue;
    const changed = d.diff.filter((l) => l.startsWith('+ ') || l.startsWith('- ')).slice(0, 6);
    out.push(
      makeFinding(rule, {
        message: `${rule.title}: ${d.kind} "${d.name}" was ${d.change} since the lockfile was written`,
        file: d.file,
        line: d.line,
        column: 1,
        snippet: changed.join(' | ').slice(0, 200),
        subjectKind: 'drift',
        subjectName: d.key,
      }),
    );
  }
  return out;
}
