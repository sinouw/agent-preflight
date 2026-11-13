import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ScannedFile } from '../types.js';
import { readInstalled } from './installed.js';
import { fetchGitHub, fetchNpm, parseGitHubUrl, parseNpmSpec } from './remote.js';
import { walk } from './walk.js';

export interface ResolvedTarget {
  /** Human-readable label, e.g. `./my-server`, `npm:foo@1.2.3`. */
  label: string;
  type: 'local' | 'github' | 'npm' | 'installed';
  /** Root directory for local / downloaded targets (used for .preflightignore lookup). */
  root?: string;
  files: ScannedFile[];
  /**
   * Whether the scanned content is trusted to suppress its own findings. Inline
   * `preflight-ignore` comments are only honoured for local targets: a package you are
   * evaluating could otherwise silence the scanner.
   */
  trusted: boolean;
  notes: string[];
  cleanup: () => void;
}

export type TargetType = 'auto' | 'local' | 'github' | 'npm';

export async function resolveTarget(
  input: string,
  type: TargetType = 'auto',
): Promise<ResolvedTarget> {
  if (type === 'local' || (type === 'auto' && existsSync(input))) {
    const abs = path.resolve(input);
    if (!existsSync(abs)) throw new Error(`path not found: ${input}`);
    const root = statSync(abs).isDirectory() ? abs : path.dirname(abs);
    return {
      label: input,
      type: 'local',
      root,
      files: walk(abs),
      trusted: true,
      notes: [],
      cleanup: () => {},
    };
  }
  const gh = type === 'npm' ? undefined : parseGitHubUrl(input);
  if (gh) {
    const fetched = await fetchGitHub(gh);
    return {
      label: fetched.label,
      type: 'github',
      root: fetched.dir,
      files: walk(fetched.dir),
      trusted: false,
      notes: ['downloaded repository tarball; nothing was executed'],
      cleanup: fetched.cleanup,
    };
  }
  if (type === 'github') throw new Error(`not a GitHub URL: ${input}`);
  const npm = parseNpmSpec(input);
  if (npm) {
    const fetched = await fetchNpm(npm.name, npm.range);
    return {
      label: fetched.label,
      type: 'npm',
      root: fetched.dir,
      files: walk(fetched.dir),
      trusted: false,
      notes: ['downloaded registry tarball; install scripts were NOT run'],
      cleanup: fetched.cleanup,
    };
  }
  throw new Error(`cannot resolve target "${input}": not a path, GitHub URL or npm package name`);
}

export function resolveInstalled(): ResolvedTarget {
  const { files, found } = readInstalled();
  return {
    label: 'installed agent configuration',
    type: 'installed',
    files,
    trusted: false,
    notes: found.length
      ? found.map((f) => `found ${f.label}`)
      : ['no MCP / Claude Code configuration found on this machine'],
    cleanup: () => {},
  };
}
