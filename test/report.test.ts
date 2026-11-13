import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { scan } from '../src/engine.js';
import { extractAll } from '../src/extract/index.js';
import { walk } from '../src/inputs/walk.js';
import { formatJson, formatPretty, formatSarif } from '../src/report/index.js';
import { FIXTURES, ROOT, RULES } from './helpers.js';

const files = walk(FIXTURES);
const result = scan({
  files,
  rules: RULES,
  target: 'fixtures',
  extraction: extractAll(files),
  options: { ignore: [], inlineSuppressions: false },
});

describe('SARIF output', () => {
  const sarif = JSON.parse(formatSarif(result, RULES));
  it('validates against the SARIF 2.1.0 schema', () => {
    const schema = JSON.parse(
      readFileSync(path.join(ROOT, 'test/schemas/sarif-schema-2.1.0.json'), 'utf8'),
    );
    const ajv = new Ajv({ strict: false, allErrors: true });
    (addFormats as unknown as (a: Ajv) => void)(ajv);
    const validate = ajv.compile(schema);
    const ok = validate(sarif);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });
  it('has one result per finding with valid rule indexes', () => {
    const run = sarif.runs[0];
    expect(run.results).toHaveLength(result.findings.length);
    for (const r of run.results) expect(run.tool.driver.rules[r.ruleIndex].id).toBe(r.ruleId);
    expect(run.tool.driver.rules[0].properties['security-severity']).toMatch(/^\d+\.\d$/);
  });
});

describe('JSON and pretty output', () => {
  it('JSON includes a severity summary', () => {
    const json = JSON.parse(formatJson(result));
    expect(json.summary.critical).toBeGreaterThan(0);
    expect(json.findings).toHaveLength(result.findings.length);
  });
  it('pretty output lists findings with locations', () => {
    const out = formatPretty(result);
    expect(out).toContain('PF-INJ-001');
    expect(out).toMatch(/poisoned-mcp-ts\/src\/index\.ts:\d+:\d+/);
  });
});
