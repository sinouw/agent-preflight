export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

export function severityRank(s: Severity): number {
  return SEVERITIES.length - SEVERITIES.indexOf(s);
}

/**
 * The kinds of things the scanner extracts and rules can target.
 *
 * - tool-description / param-description / param-name: MCP tool metadata
 * - skill / agent / command: Claude Code markdown definitions
 * - plugin-manifest: description fields of plugin / marketplace manifests
 * - hook-command: command strings of Claude Code hooks
 * - mcp-config: MCP server launch configuration (command + args / url)
 * - package-script: npm lifecycle scripts (subject name is the script name)
 * - source: raw text of a source file (JS/TS/Python/shell)
 * - text: raw text of any other scanned text file (markdown, JSON, YAML)
 */
export const SUBJECT_KINDS = [
  'tool-description',
  'param-description',
  'param-name',
  'skill',
  'agent',
  'command',
  'plugin-manifest',
  'hook-command',
  'mcp-config',
  'package-script',
  'source',
  'text',
] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

/** A piece of text that rules are evaluated against. */
export interface Subject {
  kind: SubjectKind;
  /** Path relative to the scan root, POSIX separators. */
  file: string;
  /** 1-based line where `text` begins in the file. */
  line: number;
  /** Text the rule matches against (descriptions are decoded string literal values). */
  text: string;
  /** Name of the tool / param / skill / hook / script this subject belongs to. */
  name?: string;
  /** For params: the owning tool name. */
  parent?: string;
  /** When set, offsets in `text` map 1:1 onto the file content starting at `offset`. */
  offset?: number;
  /**
   * For decoded string values: ascending `[textIndex, line]` pairs giving the source line
   * where the text at `textIndex` starts.
   */
  lineMap?: Array<[number, number]>;
}

/** A definition whose shape is pinned by the lockfile. */
export interface Definition {
  kind: 'tool' | 'skill' | 'agent' | 'command' | 'hook' | 'mcp-server' | 'plugin';
  name: string;
  file: string;
  line: number;
  /** Normalized, stable content of the definition. */
  content: Record<string, unknown>;
}

export interface ScannedFile {
  /** Path relative to the scan root, POSIX separators. */
  rel: string;
  abs: string;
  content: string;
}

export interface Finding {
  ruleId: string;
  severity: Severity;
  title: string;
  message: string;
  file: string;
  line: number;
  column: number;
  snippet: string;
  subjectKind: SubjectKind | 'drift';
  subjectName?: string;
  remediation: string;
}

export interface ScanStats {
  files: number;
  definitions: number;
  rules: number;
  suppressed: number;
}

export interface ScanResult {
  target: string;
  findings: Finding[];
  definitions: Definition[];
  stats: ScanStats;
}
