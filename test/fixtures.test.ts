import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES, ids, RULES, scanDir } from './helpers.js';

const fx = (p: string) => path.join(FIXTURES, p);

/** Every malicious fixture and the rules that must fire on it. */
const EXPECTED: Record<string, string[]> = {
  'malicious/poisoned-mcp-ts': [
    'PF-INJ-001',
    'PF-INJ-002',
    'PF-INJ-003',
    'PF-INJ-004',
    'PF-PRM-001',
    'PF-PRM-002',
    'PF-SRC-001',
    'PF-SRC-002',
    'PF-SRC-003',
    'PF-SRC-005',
    'PF-SRC-006',
    'PF-PKG-001',
  ],
  'malicious/poisoned-mcp-py': [
    'PF-INJ-002',
    'PF-INJ-003',
    'PF-INJ-004',
    'PF-PRM-001',
    'PF-PRM-002',
    'PF-OBF-001',
    'PF-LEN-001',
    'PF-SRC-002',
    'PF-SRC-003',
    'PF-SRC-005',
  ],
  'malicious/exfil-hook': ['PF-HOOK-001', 'PF-HOOK-002', 'PF-SRC-001', 'PF-SRC-007'],
  'malicious/hidden-unicode-skill': ['PF-UNI-001', 'PF-UNI-002', 'PF-UNI-003', 'PF-UNI-004'],
  'malicious/evil-plugin': ['PF-INJ-002', 'PF-INJ-004', 'PF-SRC-006', 'PF-MCP-001', 'PF-MCP-002'],
  'malicious/obfuscated-loader': ['PF-SRC-004', 'PF-SRC-005', 'PF-SRC-007', 'PF-URL-003'],
  'rugpull/after': ['PF-INJ-004', 'PF-PRM-001', 'PF-PRM-002'],
};

describe('malicious fixtures', () => {
  for (const [dir, rules] of Object.entries(EXPECTED)) {
    it(`${dir} triggers ${rules.length} rule(s)`, () => {
      const found = ids(scanDir(fx(dir)));
      for (const r of rules) expect(found, `${r} should fire on ${dir}`).toContain(r);
    });
  }

  it('shadowing fixture is caught when scanned alongside its target tool', () => {
    const found = ids(scanDir(fx('malicious/shadowing-tool')));
    expect(found).toEqual(expect.arrayContaining(['PF-SHD-001', 'PF-SHD-002', 'PF-URL-001']));
  });

  it('every non-drift rule except PF-URL-002 is exercised by a fixture', () => {
    // PF-URL-002 names real services, so it is covered by inline strings in rules.test.ts.
    const fired = new Set(ids(scanDir(FIXTURES)));
    const missing = RULES.filter(
      (r) => r.match.type !== 'drift' && r.id !== 'PF-URL-002' && !fired.has(r.id),
    ).map((r) => r.id);
    expect(missing).toEqual([]);
  });

  it('maps findings inside concatenated and docstring descriptions to the exact line', () => {
    const ts = scanDir(fx('malicious/poisoned-mcp-ts'));
    expect(ts.find((f) => f.ruleId === 'PF-INJ-002')?.line).toBe(15);
    expect(ts.filter((f) => f.ruleId === 'PF-INJ-004').map((f) => f.line)).toEqual([13, 16]);
    const py = scanDir(fx('malicious/poisoned-mcp-py'));
    expect(py.find((f) => f.ruleId === 'PF-INJ-002')?.line).toBe(16);
    expect(py.find((f) => f.ruleId === 'PF-INJ-003')?.line).toBe(15);
  });

  it('decoded tag characters are shown visibly in the snippet', () => {
    const f = scanDir(fx('malicious/hidden-unicode-skill')).find((x) => x.ruleId === 'PF-UNI-003');
    expect(f?.snippet).toContain('<U+E0049>');
    expect(f?.line).toBe(8);
  });
});

describe('clean fixtures', () => {
  for (const dir of [
    'clean/calculator-mcp-ts',
    'clean/text-tools-py',
    'clean/formatter-hook',
    'clean/commit-skill',
    'clean/notes-plugin',
    'rugpull/before',
  ]) {
    it(`${dir} has no findings`, () => {
      expect(scanDir(fx(dir)).map((f) => `${f.ruleId} ${f.file}:${f.line}`)).toEqual([]);
    });
  }

  it('the whole clean/ tree stays quiet even when scanned together', () => {
    expect(scanDir(fx('clean'))).toEqual([]);
  });
});
