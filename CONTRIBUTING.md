# Contributing

Thanks for helping make agent tooling safer.

## Setup

```bash
git clone https://github.com/sinouw/agent-preflight
cd agent-preflight
npm ci
npm run build
npm test
```

Node 20 or newer is required.

| Script              | What it does                                     |
| ------------------- | ------------------------------------------------ |
| `npm run build`     | Compile `src/` to `dist/` with `tsc`.            |
| `npm test`          | Run the vitest suite (builds the CLI if needed). |
| `npm run lint`      | ESLint and Prettier check.                       |
| `npm run format`    | Apply Prettier.                                  |
| `npm run typecheck` | Type-check sources and tests.                    |

## Adding or changing a rule

1. Read [docs/writing-rules.md](docs/writing-rules.md).
2. Add the rule to the matching file under `rules/`. Ids are `PF-<AREA>-<NNN>`; never reuse
   or renumber an id that has shipped.
3. Add or extend an inert fixture under `fixtures/malicious/` that triggers it, and add the
   rule to the expectations in `test/fixtures.test.ts`.
4. Check that the clean fixtures and the self-scan stay quiet:
   `node dist/cli.js scan fixtures/clean && node dist/cli.js scan .`
5. Update the rule table in `README.md` and add a line to `CHANGELOG.md`.

Prefer rules that are precise over rules that are broad. A rule that fires on every API
client teaches people to ignore the scanner.

## Fixture safety

Fixtures imitate attacks. They must never work:

- use hosts under `.invalid` (RFC 2606) and documentation IPs (`192.0.2.0/24`,
  `198.51.100.0/24`, `203.0.113.0/24`);
- keep encoded payloads harmless (e.g. base64 of `echo`);
- never add a fixture that would do damage if someone ran it by mistake.

## Hard rule for the codebase

The scanner must never execute, import or install anything from a scanned target. Any change
that touches `src/inputs/` gets extra review for this.

## Pull requests

- Keep PRs focused; one rule or one feature per PR is ideal.
- `npm run lint && npm run typecheck && npm test && npm run build` must pass.
- Describe false-positive risk for new rules in the PR description.

## Releasing (maintainers)

1. Bump `version` in `package.json` (`npm version patch --no-git-tag-version`) and add a
   `## [x.y.z] - date` section to `CHANGELOG.md`.
2. Merge to `main`, then tag and push: `git tag vx.y.z && git push origin vx.y.z`.
3. The [release workflow](.github/workflows/release.yml) checks the tag matches
   `package.json`, runs the full test suite, publishes to npm through trusted publishing (with
   provenance) and creates the GitHub release from the changelog section.
