import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scan } from '../src/engine.js';
import { builtinRulesDir, loadRules, parseRuleFile } from '../src/rules/loader.js';
import { validateRule } from '../src/rules/schema.js';
import { ids, memFile, RULES, scanFiles } from './helpers.js';

const tool = (description: string) =>
  memFile(
    'server.ts',
    `server.tool('t1', ${JSON.stringify(description)}, {}, async () => ({}));\n`,
  );

describe('built-in rules', () => {
  it('load, validate and have unique ids', () => {
    expect(RULES.length).toBeGreaterThanOrEqual(30);
    expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length);
    expect(builtinRulesDir()).toMatch(/[\\/]rules$/);
  });

  it('PF-URL-002 flags known exfiltration services', () => {
    for (const url of [
      'https://webhook.site/abc',
      'https://abcd.ngrok-free.app/x',
      'https://discord.com/api/webhooks/1/2',
      'https://hooks.slack.com/services/T/B/C',
    ]) {
      expect(ids(scanFiles([tool(`Posts results to ${url}`)])), url).toContain('PF-URL-002');
    }
  });

  it('PF-URL-003 ignores private and loopback addresses', () => {
    const src = (u: string) => memFile('a.js', `fetch('${u}');\n`);
    expect(ids(scanFiles([src('http://203.0.113.9/x')]))).toContain('PF-URL-003');
    expect(ids(scanFiles([src('http://192.168.1.2/x')]))).not.toContain('PF-URL-003');
    expect(ids(scanFiles([src('http://127.0.0.1:3000/x')]))).not.toContain('PF-URL-003');
  });

  it('PF-MCP-001 accepts pinned versions and flags unpinned or @latest', () => {
    const cfg = (args: string[]) =>
      memFile(
        '.mcp.json',
        JSON.stringify({ mcpServers: { s: { command: 'npx', args } } }, null, 2),
      );
    expect(ids(scanFiles([cfg(['-y', 'pkg@1.0.0'])]))).not.toContain('PF-MCP-001');
    expect(ids(scanFiles([cfg(['-y', '@scope/pkg@2.1.0'])]))).not.toContain('PF-MCP-001');
    expect(ids(scanFiles([cfg(['-y', 'pkg'])]))).toContain('PF-MCP-001');
    expect(ids(scanFiles([cfg(['-y', '@scope/pkg@latest'])]))).toContain('PF-MCP-001');
  });

  it('PF-UNI-001 tolerates a leading BOM', () => {
    expect(ids(scanFiles([memFile('README.md', '﻿# Hello\n')]))).toEqual([]);
    expect(ids(scanFiles([memFile('README.md', '# Hel​lo\n')]))).toContain('PF-UNI-001');
  });

  it('plain descriptions do not trigger metadata rules', () => {
    expect(scanFiles([tool('Returns the weather forecast for a city.')])).toEqual([]);
  });
});

describe('rule validation', () => {
  const base = {
    id: 'X-TEST-1',
    title: 't',
    severity: 'low',
    layer: 'metadata',
    description: 'd',
    remediation: 'r',
    scope: ['text'],
    match: { type: 'regex', patterns: ['foo'] },
  };
  it('accepts a minimal valid rule', () => {
    expect(validateRule(base, 'x').id).toBe('X-TEST-1');
  });
  it.each([
    [{ id: 'lower-case' }, /invalid rule id/],
    [{ severity: 'severe' }, /severity/],
    [{ scope: ['nope'] }, /unknown scope/],
    [{ scope: [] }, /scope/],
    [{ match: { type: 'regex', patterns: ['('] } }, /invalid regex/],
    [{ match: { type: 'magic' } }, /match.type/],
    [{ match: { type: 'all', groups: [['a']] } }, /at least two groups/],
    [{ match: { type: 'codepoints', ranges: ['XYZ'] } }, /code point range/],
    [{ remediation: '' }, /remediation/],
  ])('rejects %o', (patch, err) => {
    expect(() => validateRule({ ...base, ...patch }, 'x')).toThrow(err);
  });
  it('allows drift rules without a scope', () => {
    const { scope: _s, ...rest } = base;
    expect(
      validateRule({ ...rest, layer: 'drift', match: { type: 'drift', change: 'added' } }, 'x')
        .scope,
    ).toEqual([]);
  });
});

describe('custom rule packs', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'preflight-rules-'));
  mkdirSync(path.join(dir, 'nested'));
  writeFileSync(
    path.join(dir, 'nested', 'acme.yml'),
    `rules:
  - id: ACME-001
    title: Internal hostname
    severity: medium
    layer: source
    description: Mentions an internal host.
    remediation: Remove it.
    scope: [source, text]
    match:
      type: regex
      patterns: ['corp\\.example\\.invalid']
  - id: PF-LEN-001
    title: Long description (disabled)
    severity: low
    layer: metadata
    description: off
    remediation: off
    scope: [tool-description]
    enabled: false
    match: { type: max-length, max: 1 }
`,
  );

  it('adds new rules and overrides built-ins by id', () => {
    const rules = loadRules({ extraDirs: [dir] });
    expect(rules.find((r) => r.id === 'ACME-001')).toBeDefined();
    expect(rules.find((r) => r.id === 'PF-LEN-001')).toBeUndefined();
    const findings = scan({
      files: [memFile('a.js', "const h = 'corp.example.invalid';\n")],
      rules,
      target: 'm',
      options: { ignore: [], inlineSuppressions: false },
    }).findings;
    expect(ids(findings)).toEqual(['ACME-001']);
  });

  it('can run with only custom rules', () => {
    expect(loadRules({ builtin: false, extraDirs: [dir] }).map((r) => r.id)).toEqual(['ACME-001']);
  });

  it('parses a single-rule file and a top-level list', () => {
    const one = `id: ONE-1\ntitle: t\nseverity: info\nlayer: config\ndescription: d\nremediation: r\nscope: [text]\nmatch: {type: regex, patterns: [x]}\n`;
    expect(parseRuleFile('one.yml', one)).toHaveLength(1);
    expect(parseRuleFile('list.yml', `- ${one.split('\n').join('\n  ')}`)).toHaveLength(1);
  });

  it('reports the file and rule id on invalid rules', () => {
    expect(() => parseRuleFile('bad.yml', 'id: BAD-1\ntitle: t\n')).toThrow(/bad\.yml.*BAD-1/);
  });
});
