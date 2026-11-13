# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-13

### Added

- `preflight scan` for local directories, GitHub repositories (tarball download) and npm
  packages (registry tarball, integrity-checked, no install scripts), plus `--installed` for
  read-only discovery of Claude Desktop, Claude Code and Cursor MCP configs, hooks, plugins,
  skills, agents and commands.
- Static extraction of MCP tool names, descriptions and parameters from TypeScript/JavaScript
  (`server.tool`, `registerTool`, low-level `tools` lists), Python (`@mcp.tool`, `Tool(...)`)
  and JSON tool manifests.
- 32 built-in YAML rules across metadata (prompt injection, hidden Unicode, encoded blobs,
  shadowing, suspicious parameters, embedded endpoints), source (credential paths,
  exfiltration, eval/exec, curl-pipe-shell), config (lifecycle scripts, hooks, unpinned or
  plain-HTTP MCP servers) and drift.
- `preflight lock` / `preflight verify` / `scan --locked` to detect rug pulls: changed,
  added and removed definitions with a line diff.
- Custom rule packs (`--rules`), `.preflightignore` and inline `preflight-ignore` comments
  (honoured only for local targets).
- Output as pretty text, JSON or SARIF 2.1.0; `--fail-on` and `--min-severity`.
- Composite GitHub Action with SARIF upload to code scanning.
