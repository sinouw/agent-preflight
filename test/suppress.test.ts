import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isIgnored, parseIgnoreFile, scan } from '../src/engine.js';
import { runScan } from '../src/index.js';
import { resolveTarget } from '../src/inputs/index.js';
import { memFile, RULES, scanFiles } from './helpers.js';

const evalLine = 'eval(input); // preflight-ignore PF-SRC-004: sandboxed REPL\n';

describe('inline suppressions', () => {
  it('are honoured for trusted content', () => {
    expect(scanFiles([memFile('a.js', evalLine)], true)).toEqual([]);
  });
  it('apply to the next line when placed on their own line', () => {
    expect(
      scanFiles([memFile('a.js', '// preflight-ignore PF-SRC-004\neval(x);\n')], true),
    ).toEqual([]);
  });
  it('only silence the named rule', () => {
    const f = scanFiles([memFile('a.js', 'eval(x); // preflight-ignore PF-SRC-005\n')], true);
    expect(f.map((x) => x.ruleId)).toContain('PF-SRC-004');
  });
  it('are ignored for untrusted content', () => {
    const f = scanFiles([memFile('a.js', evalLine)], false);
    expect(f.map((x) => x.ruleId)).toContain('PF-SRC-004');
  });
  it('count as suppressed in stats', () => {
    const r = scan({
      files: [memFile('a.js', evalLine)],
      rules: RULES,
      target: 'm',
      options: { ignore: [], inlineSuppressions: true },
    });
    expect(r.stats.suppressed).toBeGreaterThan(0);
  });
});

describe('.preflightignore', () => {
  const entries = parseIgnoreFile(`# comment
fixtures/**
PF-URL-001
PF-SRC-004 tools/*.js  # trailing comment
`);
  it('parses globs, rule ids and rule+glob pairs', () => {
    expect(entries).toEqual([
      { glob: 'fixtures/**' },
      { rule: 'PF-URL-001', glob: undefined },
      { rule: 'PF-SRC-004', glob: 'tools/*.js' },
    ]);
  });
  it('matches the right findings', () => {
    expect(isIgnored(entries, 'PF-SRC-001', 'fixtures/a/b.ts')).toBe(true);
    expect(isIgnored(entries, 'PF-URL-001', 'src/x.ts')).toBe(true);
    expect(isIgnored(entries, 'PF-SRC-004', 'tools/x.js')).toBe(true);
    expect(isIgnored(entries, 'PF-SRC-004', 'src/x.js')).toBe(false);
  });

  const dir = mkdtempSync(path.join(os.tmpdir(), 'preflight-ign-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'a.js'), 'eval(x);\n');
  writeFileSync(path.join(dir, '.preflightignore'), 'PF-SRC-004\n');

  it("a local target's own ignore file applies", async () => {
    const { result } = await runScan({ cwd: os.tmpdir() }, await resolveTarget(dir));
    expect(result.findings.map((f) => f.ruleId)).not.toContain('PF-SRC-004');
  });
  it("an untrusted target's ignore file does not", async () => {
    const t = { ...(await resolveTarget(dir)), trusted: false };
    const { result } = await runScan({ cwd: os.tmpdir() }, t);
    expect(result.findings.map((f) => f.ruleId)).toContain('PF-SRC-004');
  });
});
