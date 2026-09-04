# prjct-cli

**The agentic harness for AI coding agents.** Intelligence is rented, the
harness is owned. prjct-cli gives Claude Code, Codex, Gemini, Cursor, OpenCode
— any agent — two things that are measured, not asserted:

- **Machine-verified work, in any language.** `prjct gauntlet` runs your
  project's own verify commands and records a receipt bound to git HEAD;
  `ship` refuses a red one. The work counts when the machine says so, not when
  the agent says so. Commands are detected from the manifest you already have
  (npm/yarn/pnpm/bun · Cargo · Go · Python · Maven · Gradle · Ruby · PHP ·
  .NET · Elixir · Makefile targets) — and for anything else, declare them:

  ```bash
  prjct gauntlet set test "swift test"
  ```
- **Lookup that beats re-deriving.** Bounded, ranked project context (RRF over
  BM25 + semantic, quality measured by `prjct harness retrieval`) instead of an
  agent re-reading the repo to rebuild what it already established.

Everything it claims is auditable from the CLI: `prjct harness audit` reports
memory relevance and fails a threshold, `prjct harness retrieval` reports
Recall@k/MRR/nDCG on a leak-free split.

[![npm](https://img.shields.io/npm/v/prjct-cli)](https://www.npmjs.com/package/prjct-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-Ready-6366f1)]()
[![Gemini CLI](https://img.shields.io/badge/Gemini%20CLI-Ready-4285F4)]()
[![Cursor IDE](https://img.shields.io/badge/Cursor%20IDE-Ready-00D4AA)]()

## Install / upgrade — one paste

Copy this prompt and paste it in Claude Code (works for fresh install AND upgrade — Claude picks YOUR package manager, doesn't force npm):

```text
Install or upgrade prjct-cli on this machine. First detect which package manager I use globally (check `command -v pnpm`, `command -v bun`, `command -v yarn`, `command -v npm` in that order; also check where any existing `prjct` install lives via `command -v prjct` and use the SAME package manager so we don't create parallel installs). Then run the matching install:
- pnpm: `pnpm install -g prjct-cli@latest`
- bun:  `bun install -g prjct-cli@latest`
- yarn: `yarn global add prjct-cli@latest`
- npm:  `npm install -g prjct-cli@latest`

After install, run `prjct install` to verify/repair required native dependencies and hooks, then `prjct setup` to wire providers, then `prjct sync` if the cwd is a git repo. Verify with `prjct -v` and tell me which package manager you used.
```

~30 seconds. Claude detects YOUR package manager (pnpm, bun, yarn, npm) and uses it — critical so we don't end up with parallel installs in different package managers' bin dirs. Re-pasting upgrades to the latest published version.

> **Why detection matters:** if you have `pnpm` globally and Claude runs `npm install -g prjct-cli@latest`, you end up with TWO installs in PATH. The earlier one wins, `prjct -v` reports the wrong version, and aggressive cleanup risks bricking your shell. The detection-first prompt avoids this entirely.

### Prefer no Node/npm? (run in your own terminal)

If you'd rather have the standalone binary (Bun runtime embedded, no Node ecosystem needed), run this **yourself in a terminal** — it's a `curl | bash` install which Claude Code's harness intentionally blocks for safety:

```bash
curl -sSL https://raw.githubusercontent.com/prjct-app/cli/main/scripts/install-standalone.sh | bash
```

The script auto-detects platform (mac arm64/intel + linux x64), downloads the right binary from GitHub Releases, sets up `~/.local/bin/prjct` on your PATH, runs `prjct setup` + `prjct sync`, and warns you if a stale package-manager install is shadowing the new binary.

### Updating prjct-cli (built-in)

prjct-cli updates itself. The canonical command is **`prjct update`**, with
**`prjct upgrade`** as an identical alias:

```bash
prjct update            # = prjct upgrade
prjct update --dry-run  # show exactly what would change, touch nothing
prjct upgrade --yes     # non-interactive (skip the consolidation prompt)
```

What it does, in three phases (`core/commands/update.ts`):

1. **Package update** — auto-detects the package manager that owns your install
   (npm / pnpm / bun / yarn / homebrew), resolves the **true registry-latest**
   version and pins it exactly (so a stale `@latest` cache can't downgrade you),
   and migrates a homebrew install to your detected PM if needed.
2. **Global cleanup & consolidation** — migrates legacy state to SQLite,
   reinstalls editor commands/config, and **consolidates parallel installs** so
   you don't end up with shadowing copies in different PM bin dirs.
3. **Daemon restart** — stops the stale background daemon and respawns it from
   the freshly installed code.

Flags: `--dry-run`, `--yes`/`-y`, `--cleanup` / `--no-cleanup` (default `auto`),
`--md` (machine-readable output for agents/CI).

**Knowing an update exists:** prjct-cli checks at most once every 24h (cached, fully
non-blocking — never delays a command) and, after the command's own output,
prints a one-line banner: `Update available! x.y.z → a.b.c — Run: prjct upgrade`.
Or set it and forget it: `prjct config set auto-update on` (throttled background
check, logs to `~/.prjct-cli/state/auto-update.log`).

Full install + upgrade paths: [INSTALL_PROMPT.md](./INSTALL_PROMPT.md).

### Platform support

The package-manager install path is the portable path for **macOS, Linux, and Windows**:

```bash
npm install -g prjct-cli@latest
# or pnpm / bun / yarn global install
```

The daemon uses Unix sockets on macOS/Linux and a Windows named pipe on Windows.
Git auto-sync hooks keep the shell wrapper POSIX-small and run rate limiting /
background spawn through Node, so they work in Git for Windows without relying on
Unix-only utilities like `md5sum`, `stat -f`, or `date +%s`.

The standalone `curl | bash` installer remains **macOS/Linux only**. Windows
users should use the package-manager install path. CI runs focused platform
compatibility smoke tests on Ubuntu, macOS, and Windows.

### Zero native dependencies

prjct-cli uses SQLite for local project memory through the runtime's **built-in**
driver — `bun:sqlite` on Bun, `node:sqlite` on Node (≥22.5). No native addon, no
`node-gyp`, no postinstall script. It installs cleanly under `--ignore-scripts`
and locked-down CI, which closes the supply-chain surface a native rebuild opens.

## What you get

After install, **next session in any prjct-cli project**:

- **Lookup-first protocol**: Claude queries prjct (`prjct search`, `prjct context memory`, MCP `prjct_*`) BEFORE re-exploring source. Cuts ~10K tokens of exploration per session.
- **Auto-capture**: Stop hook scans the assistant transcript and persists durable insights (decisions/learnings/gotchas) tagged for dedup. The next session finds them via recall.
- **Pattern detection**: Stop hook detects hot files (>3 changes in 7 days), recurring bugs (gotchas with the same topic), tech-debt growth (TODO/FIXME count rising). All persisted as learnings, surfaced next session.
- **6 quality workflows** activated by natural language ("review this branch", "qa the UI", "security check", "investigate this bug"):
  - `review` — Production Bug Hunt + Completeness Gate (3 modes)
  - `qa` — Real Browser, Atomic Fixes, Regression Tests
  - `security` — OWASP Top 10 + STRIDE, 8/10 confidence gate, concrete exploit per finding
  - `investigate` — Iron Law (no fix without investigation), max 3 failed hypotheses
  - `ship` (hardened) — Coverage Gate + Auto-Document
  - `audit` — one-shot orchestrator: review + security + investigate combined
- **Delivery-geometry advisory** (`prjct review-risk`): reads the committed changeset vs the merge-base and suggests a size tier (trivial/normal/large) + whether to ship direct, as one PR, or split — with the touched top-level dirs as natural split lines. Purely advisory: never gates, never mutates git.
- **Session ceremonies**: `prjct prime` restores the full work state at session start; `prjct land` closes it — hand-off persisted to SQLite plus memory consolidation via `prjct dream` when its gates open.
- **Multi-agent work graph**: dependency edges, ready frontier, race-free `prjct claim`, topological `prjct phases` — fan several agents out on one cycle without collisions. `prjct crew` runs the leader / implementers / reviewer flow.
- **Code symbol graph**: `prjct code symbols|trace|impact|architecture|dead` — structural code intel built by `prjct sync` and injected by hooks alongside Grep results.

## How it works

State lives in **SQLite** at `~/.prjct-cli/projects/<id>/`. prjct is the LLM
data plane — agents read it **through tools**, not files: `prjct search`,
`prjct context memory`, `prjct guard`, or the MCP `prjct_*` tools. There is no
generated markdown export to browse or hand-edit.

```
Claude Code session                       prjct-cli
       |                                    |
       | SessionStart hook fires            |
       | --------------------------------> |  self-heal global agent config
       |                                    |  (opt-in: silent auto-update check)
       |                                    |
       | Lookup-first protocol kicks in:    |
       | queries prjct before source        |
       v                                    |
  Writes code, makes decisions              |
       |                                    |
       | Stop hook fires                    |
       | --------------------------------> |  scan transcript → memory,
       |                                    |  detect hot files / recurring bugs
       |                                    |  / tech-debt growth → memory
```

State is the source of truth. New knowledge enters via `prjct remember <type>`, `prjct capture`, or — automatically — the Stop hook's transcript scan.

### Where data actually lives

Not "all in a local `.prjct/` folder" — that's the pre-v1.24.1 model. Three tiers:

| Tier | Location | Commit it? |
|---|---|---|
| Project locator | `<repo>/.prjct/prjct.config.json` (`projectId`, `dataPath` only) | Optional — immutable pointer |
| Project settings | `~/.prjct-cli/projects/<projectId>/config.json` | No — prjct-managed |
| State (source of truth) | `~/.prjct-cli/projects/<projectId>/prjct.db` (SQLite) | No — per-device |

Find a project's data: read `projectId` from `.prjct/prjct.config.json`, then the
DB is `~/.prjct-cli/projects/<projectId>/` (`PRJCT_CLI_HOME` relocates the
global store). Teammates share knowledge via optional cloud sync
(`prjct login` + `prjct sync`), **not** git — git never carries state. Full
detail: **[docs/storage-and-paths.md](./docs/storage-and-paths.md)**.

## Agent compatibility levels

prjct does not pretend every AI coding agent has the same integration surface.
It reports concrete support levels:

| Level | What it means |
|---|---|
| `full` | prjct-maintained native hooks plus MCP/skills or equivalent deep integration. |
| `good` | Global skill/MCP adapter plus `prjct <command> --md`. |
| `baseline` | `prjct <command> --md` only; no native hooks assumed. |
| `hosted` | Hosted platform config may be manual; use `prjct <command> --md`. |

Run `prjct agents doctor --md` to see the current machine/project matrix for
Claude Code, Codex, Gemini CLI, OpenCode, Qwen Code, Kimi Code CLI, Grok Build,
Cursor, Pi, Cline/Roo-family agents, hosted agents, and future MCP clients.

Kimi Code CLI is `full`: native `[[hooks]]` entries in
`~/.kimi-code/config.toml`, MCP servers in `~/.kimi-code/mcp.json`, and the
compact skill at `~/.agents/skills/prjct/SKILL.md` — all installed by
`prjct install` when Kimi is detected (the legacy `~/.kimi/` directory remains
a detection fallback only).

Use `prjct agents doctor --fix` inside a prjct project to repair the user's
global agent wiring (hooks, MCP, skills). prjct never writes `AGENTS.md`,
`CLAUDE.md`, `PRJCT.md`, or IDE rule files into the client repository. The
command is idempotent and reports what changed.

## Harness intelligence

prjct should justify itself with project evidence, not vague claims. These
read-only commands show whether dev+LLM work cycles are getting cheaper,
safer, and more precise:

### Version evals

Use `prjct eval` to measure product readiness between versions and publish the
evidence to the prjct cloud benchmark API:

```bash
prjct eval run --candidate 2.62.0
prjct eval compare --baseline 2.61.0 --candidate 2.62.0 --md
prjct eval run --candidate "$GITHUB_SHA" --publish --target cloud
prjct eval compare --baseline "$BASELINE" --candidate "$CANDIDATE" --publish --target cloud
```

Local artifacts live under `$PRJCT_CLI_HOME/evals/<repo>/`. Cloud publishing
requires `prjct login` and an active `prjct cloud link`, then sends the
benchmark payload to the prjct API with server-side ownership/subscription
checks. See [EVALS.md](./EVALS.md) for the full workflow.

| Command | What it proves |
|---|---|
| `prjct insights value --md` | Durable memory, preventive guardrails, shipped work, sync metrics, and detected agent coverage. |
| `prjct insights quality --md` | Duplicate, stale, low-signal, or untyped memories before they poison recall. |
| `prjct cost [days\|all] --md` | Inference cost totals by provider/model (1–90 days or all history). Rates come from the live OpenRouter catalog — new providers without a CLI ship. |
| `prjct insights cost --md` | AI work cost: token coverage, subscription burn, context reuse, and capture gaps. |
| `prjct insights report 7 --md` | A human/team report from shipped work and carry-forward lessons. |
| `prjct insights continue codex --md` | A continuation brief for the next agent with checks it should run first. |
| `prjct insights guardrails --md` | File-specific warnings for the current changeset from preventive memory. |
| `prjct performance 14 --md` | Time, tokens, model/runtime, prompt synthesis, tools, outcome, and quality signals per work cycle where available. |

## Execution environments (zero-config)

The same binary runs in a plain shell, inside Claude Code, in an OpenAI Codex sandbox, or in CI, and **adapts output automatically with no configuration**. Detection signals (env vars, MCP, `CLAUDE.md`, `~/.claude/`, the `codex` binary on PATH, `process.stdout.isTTY`) are read silently; `--md` / `--json` are the only overrides. Full per-environment table, source-file references, and the detection order: **[docs/environments.md](./docs/environments.md)**.

### What it looks like

In a real terminal — branded, animated, colored:

```text
$ prjct work "add OAuth refresh"
⚡ prjct  ✓ Work cycle started: add OAuth refresh
         branch: work/add-oauth-refresh · status: active
         harness: H2 feature/medium · evidence: focused-tests, scope-check, spec-or-design
```

Inside Claude Code / Codex / CI (non-TTY) — the same line, **static** (no
animation), so logs stay clean. With `--md`, output is plain markdown an agent
can consume directly:

```text
$ prjct work "add OAuth refresh" --md
> Work cycle started: **add OAuth refresh**
> branch `work/add-oauth-refresh` · status `active`
> harness `H2 feature/medium` · evidence `focused-tests, scope-check, spec-or-design`
```

## Quick start (post-install)

```bash
# In any git repo
prjct sync                                  # register the project (auto on first prjct command)
prjct work "add OAuth refresh"              # start a work cycle
prjct remember decision "we chose JWT + refresh rotation"
prjct remember context "implemented refresh rotation; model/tokens unknown; tests passed"
prjct ship                                  # bump version, commit, push, open PR
```

In Claude Code, ask naturally:
- "review my changes" → activates the `review` workflow with Production Bug Hunt methodology
- "what patterns does this project use?" → Claude calls MCP `prjct_analysis` directly (no `grep`)
- "investigate why tests intermittently fail" → activates `investigate` with Iron Law

Optional flags:
```bash
prjct config set auto-update on    # silent self-update (1/hour throttled)
prjct team --required              # record the shared prjct-cli expectation (SQLite; writes no repo files)
```

## Inside Claude Code / Gemini CLI

```bash
p. remember context "call Ana re pricing; no work cycle yet"
p. work "add OAuth refresh"                   # start a work cycle
p. remember decision "we chose JWT + refresh rotation"
p. performance 7                              # inspect dev+LLM efficiency
p. ship                                       # commit, push, open PR
```

Cursor uses its installed prjct hooks/router file; other agents use a native skill/MCP adapter or `prjct <command> --md`.

### Harness verbs

| Verb | What it does |
|---|---|
| `prjct intent "<title>"` | Frame objective, constraints, risks, and success signal before high-stakes work. |
| `prjct work ["<intent>"]` | Start or inspect a work cycle with context and evidence. |
| `prjct remember <type> "<content>"` | Persist a memory entry (decision, learning, gotcha, …). |
| `prjct forget <id>` | Delete a memory entry by id (`prjct forget mem_1234`) — the delete half of `remember`. |
| `prjct search "<query>"` | Search project memory — blended BM25 + semantic + recency recall (`prjct search mem_1234` resolves an entry by id). |
| `prjct guard <file>` | Surface preventive memory before editing a risky file. |
| `prjct performance [days]` | Measure dev+LLM efficiency per work cycle. |
| `prjct cost [days\|all]` | Inference tokens and API-equivalent vs subsidized cost by provider. |
| `prjct insights [value\|quality\|cost\|report\|continue\|guardrails]` | Project intelligence, token cost, and quality proof. |
| `prjct ship [name]` | Run the project's ship workflow (commit, push, PR, persist). |
| `prjct sync` | Re-index files, git co-change, imports; refresh project analysis. |
| `prjct agents doctor` | Show the auditable compatibility matrix for local and project agent runtimes. |
| `prjct review-risk` | Advisory change-size + delivery-geometry signal for the branch (read-only; never gates, never splits). |
| `prjct prime` / `prjct land` | Open / close a session: restore full work state · persist hand-off + trigger memory consolidation. Code packs warn at 80 turns and stop project tools at 100 unless `maxTurnsPerSession` overrides the global project policy. |
| `prjct dream` | Consolidate memory: orient / gather / consolidate / prune. |
| `prjct ready` / `claim` / `depend` / `phases` | Multi-agent work graph: ready frontier, race-free claim, dependency edges, topological phases. |
| `prjct crew` | Multi-subagent crew flow: leader / implementers / reviewer. |
| `prjct code <sub>` | Symbol-graph queries: `symbols`, `trace`, `impact`, `architecture`, `dead`. |
| `prjct tdd` / `sdd` / `lean` | Quality gates: test-first, spec-driven development, anti-over-engineering. |
| `prjct memory export` / `import` | Git-shareable memory bundles for teams without cloud sync. |

Compatibility aliases from v2 still execute for existing scripts: `task`,
`status`, `tag`, `capture`, `spec`, `audit-spec`, `value`, `memory-doctor`,
`report`, `handoff`, `guardrails`, and `analyze`. They are no longer
the product surface.

## Personas & Packs

The global project settings declare the persona. Hooks inject it once per session
through a byte-stable SessionStart block; ordinary prompt turns receive only deltas.

```json
{
  "projectId": "…",
  "persona": {
    "role": "PM",
    "focus": "B2B SaaS onboarding optimization",
    "mcps": ["linear", "posthog", "gmail"],
    "packs": ["pm", "research", "daily"]
  }
}
```

Seven built-in packs (TypeScript manifests in `core/packs/manifests.ts`, not bash pipelines):

| Pack | Persona | Memory types enabled | Workflow slots |
|---|---|---|---|
| `code` | DEV | `fact`, `decision`, `learning`, `gotcha`, `pattern`, `anti-pattern`, `shipped` | `ship`, `review` |
| `code-strict` | DEV | same as `code`, with SDD+TDD strict + delivery-geometry / land / conflict gates | `ship`, `review` |
| `daily` | — | `inbox`, `todo`, `idea` | `morning`, `clarify`, `review` |
| `pm` | PM | `insight`, `question`, `stakeholder`, `decision`, `source` | `spec`, `triage`, `interview` |
| `founder` | Founder | `goal`, `okr`, `person`, `stakeholder`, `decision`, `shipped` | `investor-update`, `1on1`, `strategy` |
| `lean` | — | `over-engineering`, `lean-debt` | `review`, `audit`, `debt` |
| `research` | Research | `source`, `claim`, `question`, `insight` | `lit-review`, `analyze` |

Slots ship **empty** — the human or the agent fills them on demand.

## Hooks Adapter (opt-in) — Claude Code + Kimi Code CLI

`prjct install` writes the Claude Code hooks adapter to `~/.claude/settings.json`, writes the native Kimi Code CLI hooks adapter as `[[hooks]]` entries in `~/.kimi-code/config.toml` (marked with a `# prjct-managed` comment each — TOML forbids extra entry fields, and user entries or other tools' blocks stay byte-identical), and installs native Codex hooks in `~/.codex/hooks.json` plus prjct MCP and TUI status line configuration in `~/.codex/config.toml`. prjct never writes `AGENTS.md`, `CLAUDE.md`, `PRJCT.md`, or IDE rule files into the client repository. Most hook subcommands inject `additionalContext`; the credential, package, source-first, loop, and session-rollover gates can deny supported tool calls. Kimi applies hook config on the next session (or after `/reload`); Codex asks the user to trust newly installed hooks once through `/hooks`. Other agents use the support level shown by `prjct agents doctor`.

| Event | Does | Kimi |
|---|---|---|
| `SessionStart` | Persona; on cold start (startup/clear/compact) also the knowledge digest — top traps + decisions in force, so a freshly-updated model starts grounded | ✓ |
| `UserPromptSubmit` | Active project state (task, branch, inbox) | ✓ |
| `PreToolUse` (any tool) | Credential guard — **denies** the call when tool arguments contain secret material, so credentials never leave the machine | ✓ |
| `PreToolUse` (Bash package installs) | Package legitimacy — flags packages not already in `package.json` before the install runs (strict packs deny) | ✓ |
| `PreToolUse` (Bash git commit) | Anti-patterns tagged with touched files | ✓ |
| `PreToolUse` (Edit/Write) | The file's preventive memory (gotchas/anti-patterns) right before you edit it — pushes what `prjct guard` makes pull | ✓ |
| `PreToolUse` (Grep/Glob) | Injects indexed symbol-graph hits alongside search results (never gates) | ✓ |
| `PostToolUse` (Edit/Write) | Silently annotates `files_touched` on active task | ✓ |
| `Stop` | Async prompt: "learn anything reusable?"; scans the transcript for durable captures | ✓ |
| `SubagentStart` | Persona for fresh-brain subagents (cache-stable, digest-free) | ✓ |
| `SubagentStop` | Desktop notification when a subagent finishes (`config.notify`, default on) | ✓ |
| `Notification` | Desktop notification when the agent is waiting for input or permission | ✓ |
| `CwdChanged` | Re-contextualizes on project switch | — (no Kimi equivalent; every Kimi payload already carries `cwd`) |

Remove with `prjct claude uninstall` (Claude hooks only) or `prjct uninstall` (everything — including the prjct-managed `[[hooks]]` entries in `~/.kimi-code/config.toml` and the prjct/context7 servers in Kimi's `mcp.json`).

## MCP Server

prjct-cli exposes an MCP server with 6 tool groups (every tool is prefixed `prjct_`):

The stdio server negotiates MCP `2026-07-28` while retaining the legacy 2025 handshake for existing hosts. Modern clients skip `initialize`, cache discovery and the static tool catalog privately for 24 hours, and avoid unnecessary list-change subscriptions. The default `core` tier exposes only 10 high-signal tools; set `PRJCT_MCP_TOOLS=standard|all` when a host needs the larger surface.

| Group | Tools |
|---|---|
| **memory** | `mem_save`, `mem_list`, `mem_similar`, `mem_forget`, `guard`, `record_decision` / `record_gotcha` / `record_learning` / `record_fact`, `capture_inbox` |
| **project** | `session_resume`, `task_status`, `task_start`, `task_set_status`, `analysis`, `cost_add`, `developer`, `signals`, `skills`, `context_tiers`, `safe_artifacts` |
| **files** | `relevant_files`, `signatures`, `history` |
| **workflow** | `workflow_rules`, `workflow_list`, `workflow_status` |
| **code-intel** | `impact_analysis`, `search_symbols`, `trace_path`, `architecture`, `cochange`, `dead_code`, `import_graph`, `related_context` |
| **spec** | 9 `spec_*` tools — create, get, list, update, and the rest of the SDD lifecycle |

The broker model: if you already have `linear`, `jira`, `posthog`, `gmail` MCPs wired, prjct-cli **does not duplicate them** — it tells your agent they're available for the current persona and caches your insights locally.

## CLI

```bash
prjct start              First-time setup wizard (AI providers + commands)
prjct init               Initialize project in current directory
prjct install            Install global agent wiring: Claude hooks, MCP, Codex status line
prjct uninstall          Complete system removal
prjct sync               Sync project state, rebuild indexes
prjct watch              Auto-sync on file changes
prjct doctor             Check system health (`--fix` repairs and verifies)
prjct hooks <install|uninstall|status>  Git hooks for auto-sync
prjct context <memory|learnings>  Recall memory
prjct review-risk        Advisory change-size + delivery-geometry hint (read-only)
prjct workflow ["config"]  Configure hooks via natural language
prjct stop / restart     Background daemon control (self-reloads on stale code; manual restart rarely needed)
prjct login / logout / auth   Cloud sync authentication
prjct update             Update CLI system-wide (alias: prjct upgrade)
prjct --version / --help
```

Every command supports `--md` to emit LLM-optimized markdown for agent consumption.

`prjct doctor --fix` runs a diagnose → repair → verify loop. It automatically
applies every known safe repair (project setup, Context7, managed hooks/adapters
and heavy Kimi MCP configuration), then exits non-zero if a required error is
still present. Heavy third-party Kimi MCP entries are preserved and set to
`enabled: false`; prjct itself is pinned to the micro tool tier. Doctor never
deletes an integration or kills an active agent session. Code packs instead
prevent marathons prospectively: the prompt hook emits one rollover warning at
80 turns and project Edit/Bash/Search hooks stop at 100. Run `prjct land --md`,
start a fresh host session without resuming the old one, then run
`prjct prime --md`. Set global project `maxTurnsPerSession` to override the
limit (`0` disables it); normal turns emit no extra bytes.

## Memory

20 built-in types + user-defined lowercase identifiers:

`fact`, `decision`, `learning`, `gotcha`, `pattern`, `anti-pattern`, `shipped`, `identity`, `voice`, `glossary`, `framework`, `context`, `inbox`, `todo`, `idea`, `insight`, `question`, `source`, `person`, `spec` — plus anything you invent (`recipe`, `workout`, `interview`, …). Packs add more on top (e.g. `goal`, `okr` from `founder`).

```bash
prjct remember decision "we chose SQLite because the app is local"
prjct capture "check why webhook retries on 502"
prjct context memory "auth refresh"
```

Memory is FTS5-backed (SQLite) and persona-filtered. Recall blends three signals — BM25 lexical, semantic vectors, and a usefulness ledger that reinforces what the project keeps building on. Capture **dedups** automatically: a verbatim re-capture of the same `(type, content)` is skipped, so detectors firing each session can't bloat the store.

> SQLite is the source of truth. Agents read it through tools (`prjct search`, `prjct context memory`, MCP `prjct_*`) — there is no generated file to hand-edit.

### Semantic recall (embeddings)

On by default for **every** project — no setup, no key, no native dependency. A built-in pure-JS embedder (feature-hashed character n-grams) vectorizes memory into SQLite so recall catches morphological / cross-vocabulary matches BM25 misses (`auth`≈`authentication`).

Want higher quality? Bring your own key once, globally — **just paste the key, the provider is auto-detected from its prefix:**

```bash
prjct embeddings set --key sk-or-v1-...   # → OpenRouter (auto-detected)
prjct embeddings set --key sk-...         # → OpenAI (auto-detected)
prjct embeddings test                     # validate connectivity (full error + hint on failure)
prjct embeddings status                   # show provider, model, base URL + key location
prjct embeddings clear                    # forget the key AND settings (falls back to local)
```

One key applies to every project. **Any OpenAI-compatible `/embeddings` provider works.** For providers without a recognizable key prefix (or a custom/self-hosted endpoint), point `--base-url` at its root:

```bash
# Ollama (local, no key) / LM Studio / Together / Mistral / Voyage / Jina / DeepInfra …
prjct embeddings set --model nomic-embed-text --base-url http://localhost:11434/v1
```

`set` is partial-update friendly — `set --key …` keeps your existing model and base URL; `set --model …` keeps your key. An explicit `--base-url` always overrides auto-detection.

Providers that don't use `Authorization: Bearer` are supported too via auth flags — e.g. **Azure OpenAI** (`api-key` header + `api-version` query):

```bash
prjct embeddings set --key "$AZURE_KEY" \
  --base-url https://RESOURCE.openai.azure.com/openai/deployments/DEPLOYMENT \
  --auth-header api-key --auth-scheme none --query "api-version=2023-05-15"
```

| Flag | Purpose |
| --- | --- |
| `--key <k>` | API key — stored in the Keychain (else a 0600 file), never in config |
| `--base-url <u>` | Provider's OpenAI-compatible root (default `https://api.openai.com/v1`) |
| `--model <m>` | Model id (default `text-embedding-3-small`) |
| `--auth-header <h>` | Header carrying the key (default `authorization`; `api-key` for Azure) |
| `--auth-scheme <s\|none>` | Prefix before the key (default `Bearer`; `none` = raw key) |
| `--headers "k=v,k2=v2"` | Extra static headers (gateways, attribution) |
| `--query <qs>` | Raw query string appended to the URL (e.g. `api-version=2023-05-15`) |

Without a key the built-in local embedder is used. Vector dimensionality is detected from the provider's response (no hardcoded size). Each project re-vectorizes on its next session.

## Code Intelligence

`prjct sync` builds four indexes:

| Index | Purpose |
|---|---|
| BM25 | Full-text search over names, symbols, comments |
| Symbol graph | Structural code symbols + call sites — powers `prjct code symbols/trace/impact/architecture/dead` and the Grep/Glob hook augment |
| Import graph | Forward + reverse dependency edges |
| Git co-change | Files that change together |

A combined ranker fuses the signals (`core/domain/file-ranker.ts`) and powers `prjct context files`, plus the code-intel MCP tools (`prjct_related_context`, `prjct_impact_analysis`, `prjct_search_symbols`, `prjct_trace_path`, …).

## Issue Tracker Integration

Bring your own MCP — prjct-cli doesn't duplicate trackers.

- **Linear**: configure the official Linear MCP in your agent and declare it in `persona.mcps`.
- **Jira**: same — use the official Atlassian MCP.

(The legacy v1 `linear` / `jira` sub-commands were removed in v2; MCP is the only path now.)

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PRJCT_CLI_HOME` | `~/.prjct-cli` | Override global storage |
| `PRJCT_EMBEDDINGS_API_KEY` | — | Embeddings API key (overrides `prjct embeddings set`; prefer the keychain-backed command) |
| `PRJCT_DEBUG` | — | Enable debug logging (`1`, `true`, log level) |
| `PRJCT_NO_DAEMON` | — | Force non-daemon path (debugging) |
| `DEBUG` | — | Fallback debug flag |
| `CI` | — | Skip interactive prompts |

## Architecture

```
prjct-cli/
  bin/prjct.cjs          Portable package-manager launcher
  bin/prjct.ts           Source entry — daemon + hook fast paths, self-heal
  dist/bin/prjct.mjs     Built JS shim (daemon-first)
  core/
    agentic/             Agent template loader
    cli/                 Bin-command helpers
    commands/            Command registry (command-data.ts) + all verb handlers
    config/              Static command-context config
    constants/           Algorithm / timing / token constants
    daemon/              Background daemon (client, dispatch, protocol)
    domain/              BM25, symbol graph, import-graph, git-cochange, file-ranker
    eval/                Retrieval evals + ledger
    events/              Sync event bus
    hooks/               13 hook subcommands (Claude Code adapter)
    infrastructure/      path-manager, ai-provider, command-installer, agent-detector
    mcp/                 MCP server (6 tool groups)
    memory/              Memory model, recall, formatting
    packs/               Pack manifests (TS) + pack-manager
    schemas/             Zod — runtime validation
    services/            sync-service, skill-generator, embeddings, retention
    session/             Git session helpers
    storage/             SQLite (one DB per project) — source of truth
    sync/                Cloud sync client + auth + entity handlers
    tools/               Context tools (signatures, history, relevant files)
    types/               Shared TypeScript types
    utils/               Output, branding, cache helpers
    workflow-engine/     Rule state-machine + when-evaluator
    workflows/           Onboarding wizard
  templates/
    crew/                Native crew roles and checkpoints
    skills/              Required disk-backed skill template
```

## Requirements

- Node.js 22.5+ (ships `node:sqlite`) or Bun 1.0+
- One of: Claude Code, OpenAI Codex, Gemini CLI, Cursor, OpenCode, Cline, Grok Build, Pi, Kimi Code CLI, or Antigravity

## Common questions

**How do I initialize / register a new project?**
In any git repo, run `prjct sync` (it auto-runs on the first `prjct` command) or
`prjct init`. This creates a stable project locator and builds the settings +
SQLite store at `~/.prjct-cli/projects/<projectId>/`.

**How do I start a work cycle?**
Run `prjct work "<intent>"` from the repo. It registers the work cycle in
SQLite, pulls relevant second-brain context, auto-classifies a lightweight
harness (H0-H3) with expected evidence, and marks it active — worked example:

```bash
$ prjct work "add OAuth refresh"
⚡ prjct  ✓ Work started: add OAuth refresh
         branch: work/add-oauth-refresh · status: active
         harness: H2 feature/medium · evidence: focused-tests, scope-check, spec-or-design

$ prjct remember context "OAuth refresh depends on the existing token rotation helper."
$ prjct performance --md                  # duration/tokens/model/runtime when available
$ prjct ship                              # bump version, commit, PR
```

Inside an agent you can say it: `p. work "add OAuth refresh"` in Claude Code,
or run `prjct work "..." --md` from any wired agent. `prjct work` with no
argument prints the currently active work cycle. The old `task/status/tag/spec`
verbs still execute for existing scripts, but they are compatibility aliases,
not the v3 product model.

**How do I get AI assistance for a coding problem?**
Inside Claude Code (or any wired agent) describe the problem in natural
language — prjct-cli maps the intent to a quality workflow and runs its methodology,
persisting findings to memory. Concrete examples:

| You say… | Workflow activated | What it does |
|---|---|---|
| "review my changes" | `review` | Production Bug Hunt + Completeness Gate over the diff |
| "investigate why tests flake" | `investigate` | Iron Law — no fix without a root cause first |
| "is this safe to ship?" | `security` | OWASP Top 10 + STRIDE, concrete exploit per finding |
| "qa the checkout page" | `qa` | Real browser, atomic fixes, regression tests |

You can also pull project knowledge directly: ask "what patterns does this
project use?" and the agent runs `prjct search`, `prjct context memory`, or
`prjct guard` before reading source — bounded, ranked SQLite retrieval, so
agents do not flood their context. Outside an agent, every command takes
`--md` to emit agent-ready markdown.

**What does prjct-cli output look like in a normal terminal?**
A branded, **animated** spinner with full colors and interactive prompts (the
native human experience). See [What it looks like](#what-it-looks-like).

**How do I check for and apply updates?**
`prjct update` (alias `prjct upgrade`) — auto-detects your package manager, pins
the true registry-latest, consolidates parallel installs, restarts the daemon.
A non-blocking 24h-cached banner tells you when one is available. See
[Updating prjct-cli](#updating-prjct-cli-built-in).

**How does prjct-cli tailor its output for Claude Code specifically?**
Once it detects Claude (env vars / MCP / `CLAUDE.md` / `~/.claude/`) and sees
piped stdio (non-TTY), it adapts on every axis, with no flag:

- **Status line** — a single **static** `⚡ prjct …` line instead of the
  animated, carriage-return-redrawn spinner, so the transcript stays clean.
- **Prompts** — interactive confirmations are suppressed (nothing blocks on
  stdin that the agent can't answer).
- **`requiresLlm` commands** — run transparently (piped stdin means
  `isLlmContext` is already true; in a raw human terminal they'd refuse without
  `--md`).
- **`--md`** — when passed, the branding header/footer is stripped and output is
  structured markdown the model consumes directly.
- **Context injection** — the installed hooks feed Claude persona + active task
  + topical memory at `SessionStart`/`UserPromptSubmit`, and the lookup-first
  protocol points it at `prjct search`/MCP tools before it re-reads source.

Full per-environment table: [docs/environments.md](./docs/environments.md).

**What's the output in an OpenAI Codex sandbox?**
Codex is detected by the `codex` CLI on PATH. The sandbox is
non-interactive/non-TTY, so prjct-cli emits the same static, prompt-free status
line as any agent; add `--md` for fully markdown-structured output.

**What does Codex get from prjct?**
Four global surfaces, all installed/healed automatically: a compact skill at
`~/.codex/skills/prjct/SKILL.md` (kept under Codex's ~1KB skill cap), the
prjct MCP server wired into `~/.codex/config.toml` (`prjct_*` tools), and a
Codex TUI `status_line` in that same config unless the user already set one,
plus native lifecycle/tool hooks in `~/.codex/hooks.json`. The hooks require a
one-time trust decision through Codex `/hooks`. prjct never writes an
`AGENTS.md` into the project.

**How do I quickly find the local `.prjct/` directory?**
It's in your **project repo root** (created by `prjct init` / first `prjct`
command) and is `.gitignore`d — that's why `git status` never shows it. Find it:

```bash
ls -la .prjct/                                    # from the repo root
cat .prjct/prjct.config.json                      # stable project locator only
ls -la "$(git rev-parse --show-toplevel)/.prjct/" # from any subdirectory
git check-ignore -v .prjct                         # why git ignores it
```

The locator path is `<repoRoot>/.prjct/`. Read `projectId` from it to reach the
global settings at `~/.prjct-cli/projects/<projectId>/config.json` and state at
`~/.prjct-cli/projects/<projectId>/prjct.db` (`PRJCT_CLI_HOME` overrides the
global base). Mutable settings never live in the repo — full detail in
[docs/storage-and-paths.md](./docs/storage-and-paths.md).

**How does prjct-cli detect its environment with no configuration?**
Every signal is something the host sets itself — Claude exports env vars and
pipes stdio, Codex puts `codex` on PATH, a real terminal has a TTY, CI doesn't.
prjct-cli reads those ambient facts (precedence in
[docs/environments.md](./docs/environments.md)) rather than asking you to declare
anything.

**Is all project data really in a local `.prjct/` directory? Team/VCS implications?**
No — only `.prjct/prjct.config.json` (a stable locator) may be in the repo.
Mutable settings and state live under `~/.prjct-cli` and are never committed.
Teams coordinate via optional cloud sync, not git. Full
tradeoffs: [docs/storage-and-paths.md](./docs/storage-and-paths.md).

## Links

- [Website](https://prjct.app)
- [GitHub](https://github.com/prjct-app/cli)
- [npm](https://www.npmjs.com/package/prjct-cli)
- [Changelog](CHANGELOG.md)
- [Architecture](./docs/architecture.md) · [Execution environments](./docs/environments.md) · [Storage & paths](./docs/storage-and-paths.md) · [SQLite migration](./docs/sqlite-migration.md)

## License

[MIT](./LICENSE) © 2024–2026 Juan José López Lira and [prjct.app](https://prjct.app) contributors.

See [NOTICE](./NOTICE) for third-party attribution notes. Contributions are
accepted under the same MIT License (see [CONTRIBUTING.md](./CONTRIBUTING.md)).
