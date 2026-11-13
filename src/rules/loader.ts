import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { RuleValidationError, validateRule, type RuleDef } from './schema.js';

/** Locates the built-in `rules/` directory shipped with the package. */
export function builtinRulesDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'rules');
    if (existsSync(path.join(dir, 'package.json')) && existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('could not locate the built-in rules directory');
}

function yamlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const p = path.join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...yamlFiles(p));
    else if (/\.ya?ml$/i.test(entry)) out.push(p);
  }
  return out;
}

/** Parses one YAML rule file. A file holds either a single rule or `rules: [...]`. */
export function parseRuleFile(file: string, text = readFileSync(file, 'utf8')): RuleDef[] {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (e) {
    throw new RuleValidationError(`${file}: invalid YAML: ${(e as Error).message}`);
  }
  if (doc === null || doc === undefined) return [];
  const list =
    typeof doc === 'object' && !Array.isArray(doc) && 'rules' in (doc as object)
      ? (doc as { rules: unknown }).rules
      : Array.isArray(doc)
        ? doc
        : [doc];
  if (!Array.isArray(list)) throw new RuleValidationError(`${file}: "rules" must be a list`);
  return list.map((raw, i) => ({
    ...validateRule(raw, `${file}#${i}`),
    source: file,
  }));
}

export interface LoadRulesOptions {
  builtin?: boolean;
  extraDirs?: string[];
}

/**
 * Loads built-in rules plus any custom rule packs. A custom rule with the same id as a
 * built-in replaces it, which lets packs tune severity or disable rules (`enabled: false`).
 */
export function loadRules(opts: LoadRulesOptions = {}): RuleDef[] {
  const dirs: string[] = [];
  if (opts.builtin !== false) dirs.push(builtinRulesDir());
  for (const d of opts.extraDirs ?? []) {
    if (!existsSync(d)) throw new Error(`rules path not found: ${d}`);
    dirs.push(d);
  }
  const byId = new Map<string, RuleDef>();
  for (const dir of dirs) {
    const files = statSync(dir).isDirectory() ? yamlFiles(dir) : [dir];
    const seenInDir = new Set<string>();
    for (const file of files) {
      for (const rule of parseRuleFile(file)) {
        if (seenInDir.has(rule.id))
          throw new RuleValidationError(`${file}: duplicate rule id ${rule.id}`);
        seenInDir.add(rule.id);
        byId.set(rule.id, rule);
      }
    }
  }
  return [...byId.values()].filter((r) => r.enabled !== false);
}
