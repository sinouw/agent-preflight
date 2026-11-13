/** Small lexical helpers for static extraction. Nothing here evaluates code. */

export class LineIndex {
  private starts: number[] = [0];
  constructor(private readonly content: string) {
    for (let i = 0; i < content.length; i++)
      if (content.charCodeAt(i) === 10) this.starts.push(i + 1);
  }
  /** 1-based line and column for a character offset. */
  pos(offset: number): { line: number; column: number } {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.starts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - (this.starts[lo] as number) + 1 };
  }
  lineText(line: number): string {
    const start = this.starts[line - 1];
    if (start === undefined) return '';
    const next = this.starts[line];
    return this.content.slice(start, next === undefined ? undefined : next - 1).replace(/\r$/, '');
  }
}

export interface Literal {
  value: string;
  start: number;
  end: number;
  /**
   * `[valueIndex, sourceIndex]` pairs marking where each source line of the literal starts
   * in the decoded value, so findings inside multi-line or concatenated strings can be
   * mapped back to the right line.
   */
  marks: Array<[number, number]>;
}

function decodeEscape(src: string, i: number, python: boolean): { ch: string; next: number } {
  const c = src[i + 1] ?? '';
  const simple: Record<string, string> = {
    n: '\n',
    t: '\t',
    r: '\r',
    b: '\b',
    f: '\f',
    v: '\v',
    '0': '\0',
    '\\': '\\',
    "'": "'",
    '"': '"',
    '`': '`',
  };
  if (c === 'x') {
    const hex = src.slice(i + 2, i + 4);
    if (/^[0-9a-fA-F]{2}$/.test(hex))
      return { ch: String.fromCodePoint(parseInt(hex, 16)), next: i + 4 };
  }
  if (c === 'u') {
    if (src[i + 2] === '{' && !python) {
      const close = src.indexOf('}', i + 3);
      const hex = src.slice(i + 3, close);
      if (close > 0 && /^[0-9a-fA-F]{1,6}$/.test(hex))
        return { ch: String.fromCodePoint(parseInt(hex, 16)), next: close + 1 };
    }
    const hex = src.slice(i + 2, i + 6);
    if (/^[0-9a-fA-F]{4}$/.test(hex))
      return { ch: String.fromCharCode(parseInt(hex, 16)), next: i + 6 };
  }
  if (c === 'U' && python) {
    const hex = src.slice(i + 2, i + 10);
    if (/^[0-9a-fA-F]{8}$/.test(hex))
      return { ch: String.fromCodePoint(parseInt(hex, 16)), next: i + 10 };
  }
  if (c === '\n') return { ch: '', next: i + 2 };
  if (c in simple) return { ch: simple[c] as string, next: i + 2 };
  return { ch: c, next: i + 2 };
}

/**
 * Reads a JS/TS or Python string literal starting at `start` (which must point at a quote,
 * or at a Python prefix like r/f/b followed by a quote). Template literal interpolations are
 * kept verbatim. Returns undefined if no literal starts there.
 */
export function readLiteral(src: string, start: number, python = false): Literal | undefined {
  let i = start;
  let raw = false;
  if (python) {
    const m = /^[rRbBfFuU]{1,2}(?=['"])/.exec(src.slice(i, i + 3));
    if (m) {
      raw = /r/i.test(m[0]);
      i += m[0].length;
    }
  }
  const q = src[i];
  if (q !== '"' && q !== "'" && !(q === '`' && !python)) return undefined;
  const triple = python && src.startsWith(q.repeat(3), i);
  const close = triple ? q.repeat(3) : q;
  i += close.length;
  let value = '';
  const marks: Array<[number, number]> = [[0, i]];
  while (i < src.length) {
    if (src.startsWith(close, i)) return { value, start, end: i + close.length, marks };
    const ch = src[i] as string;
    if (ch === '\\') {
      if (raw) {
        value += src.slice(i, i + 2);
        i += 2;
        continue;
      }
      const { ch: decoded, next } = decodeEscape(src, i, python);
      value += decoded;
      i = next;
      if (src[i - 1] === '\n') marks.push([value.length, i]);
      continue;
    }
    if (ch === '\n' && !triple && q !== '`') return undefined;
    value += ch;
    i++;
    if (ch === '\n') marks.push([value.length, i]);
  }
  return undefined;
}

export function skipWs(src: string, i: number): number {
  for (;;) {
    while (i < src.length && /\s/.test(src[i] as string)) i++;
    if (src.startsWith('//', i)) {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl + 1;
    } else if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
    } else return i;
  }
}

function skipPyWs(src: string, i: number): number {
  for (;;) {
    while (i < src.length && /\s/.test(src[i] as string)) i++;
    if (src[i] === '#') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl + 1;
    } else return i;
  }
}

/** Reads a literal and any `+`-concatenated (JS) or adjacent (Python) literals following it. */
export function readConcatenated(src: string, start: number, python = false): Literal | undefined {
  const first = readLiteral(src, start, python);
  if (!first) return undefined;
  let { value, end } = first;
  const marks = [...first.marks];
  for (;;) {
    let j = python ? skipPyWs(src, end) : skipWs(src, end);
    if (!python) {
      if (src[j] !== '+') break;
      j = skipWs(src, j + 1);
    }
    const next = readLiteral(src, j, python);
    if (!next) break;
    for (const [v, s] of next.marks) marks.push([value.length + v, s]);
    value += next.value;
    end = next.end;
  }
  return { value, start, end, marks };
}

/**
 * Given the index of an opening bracket, returns the index of its matching closer,
 * skipping over string literals and comments. Returns -1 when unbalanced.
 */
export function findMatching(src: string, open: number, python = false): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  let i = open;
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === '"' || ch === "'" || (ch === '`' && !python)) {
      const lit = readLiteral(src, i, python);
      i = lit ? lit.end : i + 1;
      continue;
    }
    if (!python && src.startsWith('//', i)) {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl;
      continue;
    }
    if (!python && src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (python && ch === '#') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl;
      continue;
    }
    if (ch in pairs) stack.push(pairs[ch] as string);
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return i;
    }
    i++;
  }
  return -1;
}

/** Makes invisible / control characters visible in snippets: U+200B -> <U+200B>. */
export function visualize(s: string): string {
  return s.replace(
    /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u061C\u115F\u1160\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFF9-\uFFFB]|\uDB40[\uDC00-\uDDEF]/g,
    (c) => `<U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}>`,
  );
}
