import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import semver from 'semver';
import * as tar from 'tar';

const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const USER_AGENT = 'agent-preflight';

export interface Fetched {
  dir: string;
  label: string;
  cleanup: () => void;
}

async function download(url: string, headers: Record<string, string> = {}): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, ...headers },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText} (${url})`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_DOWNLOAD_BYTES) throw new Error(`download too large: ${len} bytes`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_DOWNLOAD_BYTES) throw new Error(`download too large: ${buf.length} bytes`);
  return buf;
}

/**
 * Extracts a tarball into a fresh temp dir. Only regular files and directories are written:
 * symlinks, hardlinks and device entries are dropped, and node-tar refuses absolute paths
 * and `..` traversal. Nothing from the archive is ever executed.
 */
async function extractTarball(
  buf: Buffer,
  strip: number,
): Promise<{ dir: string; cleanup: () => void }> {
  const base = mkdtempSync(path.join(os.tmpdir(), 'preflight-'));
  const cleanup = () => rmSync(base, { recursive: true, force: true });
  try {
    const archive = path.join(base, 'archive.tgz');
    const dir = path.join(base, 'src');
    mkdirSync(dir);
    writeFileSync(archive, buf);
    let entries = 0;
    await tar.x({
      file: archive,
      cwd: dir,
      strip,
      noChmod: true,
      filter: (_p, entry) => {
        const type = (entry as { type?: string }).type;
        if (type !== 'File' && type !== 'OldFile' && type !== 'Directory') return false;
        return ++entries <= 50000;
      },
    });
    return { dir, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}

// ------------------------------------------------------------------ GitHub

export interface GitHubRef {
  owner: string;
  repo: string;
  ref?: string;
  subpath?: string;
}

export function parseGitHubUrl(input: string): GitHubRef | undefined {
  const m =
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+)(?:\/(.+))?)?\/?$/.exec(
      input.trim(),
    ) ?? /^github:([\w.-]+)\/([\w.-]+?)(?:#(.+))?()$/.exec(input.trim());
  if (!m) return undefined;
  return {
    owner: m[1] as string,
    repo: m[2] as string,
    ref: m[3] || undefined,
    subpath: m[4] || undefined,
  };
}

export async function fetchGitHub(ref: GitHubRef): Promise<Fetched> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const url = `https://api.github.com/repos/${ref.owner}/${ref.repo}/tarball/${ref.ref ? encodeURIComponent(ref.ref) : ''}`;
  const headers: Record<string, string> = { accept: 'application/vnd.github+json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const buf = await download(url, headers);
  const { dir, cleanup } = await extractTarball(buf, 1);
  const scanDir = ref.subpath ? path.join(dir, ref.subpath) : dir;
  if (!path.resolve(scanDir).startsWith(path.resolve(dir))) {
    cleanup();
    throw new Error('invalid subpath');
  }
  return {
    dir: scanDir,
    label: `github:${ref.owner}/${ref.repo}${ref.ref ? `@${ref.ref}` : ''}${ref.subpath ? `/${ref.subpath}` : ''}`,
    cleanup,
  };
}

// ------------------------------------------------------------------ npm

const NPM_NAME_RE = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/;

export function parseNpmSpec(input: string): { name: string; range: string } | undefined {
  const spec = input.startsWith('npm:') ? input.slice(4) : input;
  const at = spec.lastIndexOf('@');
  const name = at > 0 ? spec.slice(0, at) : spec;
  const range = at > 0 ? spec.slice(at + 1) : 'latest';
  if (!NPM_NAME_RE.test(name) || name.length > 214) return undefined;
  return { name, range };
}

interface Packument {
  'dist-tags'?: Record<string, string>;
  versions?: Record<string, { dist?: { tarball?: string; integrity?: string; shasum?: string } }>;
}

export async function fetchNpm(name: string, range: string): Promise<Fetched> {
  const registry = (process.env.npm_config_registry ?? 'https://registry.npmjs.org/').replace(
    /\/?$/,
    '/',
  );
  const metaUrl = registry + name.replace('/', '%2f');
  const meta = JSON.parse(
    (await download(metaUrl, { accept: 'application/json' })).toString('utf8'),
  ) as Packument;
  const versions = Object.keys(meta.versions ?? {});
  const version =
    meta['dist-tags']?.[range] ??
    (versions.includes(range) ? range : (semver.maxSatisfying(versions, range) ?? undefined));
  if (!version) throw new Error(`no version of ${name} matches "${range}"`);
  const dist = meta.versions?.[version]?.dist;
  if (!dist?.tarball) throw new Error(`no tarball for ${name}@${version}`);
  const buf = await download(dist.tarball);
  if (dist.integrity?.startsWith('sha512-')) {
    const got = 'sha512-' + createHash('sha512').update(buf).digest('base64');
    if (got !== dist.integrity) throw new Error(`integrity mismatch for ${name}@${version}`);
  } else if (dist.shasum) {
    const got = createHash('sha1').update(buf).digest('hex');
    if (got !== dist.shasum) throw new Error(`shasum mismatch for ${name}@${version}`);
  }
  // npm tarballs put everything under package/ (strip 1). Install scripts are never run.
  const { dir, cleanup } = await extractTarball(buf, 1);
  return { dir, label: `npm:${name}@${version}`, cleanup };
}
