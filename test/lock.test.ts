import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractAll } from '../src/extract/index.js';
import { runScan } from '../src/index.js';
import { resolveTarget } from '../src/inputs/index.js';
import { walk } from '../src/inputs/walk.js';
import { buildLock, compareLock, hashDefinition, readLock, writeLock } from '../src/lock/index.js';
import { FIXTURES } from './helpers.js';

const defsOf = (dir: string) => extractAll(walk(dir)).definitions;
const tmp: string[] = [];
afterEach(() => tmp.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('lockfile and drift', () => {
  it('hashes are stable under key order, CRLF and trailing whitespace', () => {
    expect(hashDefinition({ a: 'x  \r\ny', b: 1 })).toBe(hashDefinition({ b: 1, a: 'x\ny' }));
    expect(hashDefinition({ a: 'x' })).not.toBe(hashDefinition({ a: 'x​' }));
  });

  it('reports no drift against itself', () => {
    const defs = defsOf(path.join(FIXTURES, 'rugpull/before'));
    expect(compareLock(buildLock(defs), defs)).toEqual([]);
  });

  it('detects the rug pull with a readable diff', () => {
    const lock = buildLock(defsOf(path.join(FIXTURES, 'rugpull/before')));
    const drifts = compareLock(lock, defsOf(path.join(FIXTURES, 'rugpull/after')));
    expect(drifts).toHaveLength(1);
    const d = drifts[0]!;
    expect(d).toMatchObject({ change: 'changed', kind: 'tool', name: 'get_weather' });
    expect(d.diff.some((l) => l.startsWith('+') && l.includes('<IMPORTANT>'))).toBe(true);
    expect(d.diff.some((l) => l.startsWith('-') && l.includes('Returns the current weather'))).toBe(
      true,
    );
  });

  it('reports added and removed definitions', () => {
    const lock = buildLock(defsOf(path.join(FIXTURES, 'clean/text-tools-py')));
    const drifts = compareLock(lock, defsOf(path.join(FIXTURES, 'clean/calculator-mcp-ts')));
    expect(
      drifts
        .filter((d) => d.change === 'added')
        .map((d) => d.name)
        .sort(),
    ).toEqual(['add_numbers', 'convert_units']);
    expect(
      drifts
        .filter((d) => d.change === 'removed')
        .map((d) => d.name)
        .sort(),
    ).toEqual(['reverse_text', 'word_count']);
  });

  it('round-trips through disk and feeds drift findings into scans', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'preflight-lock-'));
    tmp.push(dir);
    cpSync(path.join(FIXTURES, 'rugpull/before'), dir, { recursive: true });
    const lockPath = path.join(dir, 'preflight-lock.json');
    writeLock(lockPath, buildLock(defsOf(dir)));
    expect(readLock(lockPath).definitions).toEqual(buildLock(defsOf(dir)).definitions);
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).lockfileVersion).toBe(1);

    cpSync(path.join(FIXTURES, 'rugpull/after/server.ts'), path.join(dir, 'server.ts'));
    const target = await resolveTarget(dir);
    const { result } = await runScan({ lockFile: lockPath, cwd: dir }, target);
    expect(result.findings.map((f) => f.ruleId)).toContain('PF-DRIFT-001');
  });

  it('rejects files that are not lockfiles', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'preflight-lock-'));
    tmp.push(dir);
    const p = path.join(dir, 'x.json');
    writeLock(p, { lockfileVersion: 99 } as never);
    expect(() => readLock(p)).toThrow();
  });
});
