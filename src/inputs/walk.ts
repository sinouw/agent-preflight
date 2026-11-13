import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ScannedFile } from '../types.js';

export interface WalkOptions {
  maxFileBytes?: number;
  maxFiles?: number;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', '__pycache__', '.venv', 'venv']);
const BINARY_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.zip',
  '.gz',
  '.tgz',
  '.tar',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.mp3',
  '.mp4',
  '.mov',
  '.wasm',
  '.node',
  '.so',
  '.dylib',
  '.dll',
  '.exe',
  '.bin',
  '.pyc',
  '.jar',
  '.class',
  '.lock',
]);

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * Reads text files under `root` without following symlinks. `prefix` is prepended to
 * relative paths (used when scanning several roots at once).
 */
export function walk(root: string, opts: WalkOptions = {}, prefix = ''): ScannedFile[] {
  const maxBytes = opts.maxFileBytes ?? 2 * 1024 * 1024;
  const maxFiles = opts.maxFiles ?? 20000;
  const out: ScannedFile[] = [];
  const rootStat = lstatSync(root);

  const addFile = (abs: string, rel: string) => {
    if (out.length >= maxFiles) return;
    if (BINARY_EXT.has(path.extname(abs).toLowerCase())) return;
    const st = lstatSync(abs);
    if (!st.isFile() || st.size > maxBytes) return;
    const buf = readFileSync(abs);
    if (isBinary(buf)) return;
    out.push({ abs, rel: (prefix ? `${prefix}/` : '') + rel, content: buf.toString('utf8') });
  };

  if (rootStat.isFile()) {
    addFile(root, path.basename(root));
    return out;
  }
  const visit = (dir: string, rel: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      const abs = path.join(dir, name);
      const childRel = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) visit(abs, childRel);
      } else if (st.isFile()) {
        try {
          addFile(abs, childRel);
        } catch {
          // unreadable file: skip
        }
      }
    }
  };
  visit(root, '');
  return out;
}
