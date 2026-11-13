import { SEVERITIES, SUBJECT_KINDS, type Severity, type SubjectKind } from '../types.js';

export type MatchSpec =
  | {
      /** Any pattern matches. */
      type: 'regex';
      patterns: string[];
      /** Skip a match when the matched line also matches one of these. */
      exclude?: string[];
      flags?: string;
      /** Match against the subject text (default) or its name. */
      target?: 'text' | 'name';
    }
  | {
      /** Every group must have at least one matching pattern in the same subject. */
      type: 'all';
      groups: string[][];
      exclude?: string[];
      flags?: string;
    }
  | {
      /** Any code point inside the listed hex ranges, e.g. "200B-200F" or "FEFF". */
      type: 'codepoints';
      ranges: string[];
      /** Code points to ignore at the very start of the text (e.g. a BOM). */
      allowLeading?: string[];
    }
  | { type: 'max-length'; max: number }
  | {
      /** Description mentions the name of a different tool found in the same scan. */
      type: 'cross-tool-reference';
      minLength?: number;
    }
  | { type: 'drift'; change: 'changed' | 'added' | 'removed' };

export const MATCH_TYPES = [
  'regex',
  'all',
  'codepoints',
  'max-length',
  'cross-tool-reference',
  'drift',
] as const;

export interface RuleDef {
  id: string;
  title: string;
  severity: Severity;
  layer: 'metadata' | 'source' | 'config' | 'drift';
  description: string;
  remediation: string;
  scope: SubjectKind[];
  match: MatchSpec;
  /** Optional message template; `{match}`, `{name}`, `{kind}` and `{detail}` are substituted. */
  message?: string;
  tags?: string[];
  enabled?: boolean;
  /** File the rule was loaded from (set by the loader). */
  source?: string;
}

export const RULE_ID_RE = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/;
const LAYERS = ['metadata', 'source', 'config', 'drift'];

export class RuleValidationError extends Error {}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** Validates a raw (parsed YAML) rule object, throwing a descriptive error on problems. */
export function validateRule(raw: unknown, where: string): RuleDef {
  const fail = (msg: string): never => {
    throw new RuleValidationError(`${where}: ${msg}`);
  };
  if (!raw || typeof raw !== 'object') fail('rule must be a mapping');
  const r = raw as Record<string, unknown>;
  const id = r.id;
  if (typeof id !== 'string' || !RULE_ID_RE.test(id)) fail(`invalid rule id ${JSON.stringify(id)}`);
  const at = `${where} (${String(id)})`;
  const f = (msg: string): never => {
    throw new RuleValidationError(`${at}: ${msg}`);
  };
  for (const key of ['title', 'description', 'remediation'] as const) {
    if (typeof r[key] !== 'string' || !(r[key] as string).trim()) f(`missing "${key}"`);
  }
  if (!SEVERITIES.includes(r.severity as Severity))
    f(`severity must be one of ${SEVERITIES.join(', ')}`);
  if (!LAYERS.includes(r.layer as string)) f(`layer must be one of ${LAYERS.join(', ')}`);
  const isDrift = (r.match as { type?: unknown } | undefined)?.type === 'drift';
  if (isDrift && r.scope === undefined) r.scope = [];
  else if (!isStringArray(r.scope) || r.scope.length === 0) f('scope must be a non-empty list');
  for (const s of r.scope as string[]) {
    if (!SUBJECT_KINDS.includes(s as SubjectKind))
      f(`unknown scope "${s}" (expected one of ${SUBJECT_KINDS.join(', ')})`);
  }
  const m = r.match as Record<string, unknown> | undefined;
  if (!m || typeof m !== 'object') f('missing "match"');
  const match = m as Record<string, unknown>;
  if (!MATCH_TYPES.includes(match.type as (typeof MATCH_TYPES)[number]))
    f(`match.type must be one of ${MATCH_TYPES.join(', ')}`);

  const checkRegexes = (list: unknown, label: string, flags?: unknown) => {
    if (!isStringArray(list) || list.length === 0)
      f(`${label} must be a non-empty list of strings`);
    for (const p of list as string[]) {
      try {
        new RegExp(p, typeof flags === 'string' ? flags : 'i');
      } catch (e) {
        f(`${label}: invalid regex ${JSON.stringify(p)}: ${(e as Error).message}`);
      }
    }
  };
  switch (match.type) {
    case 'regex':
      checkRegexes(match.patterns, 'match.patterns', match.flags);
      if (match.exclude !== undefined) checkRegexes(match.exclude, 'match.exclude', match.flags);
      if (match.target !== undefined && match.target !== 'text' && match.target !== 'name')
        f('match.target must be "text" or "name"');
      break;
    case 'all':
      if (!Array.isArray(match.groups) || match.groups.length < 2)
        f('match.groups must list at least two groups');
      (match.groups as unknown[]).forEach((g, i) =>
        checkRegexes(g, `match.groups[${i}]`, match.flags),
      );
      if (match.exclude !== undefined) checkRegexes(match.exclude, 'match.exclude', match.flags);
      break;
    case 'codepoints':
      if (!isStringArray(match.ranges) || match.ranges.length === 0)
        f('match.ranges must be a non-empty list');
      for (const range of match.ranges as string[]) {
        if (!/^[0-9A-Fa-f]{1,6}(-[0-9A-Fa-f]{1,6})?$/.test(range))
          f(`invalid code point range "${range}"`);
      }
      break;
    case 'max-length':
      if (typeof match.max !== 'number' || match.max <= 0) f('match.max must be a positive number');
      break;
    case 'drift':
      if (!['changed', 'added', 'removed'].includes(match.change as string))
        f('match.change must be changed, added or removed');
      break;
  }
  if (r.tags !== undefined && !isStringArray(r.tags)) f('tags must be a list of strings');
  if (r.message !== undefined && typeof r.message !== 'string') f('message must be a string');
  return { ...(r as unknown as RuleDef), id: id as string };
}
