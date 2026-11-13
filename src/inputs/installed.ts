import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ScannedFile } from '../types.js';
import { walk } from './walk.js';

/** A config location `--installed` looks at. */
export interface InstalledLocation {
  label: string;
  path: string;
  kind: 'file' | 'dir';
}

/**
 * Lists the MCP / Claude Code configuration locations on this machine. Discovery is
 * read-only: files are read, never written or executed.
 */
export function installedLocations(home = os.homedir(), cwd = process.cwd()): InstalledLocation[] {
  const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
  const desktopConfig =
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : process.platform === 'win32'
        ? path.join(appData, 'Claude', 'claude_desktop_config.json')
        : path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
  // preflight-ignore PF-SRC-001: --installed reads these agent configs by design (read-only)
  const claude = path.join(home, '.claude');
  const list: InstalledLocation[] = [
    { label: 'claude-desktop/claude_desktop_config.json', path: desktopConfig, kind: 'file' },
    { label: 'user/.claude.json', path: path.join(home, '.claude.json'), kind: 'file' },
    { label: 'user/.mcp.json', path: path.join(home, '.mcp.json'), kind: 'file' },
    { label: 'user/settings.json', path: path.join(claude, 'settings.json'), kind: 'file' },
    {
      label: 'user/settings.local.json',
      path: path.join(claude, 'settings.local.json'),
      kind: 'file',
    },
    { label: 'user/plugins', path: path.join(claude, 'plugins'), kind: 'dir' },
    { label: 'user/skills', path: path.join(claude, 'skills'), kind: 'dir' },
    { label: 'user/agents', path: path.join(claude, 'agents'), kind: 'dir' },
    { label: 'user/commands', path: path.join(claude, 'commands'), kind: 'dir' },
    { label: 'user/cursor-mcp.json', path: path.join(home, '.cursor', 'mcp.json'), kind: 'file' },
    { label: 'project/.mcp.json', path: path.join(cwd, '.mcp.json'), kind: 'file' },
    {
      label: 'project/settings.json',
      path: path.join(cwd, '.claude', 'settings.json'),
      kind: 'file',
    },
    {
      label: 'project/settings.local.json',
      path: path.join(cwd, '.claude', 'settings.local.json'),
      kind: 'file',
    },
    { label: 'project/skills', path: path.join(cwd, '.claude', 'skills'), kind: 'dir' },
    { label: 'project/agents', path: path.join(cwd, '.claude', 'agents'), kind: 'dir' },
    { label: 'project/commands', path: path.join(cwd, '.claude', 'commands'), kind: 'dir' },
  ];
  // De-duplicate when cwd is the home directory.
  const seen = new Set<string>();
  return list.filter((l) => !seen.has(l.path) && seen.add(l.path));
}

/**
 * ~/.claude.json holds much more than MCP config (history, settings). Only the MCP server
 * maps are kept, rewritten into a synthetic JSON document so nothing else is scanned or shown.
 */
function claudeJsonSubset(abs: string, label: string): ScannedFile | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(abs, 'utf8'));
  } catch {
    return undefined;
  }
  if (!doc || typeof doc !== 'object') return undefined;
  const d = doc as { mcpServers?: unknown; projects?: Record<string, { mcpServers?: unknown }> };
  const servers: Record<string, unknown> = {};
  if (d.mcpServers && typeof d.mcpServers === 'object') Object.assign(servers, d.mcpServers);
  for (const [proj, cfg] of Object.entries(d.projects ?? {})) {
    if (cfg?.mcpServers && typeof cfg.mcpServers === 'object') {
      for (const [name, s] of Object.entries(cfg.mcpServers as Record<string, unknown>))
        servers[`${path.basename(proj)}/${name}`] = s;
    }
  }
  return {
    abs,
    rel: label,
    content: JSON.stringify({ mcpServers: servers }, null, 2) + '\n',
  };
}

export function readInstalled(locations = installedLocations()): {
  files: ScannedFile[];
  found: InstalledLocation[];
} {
  const files: ScannedFile[] = [];
  const found: InstalledLocation[] = [];
  for (const loc of locations) {
    if (!existsSync(loc.path)) continue;
    found.push(loc);
    if (loc.label === 'user/.claude.json') {
      const f = claudeJsonSubset(loc.path, loc.label);
      if (f) files.push(f);
      continue;
    }
    if (loc.kind === 'file') {
      for (const f of walk(loc.path)) files.push({ ...f, rel: loc.label });
    } else {
      files.push(...walk(loc.path, {}, loc.label));
    }
  }
  return { files, found };
}
