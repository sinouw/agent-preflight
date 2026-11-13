import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURES, ROOT } from './helpers.js';

const CLI = path.join(ROOT, 'dist/cli.js');
const run = (args: string[]) =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: ROOT });
const tmp = mkdtempSync(path.join(os.tmpdir(), 'preflight-cli-'));

beforeAll(() => {
  if (!existsSync(CLI)) {
    const b = spawnSync('npm', ['run', 'build'], { cwd: ROOT, encoding: 'utf8' });
    if (b.status !== 0) throw new Error(b.stderr);
  }
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('CLI', () => {
  it('exits 1 on malicious fixtures', () => {
    const r = run(['scan', path.join(FIXTURES, 'malicious')]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('CRITICAL');
  });
  it('exits 0 on clean fixtures', () => {
    const r = run(['scan', path.join(FIXTURES, 'clean')]);
    expect(r.stdout).toContain('No findings');
    expect(r.status).toBe(0);
  });
  it('--fail-on none always exits 0', () => {
    expect(run(['scan', path.join(FIXTURES, 'malicious'), '--fail-on', 'none']).status).toBe(0);
  });
  it('--fail-on critical ignores high-only targets', () => {
    expect(
      run(['scan', path.join(FIXTURES, 'malicious/obfuscated-loader'), '--fail-on', 'critical'])
        .status,
    ).toBe(0);
  });
  it('writes SARIF to a file', () => {
    const out = path.join(tmp, 'r.sarif');
    const r = run([
      'scan',
      path.join(FIXTURES, 'malicious'),
      '-f',
      'sarif',
      '-o',
      out,
      '--fail-on',
      'none',
    ]);
    expect(r.status).toBe(0);
    expect(existsSync(out)).toBe(true);
  });
  it('lock + verify detect the rug pull', () => {
    const lock = path.join(tmp, 'lock.json');
    expect(run(['lock', path.join(FIXTURES, 'rugpull/before'), '-o', lock]).status).toBe(0);
    expect(run(['verify', path.join(FIXTURES, 'rugpull/before'), '-l', lock]).status).toBe(0);
    const v = run(['verify', path.join(FIXTURES, 'rugpull/after'), '-l', lock]);
    expect(v.status).toBe(1);
    expect(v.stdout).toContain('get_weather');
  });
  it('exits 2 on errors', () => {
    expect(run(['scan', path.join(tmp, 'does-not-exist'), '--type', 'local']).status).toBe(2);
    expect(run(['scan', '.', '--installed']).status).toBe(2);
  });
  it('lists rules', () => {
    expect(run(['rules']).stdout).toContain('PF-SRC-006');
  });
});
