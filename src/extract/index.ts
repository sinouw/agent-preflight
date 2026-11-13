import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Definition, ScannedFile, Subject } from '../types.js';
import {
  extractJsTools,
  extractPythonTools,
  toolExtraction,
  type Extraction,
  type ToolInfo,
} from './mcp-source.js';
import { LineIndex } from './text.js';

export type { ToolInfo } from './mcp-source.js';

const SOURCE_EXT = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.mts',
  '.cts',
  '.tsx',
  '.py',
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
]);
const JS_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx']);

/** Locates `"key": <value>` in raw JSON text, searching from `from`, returning a line. */
function jsonLine(idx: LineIndex, content: string, key: string, value: unknown, from = 0): number {
  const needles: string[] = [];
  if (typeof value === 'string') needles.push(`${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  needles.push(JSON.stringify(key));
  for (const n of needles) {
    let at = content.indexOf(n, from);
    if (at < 0 && typeof value === 'string') {
      // Tolerate different spacing / escaping.
      const re = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:\\s*`, 'g');
      re.lastIndex = from;
      const m = re.exec(content);
      at = m ? m.index : -1;
    }
    if (at >= 0) return idx.pos(at).line;
  }
  return 1;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

interface HookEntry {
  event: string;
  matcher?: string;
  command: string;
}

function collectHooks(hooks: unknown): HookEntry[] {
  const out: HookEntry[] = [];
  if (!isObj(hooks)) return out;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!isObj(g)) continue;
      const matcher = str(g.matcher);
      const list = Array.isArray(g.hooks) ? g.hooks : [g];
      for (const h of list) {
        if (isObj(h) && typeof h.command === 'string')
          out.push({ event, matcher, command: h.command });
      }
    }
  }
  return out;
}

function extractJson(file: ScannedFile, out: Extraction): void {
  let doc: unknown;
  try {
    doc = JSON.parse(file.content.replace(/^\uFEFF/, ''));
  } catch {
    return;
  }
  if (!isObj(doc)) return;
  const idx = new LineIndex(file.content);
  const base = path.posix.basename(file.rel);
  const c = file.content;

  // package.json lifecycle and other scripts
  if (base === 'package.json' && isObj(doc.scripts)) {
    for (const [name, cmd] of Object.entries(doc.scripts)) {
      if (typeof cmd !== 'string') continue;
      out.subjects.push({
        kind: 'package-script',
        file: file.rel,
        line: jsonLine(idx, c, name, cmd),
        text: cmd,
        name,
      });
    }
  }

  // Claude Code hooks: settings.json, settings.local.json, hooks/hooks.json, inline plugin hooks
  const hookCounts = new Map<string, number>();
  for (const h of collectHooks(doc.hooks)) {
    const label = `${h.event}${h.matcher ? `[${h.matcher}]` : ''}`;
    const n = hookCounts.get(label) ?? 0;
    hookCounts.set(label, n + 1);
    const at = c.indexOf(JSON.stringify(h.command).slice(1, -1));
    const line = at >= 0 ? idx.pos(at).line : jsonLine(idx, c, 'command', h.command);
    out.subjects.push({ kind: 'hook-command', file: file.rel, line, text: h.command, name: label });
    out.definitions.push({
      kind: 'hook',
      name: `${label}#${n}`,
      file: file.rel,
      line,
      content: { event: h.event, matcher: h.matcher ?? null, command: h.command },
    });
  }

  // MCP server launch configs: claude_desktop_config.json, .mcp.json, plugin.json, ...
  const serverMaps: Record<string, unknown>[] = [];
  if (isObj(doc.mcpServers)) serverMaps.push(doc.mcpServers);
  if (isObj(doc.servers) && /mcp/i.test(base)) serverMaps.push(doc.servers);
  for (const map of serverMaps) {
    for (const [name, cfg] of Object.entries(map)) {
      if (!isObj(cfg)) continue;
      const args = Array.isArray(cfg.args) ? cfg.args.filter((a) => typeof a === 'string') : [];
      const text = [str(cfg.command), ...args, str(cfg.url)].filter(Boolean).join(' ');
      const line = jsonLine(idx, c, name, undefined);
      out.subjects.push({ kind: 'mcp-config', file: file.rel, line, text, name });
      out.definitions.push({
        kind: 'mcp-server',
        name,
        file: file.rel,
        line,
        content: {
          name,
          type: str(cfg.type) ?? null,
          command: str(cfg.command) ?? null,
          args,
          url: str(cfg.url) ?? null,
          // Only key names: env values may hold secrets and never go into lockfiles or reports.
          envKeys: isObj(cfg.env) ? Object.keys(cfg.env).sort() : [],
        },
      });
    }
  }

  // Plugin / marketplace manifests
  if (
    base === 'plugin.json' ||
    base === 'marketplace.json' ||
    file.rel.includes('.claude-plugin/')
  ) {
    const entries: Record<string, unknown>[] = [doc];
    if (Array.isArray(doc.plugins)) entries.push(...doc.plugins.filter(isObj));
    let from = 0;
    for (const e of entries) {
      const description = str(e.description);
      const name = str(e.name) ?? path.posix.dirname(file.rel);
      if (description !== undefined) {
        const line = jsonLine(idx, c, 'description', description, from);
        out.subjects.push({
          kind: 'plugin-manifest',
          file: file.rel,
          line,
          text: description,
          name,
        });
        const at = c.indexOf(JSON.stringify(description), from);
        if (at >= 0) from = at + 1;
      }
      if (e === doc && base === 'plugin.json') {
        out.definitions.push({
          kind: 'plugin',
          name,
          file: file.rel,
          line: 1,
          content: { name, version: str(e.version) ?? null, description: description ?? null },
        });
      }
    }
  }

  // Static tool manifests: { "tools": [{ name, description, inputSchema }] }
  if (Array.isArray(doc.tools)) {
    const tools: ToolInfo[] = [];
    let from = 0;
    for (const t of doc.tools) {
      if (!isObj(t) || typeof t.name !== 'string') continue;
      const nameAt = c.indexOf(JSON.stringify(t.name), from);
      if (nameAt >= 0) from = nameAt;
      const schema = (t.inputSchema ?? t.input_schema ?? t.parameters) as unknown;
      const props = isObj(schema) && isObj(schema.properties) ? schema.properties : {};
      tools.push({
        name: t.name,
        description: str(t.description) ?? '',
        file: file.rel,
        line: idx.pos(Math.max(nameAt, 0)).line,
        descLine: jsonLine(idx, c, 'description', t.description, from),
        params: Object.entries(props).map(([pname, p]) => ({
          name: pname,
          description: isObj(p) ? str(p.description) : undefined,
          line: jsonLine(idx, c, pname, undefined, from),
          descLine:
            isObj(p) && typeof p.description === 'string'
              ? jsonLine(idx, c, 'description', p.description, from)
              : undefined,
        })),
      });
    }
    merge(out, toolExtraction(tools));
  }
}

function frontmatter(content: string): Record<string, unknown> {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!m) return {};
  try {
    const fm = parseYaml(m[1] as string) as unknown;
    return isObj(fm) ? fm : {};
  } catch {
    return {};
  }
}

function markdownKind(rel: string): 'skill' | 'agent' | 'command' | undefined {
  const parts = rel.split('/');
  const base = parts[parts.length - 1] ?? '';
  if (base.toUpperCase() === 'SKILL.MD') return 'skill';
  if (parts.includes('agents')) return 'agent';
  if (parts.includes('commands')) return 'command';
  return undefined;
}

function merge(into: Extraction, from: Extraction): void {
  into.subjects.push(...from.subjects);
  into.definitions.push(...from.definitions);
  into.tools.push(...from.tools);
}

/** Turns one scanned file into rule subjects, lockable definitions and extracted tools. */
export function extractFile(file: ScannedFile): Extraction {
  const out: Extraction = { subjects: [], definitions: [], tools: [] };
  const ext = path.posix.extname(file.rel).toLowerCase();

  if (SOURCE_EXT.has(ext)) {
    out.subjects.push({ kind: 'source', file: file.rel, line: 1, text: file.content, offset: 0 });
    if (JS_EXT.has(ext)) merge(out, toolExtraction(extractJsTools(file)));
    else if (ext === '.py') merge(out, toolExtraction(extractPythonTools(file)));
    return out;
  }

  if (ext === '.md' || ext === '.mdx') {
    const kind = markdownKind(file.rel);
    if (kind) {
      const fm = frontmatter(file.content);
      const name =
        str(fm.name) ??
        (kind === 'skill'
          ? path.posix.basename(path.posix.dirname(file.rel))
          : path.posix.basename(file.rel, ext));
      out.subjects.push({ kind, file: file.rel, line: 1, text: file.content, name, offset: 0 });
      out.definitions.push({
        kind,
        name,
        file: file.rel,
        line: 1,
        content: { name, text: file.content },
      });
      return out;
    }
  }

  out.subjects.push({ kind: 'text', file: file.rel, line: 1, text: file.content, offset: 0 });
  if (ext === '.json') extractJson(file, out);
  return out;
}

export function extractAll(files: ScannedFile[]): Extraction {
  const out: Extraction = { subjects: [], definitions: [], tools: [] };
  for (const f of files) merge(out, extractFile(f));
  return out;
}

export type { Extraction, Subject, Definition };
