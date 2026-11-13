import { createHash } from 'node:crypto';
import pc from 'picocolors';
import type { Drift } from '../lock/index.js';
import type { RuleDef } from '../rules/schema.js';
import { SEVERITIES, type Finding, type ScanResult, type Severity } from '../types.js';
import { VERSION } from '../version.js';

const SEV_COLOR: Record<Severity, (s: string) => string> = {
  critical: (s) => pc.bold(pc.bgRed(pc.white(s))),
  high: (s) => pc.bold(pc.red(s)),
  medium: (s) => pc.yellow(s),
  low: (s) => pc.cyan(s),
  info: (s) => pc.dim(s),
};

export function counts(findings: Finding[]): Record<Severity, number> {
  const c = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  for (const f of findings) c[f.severity]++;
  return c;
}

export function formatDrift(drifts: Drift[]): string {
  if (drifts.length === 0) return pc.green('No drift: every definition matches the lockfile.');
  const out: string[] = [pc.bold(`Drift detected in ${drifts.length} definition(s):`), ''];
  for (const d of drifts) {
    const tag =
      d.change === 'changed'
        ? pc.yellow('changed')
        : d.change === 'added'
          ? pc.green('added')
          : pc.red('removed');
    out.push(`  ${tag} ${pc.bold(d.key)}  ${pc.dim(`${d.file}:${d.line}`)}`);
    for (const l of d.diff.slice(0, 40)) {
      const line = `      ${l}`;
      out.push(
        l.startsWith('+') ? pc.green(line) : l.startsWith('-') ? pc.red(line) : pc.dim(line),
      );
    }
    if (d.diff.length > 40) out.push(pc.dim(`      … ${d.diff.length - 40} more line(s)`));
    out.push('');
  }
  return out.join('\n');
}

export function formatPretty(result: ScanResult, notes: string[] = []): string {
  const out: string[] = [];
  out.push(
    `${pc.bold('agent-preflight')} ${pc.dim(`v${VERSION}`)}  ${pc.dim('target:')} ${result.target}`,
  );
  for (const n of notes) out.push(pc.dim(`  · ${n}`));
  out.push(
    pc.dim(
      `  scanned ${result.stats.files} file(s), ${result.stats.definitions} definition(s), ${result.stats.rules} rule(s)`,
    ),
  );
  out.push('');
  if (result.findings.length === 0) {
    out.push(pc.green('✔ No findings.'));
  }
  for (const sev of SEVERITIES) {
    const group = result.findings.filter((f) => f.severity === sev);
    if (group.length === 0) continue;
    out.push(SEV_COLOR[sev](` ${sev.toUpperCase()} `) + pc.dim(` ${group.length} finding(s)`));
    out.push('');
    for (const f of group) {
      out.push(`  ${pc.bold(f.ruleId)} ${f.title}`);
      out.push(
        `    ${pc.underline(`${f.file}:${f.line}:${f.column}`)}${f.subjectName ? pc.dim(`  (${f.subjectKind} ${f.subjectName})`) : ''}`,
      );
      out.push(`    ${f.message}`);
      if (f.snippet) out.push(pc.dim(`    │ ${f.snippet}`));
      out.push(pc.dim(`    ↳ ${f.remediation.split('\n')[0]}`));
      out.push('');
    }
  }
  const c = counts(result.findings);
  const summary = SEVERITIES.filter((s) => c[s] > 0)
    .map((s) => SEV_COLOR[s](`${c[s]} ${s}`))
    .join(pc.dim(', '));
  out.push(
    `${pc.bold('Summary:')} ${result.findings.length} finding(s)${summary ? ` (${summary})` : ''}` +
      (result.stats.suppressed ? pc.dim(`, ${result.stats.suppressed} suppressed`) : ''),
  );
  return out.join('\n') + '\n';
}

export function formatJson(result: ScanResult, extra: Record<string, unknown> = {}): string {
  return (
    JSON.stringify(
      {
        tool: 'agent-preflight',
        version: VERSION,
        target: result.target,
        stats: result.stats,
        summary: counts(result.findings),
        findings: result.findings,
        ...extra,
      },
      null,
      2,
    ) + '\n'
  );
}

// ------------------------------------------------------------------ SARIF 2.1.0

const SARIF_LEVEL: Record<Severity, 'error' | 'warning' | 'note'> = {
  critical: 'error',
  high: 'error',
  medium: 'warning',
  low: 'note',
  info: 'note',
};

/** GitHub code scanning reads `security-severity` (0.0–10.0) to bucket alerts. */
const SECURITY_SEVERITY: Record<Severity, string> = {
  critical: '9.5',
  high: '8.0',
  medium: '5.5',
  low: '3.0',
  info: '1.0',
};

function sarifUri(file: string): string {
  return file
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

export function formatSarif(result: ScanResult, rules: RuleDef[]): string {
  const ruleIndex = new Map(rules.map((r, i) => [r.id, i]));
  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'agent-preflight',
            semanticVersion: VERSION,
            version: VERSION,
            informationUri: 'https://github.com/sinouw/agent-preflight',
            rules: rules.map((r) => ({
              id: r.id,
              name: r.title.replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) =>
                c ? c.toUpperCase() : '',
              ),
              shortDescription: { text: r.title },
              fullDescription: { text: r.description.trim() },
              help: {
                text: r.remediation.trim(),
                markdown: `**Remediation:** ${r.remediation.trim()}`,
              },
              defaultConfiguration: { level: SARIF_LEVEL[r.severity] },
              properties: {
                tags: ['security', r.layer, ...(r.tags ?? [])],
                precision: 'medium',
                'security-severity': SECURITY_SEVERITY[r.severity],
              },
            })),
          },
        },
        originalUriBaseIds: { '%SRCROOT%': { uri: './' } },
        results: result.findings.map((f) => {
          const idx = ruleIndex.get(f.ruleId);
          return {
            ruleId: f.ruleId,
            ...(idx !== undefined ? { ruleIndex: idx } : {}),
            level: SARIF_LEVEL[f.severity],
            message: { text: f.message },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: sarifUri(f.file), uriBaseId: '%SRCROOT%' },
                  region: {
                    startLine: Math.max(1, f.line),
                    startColumn: Math.max(1, f.column),
                    ...(f.snippet ? { snippet: { text: f.snippet } } : {}),
                  },
                },
              },
            ],
            partialFingerprints: {
              primaryLocationLineHash: createHash('sha256')
                .update(`${f.ruleId}:${f.file}:${f.snippet}`)
                .digest('hex')
                .slice(0, 32),
            },
            properties: {
              severity: f.severity,
              subjectKind: f.subjectKind,
              subjectName: f.subjectName,
            },
          };
        }),
      },
    ],
  };
  return JSON.stringify(sarif, null, 2) + '\n';
}
