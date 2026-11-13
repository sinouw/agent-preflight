import { readFileSync, existsSync } from 'node:fs';
import picomatch from 'picomatch';
import { extractAll, type Extraction } from './extract/index.js';
import { LineIndex, visualize } from './extract/text.js';
import { RULE_ID_RE, type RuleDef } from './rules/schema.js';
import {
  severityRank,
  type Finding,
  type ScanResult,
  type ScannedFile,
  type Severity,
  type Subject,
} from './types.js';

const MAX_PER_SUBJECT = 20;

export interface IgnoreEntry {
  rule?: string;
  glob?: string;
}

/**
 * Parses a .preflightignore file. Each non-comment line is one of:
 *   path/glob/**          ignore every finding in matching files
 *   PF-URL-001            disable a rule everywhere
 *   PF-URL-001 docs/**    disable a rule for matching files
 */
export function parseIgnoreFile(text: string): IgnoreEntry[] {
  const out: IgnoreEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const [first, ...rest] = line.split(/\s+/);
    if (first && RULE_ID_RE.test(first))
      out.push({ rule: first, glob: rest.join(' ') || undefined });
    else out.push({ glob: line });
  }
  return out;
}

export function loadIgnoreFile(file: string): IgnoreEntry[] {
  return existsSync(file) ? parseIgnoreFile(readFileSync(file, 'utf8')) : [];
}

export interface ScanOptions {
  /** Honour inline `preflight-ignore` comments (only for trusted, local content). */
  inlineSuppressions: boolean;
  ignore: IgnoreEntry[];
  minSeverity?: Severity;
}

function compile(pattern: string, flags = 'i'): RegExp {
  return new RegExp(pattern, flags.includes('g') ? flags : flags + 'g');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface Hit {
  index: number;
  length: number;
  match: string;
  detail?: string;
}

function lineOfIndex(text: string, index: number): string {
  const start = text.lastIndexOf('\n', index - 1) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end < 0 ? undefined : end);
}

function regexHits(text: string, patterns: RegExp[], exclude: RegExp[]): Hit[] {
  const hits: Hit[] = [];
  for (const re of patterns) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      if (m[0].length === 0) continue;
      const lineText = lineOfIndex(text, m.index ?? 0);
      if (
        exclude.some((x) => {
          x.lastIndex = 0;
          return x.test(lineText);
        })
      )
        continue;
      hits.push({ index: m.index ?? 0, length: m[0].length, match: m[0] });
      if (hits.length >= MAX_PER_SUBJECT) return hits;
    }
  }
  return hits;
}

function parseRanges(ranges: string[]): [number, number][] {
  return ranges.map((r) => {
    const [a, b] = r.split('-');
    const lo = parseInt(a as string, 16);
    return [lo, b ? parseInt(b, 16) : lo];
  });
}

function codepointHits(text: string, ranges: [number, number][], allowLeading: number[]): Hit[] {
  const byLine = new Map<number, Hit>();
  let lineNo = 0;
  let i = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp === 10) lineNo++;
    const leading = i === 0 && allowLeading.includes(cp);
    if (!leading && ranges.some(([lo, hi]) => cp >= lo && cp <= hi)) {
      const label = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
      const existing = byLine.get(lineNo);
      if (existing) {
        const set = new Set((existing.detail ?? '').split(', '));
        set.add(label);
        existing.detail = [...set].join(', ');
        existing.match = String(Number(existing.match) + 1);
      } else if (byLine.size < MAX_PER_SUBJECT) {
        byLine.set(lineNo, { index: i, length: ch.length, match: '1', detail: label });
      }
    }
    i += ch.length;
  }
  return [...byLine.values()];
}

function looksLikeIdentifier(name: string, minLength: number): boolean {
  return name.length >= minLength && (/[_-]/.test(name) || /[a-z][A-Z]/.test(name));
}

function evaluate(rule: RuleDef, subject: Subject, ctx: { toolNames: string[] }): Hit[] {
  const m = rule.match;
  const text = m.type === 'regex' && m.target === 'name' ? (subject.name ?? '') : subject.text;
  switch (m.type) {
    case 'regex':
      return regexHits(
        text,
        m.patterns.map((p) => compile(p, m.flags)),
        (m.exclude ?? []).map((p) => compile(p, m.flags)),
      );
    case 'all': {
      const exclude = (m.exclude ?? []).map((p) => compile(p, m.flags));
      let last: Hit[] = [];
      for (const group of m.groups) {
        last = regexHits(
          text,
          group.map((p) => compile(p, m.flags)),
          exclude,
        );
        if (last.length === 0) return [];
      }
      return last.slice(0, 1);
    }
    case 'codepoints':
      return codepointHits(
        text,
        parseRanges(m.ranges),
        (m.allowLeading ?? []).map((h) => parseInt(h, 16)),
      );
    case 'max-length':
      return text.length > m.max
        ? [
            {
              index: 0,
              length: 0,
              match: String(text.length),
              detail: `${text.length} characters (limit ${m.max})`,
            },
          ]
        : [];
    case 'cross-tool-reference': {
      const own = new Set([subject.name, subject.parent].filter(Boolean));
      const hits: Hit[] = [];
      for (const other of ctx.toolNames) {
        if (own.has(other) || !looksLikeIdentifier(other, m.minLength ?? 5)) continue;
        const re = new RegExp(`(?<![\\w-])${escapeRe(other)}(?![\\w-])`, 'g');
        const hit = re.exec(text);
        if (hit) hits.push({ index: hit.index, length: other.length, match: other });
      }
      return hits;
    }
    case 'drift':
      return [];
  }
}

function inlineSuppressed(idx: LineIndex, line: number, ruleId: string): boolean {
  for (const l of [line, line - 1]) {
    if (l < 1) continue;
    const text = idx.lineText(l);
    const m = /preflight-ignore(?:-next-line)?\b[:\s]*([A-Z0-9][A-Z0-9,\s-]*)?/.exec(text);
    if (!m) continue;
    const ids = (m[1] ?? '').split(/[\s,]+/).filter((t) => RULE_ID_RE.test(t));
    if (ids.length === 0 || ids.includes(ruleId)) return true;
  }
  return false;
}

export function isIgnored(ignore: IgnoreEntry[], ruleId: string, file: string): boolean {
  return ignore.some((e) => {
    if (e.rule && e.rule !== ruleId) return false;
    if (!e.glob) return true;
    const glob = e.glob.replace(/^\.?\//, '');
    const isMatch = picomatch(glob.endsWith('/') ? `${glob}**` : glob, { dot: true });
    return isMatch(file) || picomatch(`${glob}/**`, { dot: true })(file);
  });
}

function render(template: string | undefined, rule: RuleDef, hit: Hit, subject: Subject): string {
  const match = visualize(hit.match).slice(0, 120);
  const name = subject.parent ? `${subject.parent}.${subject.name}` : (subject.name ?? '');
  if (template) {
    return template
      .replace(/\{match\}/g, match)
      .replace(/\{name\}/g, name)
      .replace(/\{kind\}/g, subject.kind)
      .replace(/\{detail\}/g, hit.detail ?? '');
  }
  const where = subject.name ? ` in ${subject.kind} "${name}"` : '';
  if (rule.match.type === 'codepoints') return `${rule.title}${where}: ${hit.detail}`;
  if (rule.match.type === 'max-length') return `${rule.title}${where}: ${hit.detail}`;
  return `${rule.title}${where}: "${match}"`;
}

export interface EngineInput {
  files: ScannedFile[];
  rules: RuleDef[];
  options: ScanOptions;
  target: string;
  extraction?: Extraction;
}

export function makeFinding(
  rule: RuleDef,
  fields: Omit<Finding, 'ruleId' | 'severity' | 'title' | 'remediation'>,
): Finding {
  return {
    ruleId: rule.id,
    severity: rule.severity,
    title: rule.title,
    remediation: rule.remediation,
    ...fields,
  };
}

/** Runs every non-drift rule over the extracted subjects. */
export function scan(input: EngineInput): ScanResult {
  const { files, rules, options } = input;
  const extraction = input.extraction ?? extractAll(files);
  const indexes = new Map<string, LineIndex>();
  for (const f of files) indexes.set(f.rel, new LineIndex(f.content));
  const toolNames = [...new Set(extraction.tools.map((t) => t.name))];
  const findings: Finding[] = [];
  const seen = new Set<string>();
  let suppressed = 0;
  const minRank = options.minSeverity ? severityRank(options.minSeverity) : 0;

  for (const rule of rules) {
    if (rule.match.type === 'drift') continue;
    if (severityRank(rule.severity) < minRank) continue;
    const scope = new Set(rule.scope);
    for (const subject of extraction.subjects) {
      if (!scope.has(subject.kind)) continue;
      const idx = indexes.get(subject.file);
      for (const hit of evaluate(rule, subject, { toolNames })) {
        let line: number;
        let column: number;
        if (subject.offset !== undefined && idx) {
          ({ line, column } = idx.pos(subject.offset + hit.index));
        } else if (subject.lineMap?.length) {
          let entry = subject.lineMap[0] as [number, number];
          for (const e of subject.lineMap) if (e[0] <= hit.index) entry = e;
          line = entry[1];
          column = 1;
        } else {
          const before = subject.text.slice(0, hit.index);
          const nl = before.split('\n').length - 1;
          // Decoded string values: approximate the line by counting newlines in the value.
          line = subject.line + nl;
          column = 1;
        }
        const key = `${rule.id}\0${subject.file}\0${line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (
          isIgnored(options.ignore, rule.id, subject.file) ||
          (options.inlineSuppressions && idx && inlineSuppressed(idx, line, rule.id))
        ) {
          suppressed++;
          continue;
        }
        const raw = idx?.lineText(line) ?? '';
        findings.push(
          makeFinding(rule, {
            message: render(rule.message, rule, hit, subject),
            file: subject.file,
            line,
            column,
            snippet: visualize(raw.trim()).slice(0, 200),
            subjectKind: subject.kind,
            subjectName: subject.parent ? `${subject.parent}.${subject.name}` : subject.name,
          }),
        );
      }
    }
  }
  return {
    target: input.target,
    findings: sortFindings(findings),
    definitions: extraction.definitions,
    stats: {
      files: files.length,
      definitions: extraction.definitions.length,
      rules: rules.length,
      suppressed,
    },
  };
}

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      severityRank(b.severity) - severityRank(a.severity) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.ruleId.localeCompare(b.ruleId),
  );
}

export function meetsThreshold(findings: Finding[], failOn: Severity | 'none'): boolean {
  if (failOn === 'none') return false;
  const rank = severityRank(failOn);
  return findings.some((f) => severityRank(f.severity) >= rank);
}
