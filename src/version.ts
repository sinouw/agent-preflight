import { readFileSync } from 'node:fs';

const PACKAGE_NAMES = new Set(['@sinouw/agent-preflight', 'agent-preflight']);

function readVersion(): string {
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (pkg.name && PACKAGE_NAMES.has(pkg.name) && pkg.version) return pkg.version;
    } catch {
      // try next
    }
  }
  return '0.0.0';
}

export const VERSION = readVersion();
