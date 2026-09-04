# Security Policy

## Supported Versions

The latest minor on `main` plus the previous minor receive security fixes. Older releases are not patched — upgrade with `npm install -g prjct-cli@latest` (or your installer of choice).

| Version | Supported |
| ------- | --------- |
| Latest 3.x minor | :white_check_mark: |
| Previous 3.x minor | :white_check_mark: |
| 2.x and older | :x: |

## Security Model

### Local-First Architecture

prjct-cli is designed with privacy and security as core principles:

- **Project data lives locally** in `~/.prjct-cli/projects/{id}/`; the repo contains only a stable `.prjct/prjct.config.json` locator
- **No telemetry or analytics** — we don't track usage
- **Offline by default** — core CLI, hooks, MCP, and SQLite work with no network
- **Optional cloud sync** — only when the user signs in (`prjct login` / cloud link). Tokens never go in plaintext config files; they use the OS credential store (macOS Keychain, libsecret, Windows Credential Manager). Login fails closed if no secure store is available
- **Agent host integration** — context is injected into Claude Code / Gemini / Cursor / etc. via local hooks and MCP; those hosts have their own network paths to model providers

### Threat Model (summary)

| Surface | Control |
| ------- | ------- |
| Credential material in tool args | PreToolUse `pre-secrets` MUST — deny on pattern match (multi-host, no fragile env) |
| Secrets in `remember` / capture | Refuse by default unless `--force` |
| Imported workflow templates | Shell / verify / script rules with `trustSource: imported` are refused |
| Local workflow `script:` paths | Resolved under `.prjct/workflows/` only (`path.relative` + `realpath`, no shell) |
| Subprocess spawn | Prefer `execFile` / `spawn(..., { shell: false })`; no free-form `shell: true` on product paths |
| Daemon IPC | Unix socket mode `0600` (named pipe on Windows) |
| npm package | Minimal runtime deps, `npm audit` in CI, pinned versions + overrides |

**User-authored local workflow rules** may run shell commands the user (or their agent) defined. That is intentional project automation — treat workflow rules like code you review before enabling. Imported/shared rules cannot shell out without local re-creation.

### Data Policy

We store: mutable project settings and SQLite state under `~/.prjct-cli/`, plus a stable project locator in `.prjct/prjct.config.json`. We do **not** store API keys or mutable policy in the project tree. Source code bodies are not bulk-uploaded; analysis keeps paths and derived signals. `prjct remember` and `prjct capture` refuse content that looks like a secret or like a prompt-injection payload unless invoked with `--force`.

When cloud sync is enabled, only entities the user links are exchanged with the prjct cloud API over authenticated channels. Review cloud product docs for retention if you enable it.

### Dependencies

- Minimal runtime dependency set
- `npm audit` runs in CI on every push
- Dependencies pinned; transitive overrides applied when needed
- No known critical vulnerabilities in the published dependency tree at release time

## Reporting a Vulnerability

**DO NOT** open a public GitHub issue for security vulnerabilities.

### Contact

**Email:** jlopezlira@gmail.com

**Subject line:** `[SECURITY] prjct-cli vulnerability report`

### What to Include

1. Description of the vulnerability
2. Steps to reproduce
3. Potential impact assessment
4. Your contact information (for follow-up)

### Response Timeline

| Stage | Timeline |
|-------|----------|
| Initial acknowledgment | 48 hours |
| Vulnerability assessment | 7 days |
| Fix development | Depends on severity |
| Public disclosure | After fix is released |

### What to Expect

- We'll acknowledge receipt within 48 hours
- We'll assess severity and determine fix timeline
- We'll keep you updated on progress
- We'll credit you in release notes (unless you prefer anonymity)

## Security Best Practices for Users

1. **Keep prjct-cli updated** — `npm update -g prjct-cli` (or `prjct upgrade`)
2. **Review before committing** — Check the stable `.prjct/prjct.config.json` locator and workflow rules under `.prjct/workflows/` before pushing to public repos
3. **Avoid storing secrets** — Don't put API keys or passwords in memory captures, specs, or workflow scripts
4. **Use .gitignore** — `.prjct/` local state should stay out of public remotes when it holds machine-local paths (init helps)
5. **Treat local shell workflow rules as code** — only enable rules you trust
6. **Cloud optional** — leave cloud signed out if you want a fully offline install

## Agent Host Integration Security

When using prjct-cli with Claude Code, Gemini CLI, Cursor, Codex, or similar:

- Commands and hooks execute **locally** on your machine
- Hosts only see context prjct injects (hooks / MCP / skill files)
- Model providers receive whatever the host sends under that host's privacy policy
- Review your host vendor's privacy policy for model traffic details
