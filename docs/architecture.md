# Architecture

## Top-level layout

```
bin/prjct                       Thin JS shim that dispatches to core/index.ts
                                + subprocess entry points (daemon, MCP, bin-only commands)

core/
  index.ts                      Main CLI dispatcher (help, command routing)
  cli/                          Standalone CLI entry points (bin-only commands and lint helpers)
                                spawned as subprocesses from bin/prjct
  commands/                     CLI command handlers (work/intent aliases,
                                sync, ship, remember, search, guard, insights)
  hooks/                        14 hook subcommands dispatched by `prjct hook`
                                (session-start, prompt, pre-bash, pre-commit,
                                pre-secrets, pre-package, pre-edit, pre-search,
                                post-edit, stop, subagent-start, subagent-stop,
                                notification, cwd-changed)
  packs/                        Pack manifests + manager (persona, memory
                                types, workflow slots, hook signals)
  memory/                       projectMemory — unified surface over SQLite
                                (save / list / similar / forget / search)
  workflow-engine/               Engine (state-machine, when-evaluator) — runs
                                bash, mcp:, and persona:context step types
  services/                     sync-service, skill-generator, pattern-extractor
  domain/                       Pure algorithms — no IO, no singletons
                                (bm25, import-graph, git-cochange, file-ranker)
  storage/                      SQLite persistence (one DB file per project)
  infrastructure/               Config, path resolution, install, providers
  schemas/                      Zod schemas — source of truth for runtime + types
  types/                        Plain TypeScript type aliases (no runtime code)
  utils/                        Small reusable helpers
  mcp/                          MCP server — 5 tool groups (memory, project,
                                files, workflow, code-intel)
  daemon/                       Background daemon (file watching, sync)
  server/                       Local HTTP + SSE server (web dashboard API)
  sync/                         Cloud sync (auth, batch, push/pull)
  agentic/                      template-loader only (the v1 orchestration
                                stack was removed in alpha.12)

templates/
  packs/                        Declarative JSON manifests (code / daily / pm
                                / founder / research)
  global/                       Per-editor router templates
                                (Claude CLAUDE.md, Gemini GEMINI.md, etc.)
  skills/                       Anti-harness skill templates (code-review,
                                debug, refactor)

docs/                           This directory
```

## Runtime flow

```
  Terminal
     │
     │  `prjct work "fix login"`
     ▼
  bin/prjct (JS shim)
     │
     │  dynamic import('../core/index')
     ▼
  core/index.ts (CLI dispatcher)
     │
     │  validateCommandParams → registry.ts lookup
     ▼
  core/commands/*            → core/services/*       → core/storage/*
  (handlers register          (business logic,          (SQLite; one DB
   methods with a              pure-ish functions)       per project at
   PrjctCommandsBase                                     ~/.prjct-cli/
   facade)                                               projects/{id}/prjct.db)
```

prjct no longer exposes native Linear/Jira CLI gateway commands. External issue
tracker operations belong to MCP servers configured in the AI client. In v3,
the public model is an AI Agile work cycle (`work` + optional `intent` brief),
not a task-manager card; SQLite may still use task-shaped tables internally for
compatibility and migration stability.

## Retrieval triad

Agent-facing context filtering is powered by three independent signals that
combine in `core/domain/file-ranker.ts`:

```
  Task description               Seed file paths
        │                                │
        ▼                                ▼
┌──────────────┐   ┌────────────────┐   ┌─────────────────┐
│   BM25       │   │ Import graph   │   │  Git co-change  │
│   lexical    │   │ (forward +     │   │  matrix         │
│   index      │   │  reverse)      │   │  (co-edited in  │
│              │   │                │   │   same commit)  │
└──────┬───────┘   └────────┬───────┘   └────────┬────────┘
       │                    │                    │
       │ bm25.ts             │ import-graph.ts    │ git-cochange.ts
       │                    │                    │
       └──────────┬─────────┴──────────┬─────────┘
                  ▼                    ▼
            file-ranker.ts (weighted score → top-N)
```

- **BM25** (`core/domain/bm25.ts`) — lexical scoring over file contents and
  path segments. Tokenizer extracts function names, class names, path parts;
  applies stop-word filter and length penalty.
- **Import graph** (`core/domain/import-graph.ts`) — parses TypeScript/JS
  `import` statements, builds forward and reverse adjacency lists. Used to
  propagate relevance from a seed file to its dependency graph.
- **Git co-change** (`core/domain/git-cochange.ts`) — walks recent git
  commits, records files that change together. Files frequently co-edited
  with a seed get a relevance boost.
- **File ranker** (`core/domain/file-ranker.ts`) — combines the three signals
  with configurable weights and returns the top-N ranked files.

All three indexes are built once per `prjct sync` and stored in the project's
SQLite database. Subsequent `prjct work` and the MCP `prjct_related` /
`prjct_impact` / `prjct_stale` tools read from the cached index.

## Agent surfaces are routers, not memory stores

Always-loaded files such as `AGENTS.md`, `CLAUDE.md`, editor rules, and tiny
agent skills must stay compact. Their job is to route Claude, Codex, Gemini,
Cursor, Windsurf, Antigravity, and future agents into prjct's RAG-backed
project memory; they do not carry project history.

The source of truth is SQLite, and agents read it **through tools, not files**.
When a work cycle needs prior knowledge, the agent pulls bounded, ranked context
with `prjct work`, `prjct search`, `prjct context memory`, `prjct guard`, or the
MCP `prjct_*` tools. There is no generated markdown vault — the Obsidian/wiki
export feature was removed entirely; it was write-only, no code read it back,
and it cannibalized the paid cloud product. prjct is the LLM data plane:
relational SQLite in, structured tool output to the model, sync to cloud; no
local UI, no local export.

Authored memory has a single read source: the normalized `memory_entries`
(+ `memory_entry_tags`, + `memory_entries_fts`) tables. `events` is the
append-only write log + sync wire; a trigger projects every `memory.remember.*`
event into `memory_entries`, so recall/search/guard read typed rows with no
`JSON.parse` on the hot path. (The former `memories` mirror was retired.)

Closeout is also model-authored synthesis, not raw telemetry. Raw quotes,
counters, detector rows, and transcript chunks can inform a memory entry, but
the durable context should explain what happened, why it matters, what changed,
which files/features are involved, model and token metadata when available, the
pattern or anti-pattern, and the next implication.

## Schemas: Zod as source of truth

Runtime validation and TypeScript types must never drift. The convention is:

```ts
// core/schemas/state.ts
export const StateJsonSchema = z.object({ … })
export type StateJson = z.infer<typeof StateJsonSchema>
```

Consumers import either the schema (for `parse` / `safeParse` at boundaries)
or the inferred type (for static checking inside the app). Never re-declare
the shape as a plain `interface`.

Parse at system boundaries only: when reading a file, responding to an HTTP
request, or accepting external input. Internal code operates on already-typed
data.

## Storage: SQLite since v1.24.1

One SQLite file per project: `~/.prjct-cli/projects/{projectId}/prjct.db`.
All reads and writes go through `core/storage/database.ts` and the per-entity
storage modules (`state-storage.ts`, `ideas-storage.ts`, `queue-storage.ts`,
…). Connections are LRU-cached with WAL mode enabled.

The pre-v1.24.1 JSON→SQLite migration subsystem (`migrate-json`) was retired
in v3.12 — every active install migrated years ago. `docs/sqlite-migration.md`
keeps the historical rationale for why prjct moved to SQLite.

**Never** `fs.readFile` a state file directly. Go through the CLI / storage modules.

## Persona-aware context broker (v2)

`.prjct/prjct.config.json` declares the project's persona (`role`, `focus`,
`mcps`, `packs`). The hook pack at `core/hooks/` reads this config and
injects bounded `additionalContext` into the LLM on relevant events:

- `SessionStart` → persona block; cold starts also get a compact knowledge digest
- `UserPromptSubmit` → lean project state + at most one preventive trap cue
- `PreToolUse` (Bash git commit) → anti-patterns tagged with touched files
- `PostToolUse` (Edit/Write) → silently annotates `files_touched`
- `Stop` → async "learned anything reusable?" prompt
- `SubagentStart` → compact role/task/trap digest for fresh-brain subagents
- `CwdChanged` → re-contextualize on project switch

Topical memory, decisions, and learnings are pull-first through
`prjct search`, `prjct context memory`, `prjct guard`, or MCP tools. That keeps
the hot prompt path cache-friendly and bounded without weakening recall when an
agent actually needs prior knowledge.

Packs are declarative JSON manifests (`templates/packs/*.json`). They
register memory types, name workflow slots, and declare hook signals — but
never ship bash pipelines. Scripts are authored on demand by the human or
the agent, using `projectMemory` + MCP as signal sources.

This is the "prjct remembers and shows the path; the agent decides the HOW"
invariant. prjct persists project state, emits signals, and exposes recall
surfaces. Claude, GPT, and other agents use their own native tools and judgment
to execute, then persist outcomes back through prjct. The compatibility target
is semantic events and durable memory, not a prescriptive harness: zero numbered
steps, zero fixed pipelines.

## Testing

- Framework: `bun:test` (native Bun test runner).
- Tests live in `core/__tests__/`, mirroring the source tree.
- Filesystem-touching tests use `os.tmpdir()` fixtures created in `beforeEach`
  and cleaned in `afterEach`.
- Database tests use a real SQLite file in a temp directory. **Do not mock
  the database layer** — mocked tests have historically masked real
  migration and integrity bugs.
- Mock only external HTTP (Linear API, Jira API, prjct cloud API) by
  stubbing `globalThis.fetch` per test.
- Run: `bun test` (or `bun test path/to/file.test.ts` for a single file).

## Lint and dead code

- **Biome** (`biome.json`) enforces style and catches unused imports,
  variables, and void-typed returns at `"error"` level — CI fails if any
  show up.
- **Knip** (`knip.json`) finds unused exports, orphan files, and unused
  dependencies. Run `bun run knip` locally before large cleanups.

## Key code rules

- **No barrel files, no re-exports.** Import directly from the source
  module: `import { X } from './y'`, never `export { X } from './y'`.
- **All data in SQLite.** Never `fs.readFile` a state file directly.
- **Biome errors are blocking.** Do not commit code with lint errors.
- **Schemas are source of truth.** Define with Zod, infer TypeScript types.

## Skill System & Curation Principles
High-leverage skill patterns captured in project memory (`prjct context memory skill-curation`).

**Key patterns integrated**:
- TDD applied to skill creation (baseline test without guidance, write minimal skill, refactor with rationalization tables, red flags and checklists).
- Rich "Use when..." descriptions focused on triggers, keywords for search, strict token budgets.
- Systematic debugging workflow (4-phase process that pairs with existing `tdd` and `review`).

**Changes shipped**:
- Updated core prjct skill (L0) with explicit anti-bloat and curation rules.
- Regenerated templates.
- Added systematic debugging as a curated template skill.

This strengthens our skill system while keeping it lean and memory-first.
