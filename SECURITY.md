# Security policy

## Reporting a vulnerability

Please report vulnerabilities in agent-preflight privately through
[GitHub security advisories](https://github.com/sinouw/agent-preflight/security/advisories/new).
Do not open a public issue.

Include the version, the command you ran and a minimal, inert reproduction. You should get a
first reply within 5 working days.

Examples of what counts as a vulnerability here:

- the scanner executes, imports or installs anything from a scanned target;
- a scanned target can write outside the temporary directory (path traversal, symlinks,
  hard links in tarballs);
- a scanned target can suppress or hide its own findings (inline comments, a shipped
  `.preflightignore`, crafted output that breaks SARIF or terminal rendering);
- secrets from the scanned machine (env values, config contents) end up in reports or
  lockfiles.

Detection gaps (a malicious pattern that is not caught) are welcome too, but they are not
vulnerabilities: please open a "False positive / false negative" issue with an inert sample.

## Design guarantees

- **Static only.** Targets are read as text. Nothing from a target is executed, imported,
  built or installed. npm packages are fetched as registry tarballs and their integrity hash
  is checked; lifecycle scripts never run.
- **Untrusted remote content.** For GitHub and npm targets and for `--installed`, inline
  `preflight-ignore` comments and the target's own `.preflightignore` are ignored.
- **Safe extraction.** Tarballs are extracted into a fresh temporary directory, only regular
  files and directories are kept (no symlinks or hard links), entry count and download size
  are capped, and the directory is removed afterwards.
- **Read-only discovery.** `--installed` only reads known config locations. From
  `~/.claude.json` only the `mcpServers` maps are read. MCP server `env` values are never
  stored in reports or lockfiles; only their key names are.

## Supported versions

Only the latest release receives fixes while the project is pre-1.0.
