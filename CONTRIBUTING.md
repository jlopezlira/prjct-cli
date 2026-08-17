# Contributing to prjct-cli

Thank you for your interest in contributing to prjct-cli! This document provides guidelines and information for contributors.

## Code of Conduct

By participating in this project, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## How to Contribute

### Reporting Bugs

1. Check if the bug has already been reported in [Issues](https://github.com/prjct-app/cli/issues)
2. If not, create a new issue with:
   - Clear title describing the bug
   - Steps to reproduce
   - Expected vs actual behavior
   - Environment details (OS, Node version, prjct version)

### Suggesting Features

1. Check existing [Issues](https://github.com/prjct-app/cli/issues) for similar suggestions
2. Create a new issue with the `enhancement` label
3. Describe the use case and proposed solution

### Pull Requests

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Make your changes
4. Run tests: `bun test`
5. Run linting: `bun run check`
6. Commit with conventional commits: `feat: add feature` or `fix: fix bug`
7. Push and create a Pull Request

## Development Setup

```bash
# Clone the repository
git clone https://github.com/prjct-app/cli.git
cd prjct-cli

# Install dependencies
bun install

# Run tests
bun test

# Run linting
bun run check

# Build
bun run build
```

## Project Structure

```
prjct-cli/
├── core/           # Core library code
│   ├── commands/   # CLI command handlers
│   ├── services/   # Business logic services
│   ├── storage/    # SQLite persistence
│   ├── schemas/    # Zod schemas (source of truth)
│   ├── hooks/      # Passive agent hooks
│   └── mcp/        # MCP server
├── templates/      # Packs, skills, global router templates
├── bin/            # CLI entry point
├── docs/           # Architecture & ops docs
└── scripts/        # Build and deploy scripts
```

Deeper walkthrough: [`docs/architecture.md`](docs/architecture.md) · Command reference (generated from the manifest): [`docs/commands.md`](docs/commands.md).

### Developer commands

| Action | Command |
|--------|---------|
| Build | `npm run build` |
| Test | `bun test` |
| Lint / format | `bun run check` |
| Dead code | `bun run knip` |
| Typecheck | `bun run typecheck` |

### Code rules (CI-enforced)

- **Const-only.** No `let` or `var` declarations anywhere in tracked `.ts`/`.js`
  sources — enforced by `scripts/check-no-let.ts` (runs as part of
  `bun run check`). Use `const` with immutable patterns; restructure with
  early returns, ternaries, or derived objects when a value "needs" to change.
- **No barrel files / re-exports.** Import from the source module.
- **Schemas are source of truth.** Zod in `core/schemas/`, types via `z.infer`.
- **All project data in SQLite** via storage modules — not legacy JSON state files.
- Biome: unused imports/variables are errors.

## Dependency overrides (`package.json` → `overrides`)

Every entry pins a **transitive** dependency to a patched version because the
direct dependency that brings it in has not shipped a release with the fix.
JSON can't carry comments, so the rationale lives here — keep this table in
sync when adding or removing an override:

| Override | Why | Ref |
|---|---|---|
| `path-to-regexp: 8.4.0` | DoS via sequential optional groups (via MCP SDK → express → router) | PR #251 |
| `brace-expansion: 5.0.5` | ReDoS in expansion parsing (via glob/minimatch chain) | PR #251 |
| `fast-uri: >=3.1.2` | Host confusion + `%2e%2e` path traversal (via ajv; not exercised — ajv only validates schemas we author) | PR #326 |
| `hono: >=4.12.18` | Batch of HIGH advisories (XSS, cache deception, cookie injection, proto pollution, path traversal) | PR #251, #326 |
| `ip-address: >=10.1.1` | Parsing advisory in the MCP SDK chain (not exercised at runtime) | PR #326 |

Removal condition: when the parent package (usually
`@modelcontextprotocol/sdk`) ships a release that pulls the patched version,
delete the override and verify with `npm audit` / Dependabot.

## Coding Standards

- TypeScript with strict mode
- Biome for linting and formatting
- Conventional commits for commit messages
- Tests for new features and bug fixes

## Commit Message Format

We use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation changes
- `refactor:` - Code refactoring
- `test:` - Test changes
- `chore:` - Build/tooling changes

## License of contributions

By submitting a pull request or other contribution, you agree that your
contribution is licensed under the same **MIT License** as the project
(see [LICENSE](./LICENSE) and [NOTICE](./NOTICE)). You certify that you have
the right to submit the work under that license.

## Questions?

Feel free to open an issue or reach out to the maintainers.
