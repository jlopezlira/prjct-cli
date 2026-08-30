# Execution environments — detection & output adaptation

prjct runs the **same binary** whether you invoke it from a plain shell, from
inside Claude Code, from an OpenAI Codex sandbox, or from CI. It detects where it
is running and adapts its output **automatically, with zero configuration**. You
never set a flag or env var to "tell prjct it's inside Claude" — it figures it
out.

This page documents exactly *how* that detection works and *what* changes in the
output, so an agent (or a human) can predict prjct's behavior in any context.

---

## TL;DR

| You run prjct in… | How it's detected | What the output looks like |
|---|---|---|
| **Claude Code / Claude Desktop** | env var, MCP capability, `CLAUDE.md` in cwd, or `~/.claude/` (see below) | Rich text, colors, **static** one-line status (no animation), prompts suppressed |
| **OpenAI Codex** sandbox | `codex` CLI binary on PATH; `~/.codex/` config dir | Same non-interactive static output as any agent; pass `--md` for fully structured markdown |
| **Plain terminal (TTY)** | default fallback | Branded **animated** spinner, full colors, interactive prompts |
| **CI / pipes / non-TTY** | `process.stdout.isTTY === false` | Static one-line status, no animation, no prompts |
| **Any of the above with `--md`** | explicit flag | Branding stripped, machine-structured markdown |

No configuration is required for any row. The detection is silent and automatic.

## Compatibility is capability-based

prjct's universal layer is not a promise that every agent supports the same
native features. The portable baseline is:

1. `prjct <command> --md` for agent-readable CLI output.
2. MCP `prjct_*` tools when the runtime supports MCP.
3. Global skills/hooks when the runtime supports them.

Runtime-specific surfaces such as Claude hooks, Codex skills, or Kimi hooks are
adapters on top of that baseline. Run:

```bash
prjct agents doctor --md
```

to see the current machine/project matrix. The command reports each runtime's
support for AGENTS.md, MCP, skills, hooks, ACP, and project rules. `full` means
prjct ships and verifies a deep native adapter for that runtime; other runtimes
are reported as `good`, `baseline`, or `hosted` according to their portable
surfaces.

Inside a prjct project, `prjct agents doctor --fix` repairs the user's global
agent wiring (hooks, MCP, skills). prjct never writes `AGENTS.md`, `CLAUDE.md`,
`PRJCT.md`, or IDE rule files into the client repository. For model handoff, use
`prjct handoff <agent> --md`; it produces a takeover prompt that tells the next
agent to run `status`, `value`, `memory-doctor`, and `guardrails` before
editing.

---

## 1. Agent detection (Claude Code / Desktop)

Implemented in `core/infrastructure/agent-detector.ts` (`isClaudeEnvironment()`).
prjct concludes it is running inside Claude if **any** of the following is true,
checked in this order:

1. `process.env.CLAUDE_AGENT` or `process.env.ANTHROPIC_CLAUDE` is set
   (the Claude runtime sets these to mark an agent environment).
2. `global.mcp` is present **or** `process.env.MCP_AVAILABLE` is set
   (Model Context Protocol is available).
3. A `CLAUDE.md` file exists in the current working directory.
4. A `~/.claude/` directory exists in the user's home.
5. The current working directory path contains `/.claude/` or
   `/claude-workspace/`.

If none match, prjct uses the **Terminal/CLI** profile (the default). The result
is cached for the process lifetime, so detection runs once.

The two profiles (`CLAUDE_AGENT` and `TERMINAL_AGENT` in the same file) differ in
declared capabilities — Claude has `mcp: true`, `filesystem: 'mcp'`,
`markdown: true`, command prefix `p.`; Terminal has `mcp: false`,
`filesystem: 'native'`, command prefix `prjct`.

> **No configuration required.** Claude Code makes one of conditions 1–5 true on
> its own (and pipes prjct's stdin/stdout, so `stdin.isTTY` is false). prjct
> adapts with no flag, env var, or config from you.

## 2. OpenAI Codex detection

Implemented in `core/infrastructure/ai-provider.ts` (`detectCodex()` +
`CodexProvider`) and the runtime registry. Provider selection treats Codex as
installed when the **`codex` CLI binary is present on PATH** or
`~/.codex/auth.json` exists. `prjct install` also treats an existing
`~/.codex/` directory as enough evidence to repair Codex config without making
Codex the primary setup provider.

Codex specifics prjct relies on:

- **Skills:** `.agents/skills/` for the project, or `~/.codex/skills/` globally;
  the prjct skill marker is `~/.codex/skills/prjct/SKILL.md`.
- **Config dir:** `~/.codex`; `prjct install`/`setup` ensure the prjct MCP server
  and a Codex TUI `status_line` in `~/.codex/config.toml`, preserving a
  user-managed `status_line`. **Ignore file:** `.codexignore`.

### Output in a Codex sandbox

A Codex sandbox is a non-interactive, non-TTY environment, so prjct produces the
**same machine-friendly output as any agent context**:

- a **single static status line** (`⚡ prjct …`) — never the animated spinner;
- structured, color-capable text (no progress animation, no carriage-return
  redraws);
- interactive prompts are suppressed (nothing waits on stdin);
- add **`--md`** to any command for fully markdown-structured output that drops
  the branding header/footer — ideal for feeding command output straight back to
  the model.

## 3. Kimi Code CLI detection

Implemented in `core/infrastructure/ai-provider.ts` (`detectKimi()`) and the
runtime registry. prjct treats Kimi Code CLI as installed when the **`kimi` CLI
binary is on PATH** or the **`~/.kimi-code/`** config directory exists (the
legacy `~/.kimi/` directory still counts as a fallback signal, but new wiring
never targets it).

Kimi specifics prjct relies on:

- **MCP:** `~/.kimi-code/mcp.json`, standard `mcpServers` JSON (same shape as
  Claude); `prjct install` upserts the `prjct` and `context7` servers there.
- **Hooks:** `[[hooks]]` entries in `~/.kimi-code/config.toml` (only
  `event`/`matcher`/`command`/`timeout` allowed per entry); prjct's entries are
  marked with an adjacent `# prjct-managed` comment. Hooks receive snake_case
  JSON on stdin and read prjct's `PRJCT_HOOK_HOST=kimi` output adaptation:
  plain stdout text is appended to context, denies use the
  `hookSpecificOutput.permissionDecision` JSON contract.
- **Skills:** the compact skill installs to the shared user tier
  `~/.agents/skills/prjct/SKILL.md` (a canonical Kimi scan directory).
- **Output:** same non-interactive static profile as any agent host; `--md`
  works identically.

## 4. Output adaptation — the three tiers

Detection feeds three independent output decisions. None require configuration.

### Tier 1 — TTY vs non-TTY (`core/utils/output.ts`, `spin()`)

`process.stdout.isTTY` decides the spinner:

- **TTY true** (a human terminal): an animated, branded spinner redraws with
  `\r` on an interval.
- **TTY false** (Claude Code, Codex, CI, a pipe): a **single static line** is
  printed once — `⚡ prjct <message>` — with no animation. This keeps agent and
  CI logs clean and diff-able.

### Tier 2 — `--md` / `--json` (`core/index.ts`)

`--md` (and `--json`) switch from the human presentation to machine output:
the branding header/footer is skipped and content is emitted as structured
markdown/JSON. Every command supports `--md`.

### Tier 3 — LLM-context gate (`core/index.ts`)

```
isLlmContext = !process.stdin.isTTY || options.md === true || options.json === true
```

Commands declared `requiresLlm` (the ones whose value is the *model's*
interpretation of their output) refuse to run in a **raw human terminal** unless
`--md`/`--json` is passed — because their output is meant for an agent to read.
Inside Claude/Codex, `stdin.isTTY` is already false, so they run transparently
with no flag. The error, when it fires, tells you exactly what to do:

```
'prjct spec' requires an AI agent to process its output
Use 'p. spec' inside Claude/Cursor, or add --md flag
```

## Why no configuration?

Every signal prjct checks is something the host environment sets on its own:
Claude Code exports its env vars and pipes stdio; Codex puts `codex` on PATH;
a real terminal has a TTY; CI does not. prjct reads those ambient facts instead
of asking you to declare them — so the same command "just works", correctly
formatted, everywhere.

## Source references

| Concern | File |
|---|---|
| Claude detection + profiles | `core/infrastructure/agent-detector.ts` |
| Codex detection + provider config | `core/infrastructure/ai-provider.ts` |
| Spinner TTY adaptation | `core/utils/output.ts` |
| `--md` handling + LLM-context gate | `core/index.ts` |
