# Writing rules

Every check in agent-preflight is a YAML rule. The built-in rules live in [`rules/`](../rules);
you can add your own with `--rules <dir>` (repeatable). Rule packs are plain directories:
every `*.yml` / `*.yaml` file under them is loaded recursively.

```bash
preflight scan ./my-server --rules ./security/preflight-rules
preflight rules --rules ./security/preflight-rules   # list what is loaded
```

## File format

A file can hold a single rule, a top-level list, or a `rules:` key with a list:

```yaml
rules:
  - id: ACME-001
    title: Internal hostname in tool metadata
    severity: high # critical | high | medium | low | info
    layer: metadata # metadata | source | config | drift
    scope: [tool-description, param-description]
    description: >-
      Explains what the rule detects and why it matters. Shown in SARIF and `preflight rules`.
    remediation: What the reader should do about it.
    message: 'Mentions an internal host in {kind} "{name}": "{match}"' # optional
    tags: [exfiltration] # optional, copied into SARIF
    enabled: true # optional; set false to switch a rule off
    match:
      type: regex
      patterns:
        - '\bcorp\.example\.invalid\b'
```

| Field         | Required | Notes                                                                               |
| ------------- | -------- | ----------------------------------------------------------------------------------- |
| `id`          | yes      | Upper-case words joined by `-`, e.g. `ACME-001`. Must be unique within a pack.      |
| `title`       | yes      | One line.                                                                           |
| `severity`    | yes      | `critical`, `high`, `medium`, `low` or `info`. Drives `--fail-on` and SARIF levels. |
| `layer`       | yes      | Grouping only: `metadata`, `source`, `config` or `drift`.                           |
| `scope`       | yes      | Which subjects the rule runs on (see below). Not needed for `drift` rules.          |
| `description` | yes      | Long description.                                                                   |
| `remediation` | yes      | Advice shown under each finding.                                                    |
| `match`       | yes      | One of the match types below.                                                       |
| `message`     | no       | Template with `{match}`, `{name}`, `{kind}` and `{detail}` placeholders.            |

Rules are validated when they are loaded. A bad regex, unknown scope or missing field stops
the run with an error that names the file and rule id.

### Overriding built-in rules

A custom rule with the same `id` as a built-in replaces it. Use that to change a severity, or
to disable a rule with `enabled: false`. `--no-builtin-rules` runs only your packs.

## Scopes (subjects)

Before rules run, every scanned file is turned into _subjects_: pieces of text with a kind,
a location and usually a name. A rule only sees the subjects listed in its `scope`.

| Scope               | What it is                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| `tool-description`  | Decoded description of an MCP tool (TS/JS `server.tool`/`registerTool`, Python `@mcp.tool`, JSON). |
| `param-description` | Decoded description of a tool parameter (zod `.describe()`, `Field(description=)`, JSON schema).   |
| `param-name`        | The parameter name itself. Name is `tool.param`.                                                   |
| `skill`             | A `SKILL.md` file (frontmatter included).                                                          |
| `agent`             | A markdown file under `agents/`.                                                                   |
| `command`           | A markdown file under `commands/`.                                                                 |
| `plugin-manifest`   | Description fields of `plugin.json` / `marketplace.json`.                                          |
| `hook-command`      | The `command` string of a Claude Code hook. Name is `Event[matcher]`.                              |
| `mcp-config`        | Launch line of an MCP server (`command` + `args`, or `url`). Env values are never included.        |
| `package-script`    | An npm script. Name is the script name.                                                            |
| `source`            | Raw text of a JS/TS/Python/shell source file.                                                      |
| `text`              | Raw text of any other text file.                                                                   |

Descriptions are matched against the **decoded** string value, so `'a' + 'b'`, escape
sequences such as `​` and Python implicit concatenation are all resolved first.

## Match types

### `regex`

Fires when any pattern matches. Patterns are JavaScript regular expressions; flags default to
`i` (case-insensitive) and `g` is always added.

```yaml
match:
  type: regex
  patterns: ['\bwebhook\.site\b']
  exclude: ['example\.com'] # skip a hit when its line also matches one of these
  flags: '' # case-sensitive
  target: name # match the subject name instead of its text
```

YAML tip: use single quotes for patterns. Inside them a literal `'` is written `''`.

### `all`

Fires when **every** group has at least one matching pattern in the same subject. The finding
points at the first hit of the last group. Good for combinations such as "reads secrets AND
makes a network call".

```yaml
match:
  type: all
  groups:
    - ['\.ssh/', 'process\.env']
    - ['\bfetch\s*\(', '\brequests\.post\s*\(']
```

### `codepoints`

Fires on any code point inside the listed hex ranges. Findings show the characters as
`<U+XXXX>` so they are visible in terminals and code scanning.

```yaml
match:
  type: codepoints
  ranges: ['200B-200D', 'FEFF']
  allowLeading: ['FEFF'] # ignore a BOM at the very start
```

### `max-length`

Fires when the subject text is longer than `max` characters.

```yaml
match: { type: max-length, max: 1000 }
```

### `cross-tool-reference`

Fires when a description mentions the name of a _different_ tool found in the same scan.
Only names that look like identifiers (containing `_`, `-` or camelCase, at least
`minLength` characters) are considered, to avoid matching ordinary words.

```yaml
match: { type: cross-tool-reference, minLength: 5 }
```

### `drift`

Maps lockfile drift (`scan --locked`) to findings. `change` is `changed`, `added` or
`removed`. Drift rules need no `scope`.

```yaml
match: { type: drift, change: changed }
```

## Suppressing findings

### `.preflightignore`

One entry per line, `#` starts a comment:

```gitignore
# ignore every finding in matching files
test/fixtures/**

# disable a rule everywhere
PF-URL-001

# disable a rule for matching files
PF-SRC-002 src/clients/**
```

The `.preflightignore` in the current directory is always read, plus any file passed with
`--ignore-file`. A `.preflightignore` inside the scanned target is only honoured for local
targets: a package you download from GitHub or npm cannot silence the scanner.

### Inline comments

```ts
const run = new Function('a', 'b', body); // preflight-ignore PF-SRC-004: sandboxed formula engine
```

A `preflight-ignore` comment suppresses the listed rule ids (or every rule, if none are
listed) on its own line and on the line below. Like `.preflightignore` in the target, inline
comments only count for local targets, and `--no-inline-suppressions` turns them off.

## Testing a rule

Add a fixture that should trigger it under `fixtures/malicious/` and make sure the clean
fixtures stay quiet:

```bash
npm run build
node dist/cli.js scan fixtures/malicious/your-fixture --fail-on none
node dist/cli.js scan fixtures/clean        # must print "No findings"
npm test
```

Fixtures must stay inert: no working payloads and no real endpoints. Use hosts under
`.invalid` and documentation IP ranges such as `203.0.113.0/24`.
