import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../src/engine.js';
import { extractAll } from '../src/extract/index.js';
import { walk } from '../src/inputs/walk.js';
import { loadRules } from '../src/rules/loader.js';
import type { Finding, ScannedFile } from '../src/types.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES = path.join(ROOT, 'fixtures');
export const RULES = loadRules();

export function scanDir(dir: string, opts: { inline?: boolean } = {}): Finding[] {
  const files = walk(dir);
  return scan({
    files,
    rules: RULES,
    target: dir,
    extraction: extractAll(files),
    options: { ignore: [], inlineSuppressions: opts.inline ?? false },
  }).findings;
}

export function memFile(rel: string, content: string): ScannedFile {
  return { rel, abs: `/virtual/${rel}`, content };
}

export function scanFiles(files: ScannedFile[], inline = false): Finding[] {
  return scan({
    files,
    rules: RULES,
    target: 'mem',
    options: { ignore: [], inlineSuppressions: inline },
  }).findings;
}

export const ids = (fs: Finding[]) => [...new Set(fs.map((f) => f.ruleId))].sort();
