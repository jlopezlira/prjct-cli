---
description: "The agentic harness for AI coding agents: machine-verified ships, guarded edits, and project lookup that beats re-deriving from source. Run the prjct verb yourself; use `prjct work` normally."
allowed-tools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "Task"]
user-invocable: true
---

# prjct

## Use when

Project memory, work cycles, ships, guardrails, or performance. **You run the verb — the user never types `prjct`.**

### Agent contract

- prjct remembers project state and shows the path; it does not own execution. Agents decide HOW with native tools and judgment. Treat prjct output as durable signals.
- Persist outcomes via `prjct remember` / `work` / `ship` — every memory in **ENGLISH**. Close: `prjct land` (Session close) or living context via `prjct remember context`.
- **Dispatch:** tasks → `prjct work "…"`. Known cmds (`sync`/`search`/`remember`/`ship`/…) run bare with `--md`. **Never** wrap a bin verb as `work "sync"`.
- Before Grep/Glob: `prjct work` / `prjct_relevant_files` / `prjct code trace` when indexes exist.
- **Pattern supremacy:** match THIS repo. **Skill ≠ project identity** (portable L0) — cwd + `prjct context --md` win.
- **Sync analysis:** `analysis-save-llm` = schema v1 JSON; markdown = thin notes only — no retry loop.

### Core verbs (Tier 1=auto · 2=confirm)

| Signal | Verb | T |
|---|---|---|
| work (tasks only) | `prjct work "<intent>"` | 2 |
| intent | `prjct intent` / `audit` | 2 |
| recall | `prjct search` / `prjct context memory` | 1 |
| remember | `prjct remember <type>` | 1 |
| sync | `prjct sync` | 1 |
| hygiene | `prjct dream` / `close` / `forget` | 1 |
| guard | `prjct guard <file>` | 1 |
| ship | `prjct ship` | 2 |
| next | `prjct next --md` | 1 |
| metrics | `prjct insights` / `performance` / `cost` | 1 |
| land | `prjct land` | 1 |
| tdd/sdd | `prjct tdd` / `sdd` | 1 |
| workflows | `prjct workflow` / `seed` | 1 |

`prjct work` is the normal entrypoint **for task cycles only**. Known CLI verbs run bare. Full map in `workflows.md`.

### Routing

- **Tier 1 — auto-execute:** search, remember, sync, guard, insights, performance, cost. One-line confirm; do not ask permission to save.
- **Tier 2 — confirm once:** work, intent, ship. Never ship without user OK.
- **Tier 3 — decision-brief** + cast names, knowledge facets, full map: `workflows.md` (pull on demand).

## Gotchas

- Empty recall ≠ nothing exists. Secrets refused unless `--force`. Worktrees: remove only after PR merged, never --force.
- SQLite is SoT (use CLI/MCP, never read it directly); project config: `.prjct/prjct.config.json`.

