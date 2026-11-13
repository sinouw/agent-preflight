import type { Definition, ScannedFile, Subject } from '../types.js';
import { findMatching, LineIndex, readConcatenated, readLiteral, skipWs } from './text.js';

/** A statically extracted MCP tool definition. */
export interface ToolInfo {
  name: string;
  description: string;
  file: string;
  line: number;
  descLine: number;
  /** `[valueIndex, line]` pairs, see `lineMap`. */
  descMap?: Array<[number, number]>;
  params: ParamInfo[];
}

export interface ParamInfo {
  name: string;
  description?: string;
  line: number;
  descLine?: number;
  descMap?: Array<[number, number]>;
}

export interface Extraction {
  subjects: Subject[];
  definitions: Definition[];
  tools: ToolInfo[];
}

/** Converts literal marks into `[valueIndex, line]` pairs; `shift` accounts for trimmed text. */
function lineMap(
  idx: LineIndex,
  lit: { marks: Array<[number, number]> } | undefined,
  shift = 0,
): Array<[number, number]> | undefined {
  if (!lit) return undefined;
  return lit.marks.map(([v, at]) => [Math.max(0, v - shift), idx.pos(at).line]);
}

export function toolExtraction(tools: ToolInfo[]): Extraction {
  const subjects: Subject[] = [];
  const definitions: Definition[] = [];
  for (const t of tools) {
    subjects.push({
      kind: 'tool-description',
      file: t.file,
      line: t.descLine,
      lineMap: t.descMap,
      text: t.description,
      name: t.name,
    });
    for (const p of t.params) {
      subjects.push({
        kind: 'param-name',
        file: t.file,
        line: p.line,
        text: p.name,
        name: p.name,
        parent: t.name,
      });
      if (p.description !== undefined)
        subjects.push({
          kind: 'param-description',
          file: t.file,
          line: p.descLine ?? p.line,
          lineMap: p.descMap,
          text: p.description,
          name: p.name,
          parent: t.name,
        });
    }
    definitions.push({
      kind: 'tool',
      name: t.name,
      file: t.file,
      line: t.line,
      content: {
        name: t.name,
        description: t.description,
        params: [...t.params]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((p) => ({ name: p.name, description: p.description ?? null })),
      },
    });
  }
  return { subjects, definitions, tools };
}

// ---------------------------------------------------------------- JS / TS

/** Extracts params from a zod raw shape or JSON-schema `properties` object region. */
function jsParams(src: string, from: number, to: number, idx: LineIndex): ParamInfo[] {
  const region = src.slice(from, to);
  const params: ParamInfo[] = [];
  const seen = new Set<string>();
  const keyRe = /(?:^|[{,\s])(['"]?)([A-Za-z_$][\w$]*)\1\s*:\s*(z\b|\{)/g;
  const keys: { name: string; at: number; zod: boolean; valueAt: number }[] = [];
  for (const m of region.matchAll(keyRe)) {
    const name = m[2] as string;
    if (['properties', 'inputSchema', 'input_schema', 'type', 'items', 'shape'].includes(name))
      continue;
    const at = from + (m.index ?? 0) + (m[0].length - m[0].trimStart().length);
    const valueAt = from + (m.index ?? 0) + m[0].length - (m[3] as string).length;
    if (m[3] === '{') {
      // JSON-schema style: only count objects that declare a type or description.
      const close = findMatching(src, valueAt);
      const body = close > 0 ? src.slice(valueAt, close) : '';
      if (!/\b(type|description)\s*['"]?\s*:/.test(body) || /\bproperties\s*['"]?\s*:/.test(body))
        continue;
    }
    keys.push({ name, at, zod: m[3] === 'z', valueAt });
  }
  keys.forEach((k, i) => {
    if (seen.has(k.name)) return;
    seen.add(k.name);
    const end = k.zod ? (keys[i + 1]?.at ?? to) : Math.max(findMatching(src, k.valueAt), k.valueAt);
    const body = src.slice(k.valueAt, end);
    const descRe = k.zod ? /\.describe\(\s*/g : /['"]?description['"]?\s*:\s*/g;
    const dm = descRe.exec(body);
    let description: string | undefined;
    let descLine: number | undefined;
    let descMap: Array<[number, number]> | undefined;
    if (dm) {
      const litAt = k.valueAt + dm.index + dm[0].length;
      const lit = readConcatenated(src, litAt);
      if (lit) {
        description = lit.value;
        descLine = idx.pos(litAt).line;
        descMap = lineMap(idx, lit);
      }
    }
    params.push({ name: k.name, description, line: idx.pos(k.at).line, descLine, descMap });
  });
  return params;
}

export function extractJsTools(file: ScannedFile): ToolInfo[] {
  const src = file.content;
  if (!/\btool\b|registerTool|ListToolsRequestSchema|inputSchema/i.test(src)) return [];
  const idx = new LineIndex(src);
  const tools: ToolInfo[] = [];
  const covered: [number, number][] = [];

  // server.tool("name", "description", { ...shape }, handler)
  // server.registerTool("name", { title, description, inputSchema: { ... } }, handler)
  for (const m of src.matchAll(/\.(tool|registerTool)\s*\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const close = findMatching(src, open);
    if (close < 0) continue;
    let i = skipWs(src, open + 1);
    const nameLit = readLiteral(src, i);
    if (!nameLit) continue;
    i = skipWs(src, nameLit.end);
    if (src[i] !== ',') continue;
    i = skipWs(src, i + 1);
    let description = '';
    let descLine = idx.pos(nameLit.start).line;
    let descMap: Array<[number, number]> | undefined;
    let paramsFrom = i;
    let paramsTo = close;
    const descLit = readConcatenated(src, i);
    if (descLit) {
      description = descLit.value;
      descLine = idx.pos(descLit.start).line;
      descMap = lineMap(idx, descLit);
      paramsFrom = descLit.end;
    } else if (src[i] === '{') {
      const objClose = findMatching(src, i);
      const obj = src.slice(i, objClose);
      const dm = /\bdescription\s*:\s*/.exec(obj);
      if (dm) {
        const lit = readConcatenated(src, i + dm.index + dm[0].length);
        if (lit) {
          description = lit.value;
          descLine = idx.pos(lit.start).line;
          descMap = lineMap(idx, lit);
        }
      }
      const sm = /\b(inputSchema|paramsSchema)\s*:\s*/.exec(obj);
      paramsFrom = sm ? i + sm.index + sm[0].length : objClose;
      paramsTo = objClose;
    }
    tools.push({
      name: nameLit.value,
      description,
      file: file.rel,
      line: idx.pos(nameLit.start).line,
      descLine,
      descMap,
      params: jsParams(src, paramsFrom, paramsTo, idx),
    });
    covered.push([m.index ?? 0, close]);
  }

  // Low-level SDK: tools: [{ name: "x", description: "...", inputSchema: { properties: {...} } }]
  if (/ListToolsRequestSchema|inputSchema/.test(src)) {
    for (const m of src.matchAll(/\bname\s*:\s*(?=['"`])/g)) {
      const at = (m.index ?? 0) + m[0].length;
      if (covered.some(([a, b]) => at > a && at < b)) continue;
      const nameLit = readLiteral(src, at);
      if (!nameLit) continue;
      const window = src.slice(nameLit.end, nameLit.end + 400);
      const dm = /^\s*,\s*(?:title\s*:\s*(['"`]).*?\1\s*,\s*)?description\s*:\s*/s.exec(window);
      if (!dm) continue;
      const descLit = readConcatenated(src, nameLit.end + dm[0].length);
      if (!descLit) continue;
      let params: ParamInfo[] = [];
      const after = src.slice(descLit.end, descLit.end + 200);
      const sm = /^\s*,\s*inputSchema\s*:\s*\{/.exec(after);
      if (sm) {
        const open = descLit.end + sm[0].length - 1;
        const close = findMatching(src, open);
        if (close > 0) params = jsParams(src, open, close, idx);
      }
      tools.push({
        name: nameLit.value,
        description: descLit.value,
        file: file.rel,
        line: idx.pos(nameLit.start).line,
        descLine: idx.pos(descLit.start).line,
        descMap: lineMap(idx, descLit),
        params,
      });
    }
  }
  return tools;
}

// ---------------------------------------------------------------- Python

function splitTopLevel(s: string): { text: string; at: number }[] {
  const parts: { text: string; at: number }[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    if (ch === '"' || ch === "'") {
      const lit = readLiteral(s, i, true);
      if (lit) {
        i = lit.end - 1;
        continue;
      }
    }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) {
      parts.push({ text: s.slice(start, i), at: start });
      start = i + 1;
    }
  }
  parts.push({ text: s.slice(start), at: start });
  return parts.filter((p) => p.text.trim());
}

function pyKwargString(src: string, from: number, to: number, key: string): Literal2 | undefined {
  const re = new RegExp(`\\b${key}\\s*=\\s*`, 'g');
  re.lastIndex = from;
  const m = re.exec(src);
  if (!m || m.index >= to) return undefined;
  const lit = readConcatenated(src, m.index + m[0].length, true);
  return lit ? { value: lit.value, start: lit.start, marks: lit.marks } : undefined;
}
interface Literal2 {
  value: string;
  start: number;
  marks: Array<[number, number]>;
  /** Characters trimmed from the start of the decoded value. */
  shift?: number;
}

export function extractPythonTools(file: ScannedFile): ToolInfo[] {
  const src = file.content;
  if (!/\btool\b|Tool\(/.test(src)) return [];
  const idx = new LineIndex(src);
  const tools: ToolInfo[] = [];

  // @mcp.tool / @server.tool() / @app.tool(name=..., description=...)
  for (const m of src.matchAll(/^[ \t]*@(?:[A-Za-z_][\w]*\.)*tool\b[ \t]*(\()?/gm)) {
    let i = (m.index ?? 0) + m[0].length;
    let nameOverride: Literal2 | undefined;
    let descOverride: Literal2 | undefined;
    if (m[1]) {
      const open = i - 1;
      const close = findMatching(src, open, true);
      if (close < 0) continue;
      nameOverride = pyKwargString(src, open, close, 'name');
      descOverride = pyKwargString(src, open, close, 'description');
      const firstArg = readLiteral(src, skipWs(src, open + 1), true);
      if (!nameOverride && firstArg) nameOverride = firstArg;
      i = close + 1;
    }
    const defRe = /^[ \t]*(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)[ \t]*\(/gm;
    defRe.lastIndex = i;
    const dm = defRe.exec(src);
    if (!dm) continue;
    // Only accept the def if nothing but other decorators sits between.
    const between = src.slice(i, dm.index);
    if (
      between
        .split('\n')
        .some((l) => l.trim() && !l.trim().startsWith('@') && !l.trim().startsWith('#'))
    )
      continue;
    const parenOpen = dm.index + dm[0].length - 1;
    const parenClose = findMatching(src, parenOpen, true);
    if (parenClose < 0) continue;
    const params: ParamInfo[] = [];
    for (const part of splitTopLevel(src.slice(parenOpen + 1, parenClose))) {
      const pm = /^\s*\**([A-Za-z_]\w*)/.exec(part.text);
      if (!pm) continue;
      const pname = pm[1] as string;
      if (pname === 'self' || pname === 'cls' || /:\s*Context\b/.test(part.text)) continue;
      const absAt = parenOpen + 1 + part.at + (pm.index ?? 0) + (pm[0].length - pname.length);
      const desc = pyKwargString(
        src,
        absAt,
        parenOpen + 1 + part.at + part.text.length,
        'description',
      );
      params.push({
        name: pname,
        description: desc?.value,
        line: idx.pos(absAt).line,
        descLine: desc ? idx.pos(desc.start).line : undefined,
        descMap: lineMap(idx, desc),
      });
    }
    // Docstring: first statement in the body.
    const colon = src.indexOf(':', parenClose);
    let docstring: Literal2 | undefined;
    if (colon > 0) {
      const bodyStart = src.indexOf('\n', colon);
      const j = bodyStart < 0 ? colon + 1 : skipWs(src, bodyStart + 1);
      const lit = readLiteral(src, j, true);
      if (lit) {
        const shift = lit.value.length - lit.value.trimStart().length;
        docstring = { value: lit.value.trim(), start: lit.start, marks: lit.marks, shift };
      }
    }
    const desc = descOverride ?? docstring;
    const nameAt = nameOverride?.start ?? dm.index;
    tools.push({
      name: nameOverride?.value ?? (dm[1] as string),
      description: desc?.value ?? '',
      file: file.rel,
      line: idx.pos(nameAt).line,
      descLine: idx.pos(desc?.start ?? dm.index).line,
      descMap: lineMap(idx, desc, desc?.shift),
      params,
    });
  }

  // Low-level SDK: types.Tool(name="x", description="...", inputSchema={...})
  for (const m of src.matchAll(/\bTool\s*\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const close = findMatching(src, open, true);
    if (close < 0) continue;
    const name = pyKwargString(src, open, close, 'name');
    const desc = pyKwargString(src, open, close, 'description');
    if (!name || !desc) continue;
    const params: ParamInfo[] = [];
    const propsRe = /["']([A-Za-z_]\w*)["']\s*:\s*\{/g;
    propsRe.lastIndex = open;
    for (let pm = propsRe.exec(src); pm && pm.index < close; pm = propsRe.exec(src)) {
      const pname = pm[1] as string;
      if (pname === 'properties' || pname === 'inputSchema') continue;
      const bodyOpen = pm.index + pm[0].length - 1;
      const bodyClose = findMatching(src, bodyOpen, true);
      const body = src.slice(bodyOpen, bodyClose);
      if (/["']properties["']\s*:/.test(body)) continue;
      const dm = /["']description["']\s*:\s*/.exec(body);
      const lit = dm ? readConcatenated(src, bodyOpen + dm.index + dm[0].length, true) : undefined;
      params.push({
        name: pname,
        description: lit?.value,
        line: idx.pos(pm.index).line,
        descLine: lit ? idx.pos(lit.start).line : undefined,
        descMap: lineMap(idx, lit),
      });
    }
    tools.push({
      name: name.value,
      description: desc.value,
      file: file.rel,
      line: idx.pos(name.start).line,
      descLine: idx.pos(desc.start).line,
      descMap: lineMap(idx, desc),
      params,
    });
  }
  return tools;
}
