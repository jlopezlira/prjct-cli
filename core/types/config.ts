/**
 * Config Types
 * Types for project and global configuration.
 */

/**
 * Persona declaration — Claude's role in THIS project.
 *
 * Hooks inject this as additionalContext so Claude enters every session
 * knowing what hat to wear. The human rotates across contexts (PM in
 * project A, Founder in B, DEV in C); the persona makes that switch
 * explicit without ceremony.
 *
 * Declarative only: lists what MCPs/packs exist, never how to use them.
 */
export interface ProjectPersona {
  /** Claude's role label. Freeform, but common: PM / PO / DEV / TDD / Founder / Research / custom */
  role: string
  /** One-line project focus — e.g. "B2B SaaS onboarding optimization" */
  focus?: string
  /** MCP servers this project expects available. Purely informational signal for Claude. */
  mcps?: string[]
  /** Seed packs active in this project (see templates/packs/*.json) */
  packs?: string[]
}

/**
 * Effective per-project config. Mutable fields are stored in prjct's global
 * project store; `.prjct/prjct.config.json` contains only the stable locator.
 */
export interface LocalConfig {
  projectId: string
  dataPath: string
  /**
   * Whether to show metrics in command output.
   * Defaults to true for new projects.
   * @see PRJ-70
   */
  showMetrics?: boolean
  /**
   * Verification checks to run after sync.
   * Built-in checks always run; custom checks are additive.
   * @see PRJ-106
   */
  verification?: {
    checks?: Array<{
      name: string
      command?: string
      script?: string
      enabled?: boolean
    }>
    failFast?: boolean
  }
  /**
   * Persona declaration for this project. Read by hooks to inject
   * Claude's role + available MCPs into `additionalContext`.
   */
  persona?: ProjectPersona
  /**
   * Anti-over-engineering ("lean") intensity. Unset / `off` keeps the
   * lean guidance and the Stop-hook lean-debt detector dormant — the
   * capability is strictly opt-in so projects that want completeness
   * over minimalism see zero behaviour change. Higher modes bias the
   * skill guidance toward YAGNI/KISS and arm the detector:
   *   - `lite`  — suggest the leaner alternative, never enforce
   *   - `full`  — apply the decision ladder by default
   *   - `ultra` — YAGNI absolutist; challenge non-essential scope
   * The non-negotiables carve-out (security, input validation,
   * data-loss handling, accessibility, edge-case correctness) holds at
   * every mode. Mirrors ponytail's intensity levels.
   */
  lean?: { mode: 'off' | 'lite' | 'full' | 'ultra' }
  /**
   * Test-Driven Development intensity. Unset allows on-demand private TDD
   * guidance for H2/H3 behavior changes, without enabling a ship gate.
   * Explicit `off` disables that guidance; `assist|strict` enables the
   * existing project-level discipline:
   *   - `assist` — the skill biases the implement loop test-first
   *     (red → green → refactor); `ship` surfaces a TDD reminder.
   *   - `strict` — test-first is expected; `ship` surfaces a hard TDD gate
   *     pointing at `prjct tdd check` (which runs the project's test command).
   * The test command is auto-detected per stack (`detectProjectCommands`), so
   * no command config is needed. Enforcement is server-of-truth-free: the gate
   * surfaces, `prjct tdd check` is the real red/green, the agent honours it.
   */
  tdd?: { mode: 'off' | 'assist' | 'strict' }
  /**
   * Spec-Driven Development intensity. Unset / `off` = zero behaviour change
   * (the spec pipeline stays escalate-only). Opt-in, like `lean`/`tdd`:
   *   - `advisory` — the skill nudges toward a spec for complex work; `ship`
   *     surfaces the linked spec's acceptance criteria (≈ today's behaviour).
   *   - `strict` — every `prjct work` cycle must link a REVIEWED spec (enforced in
   *     task-service, so CLI + MCP share it) and `ship` blocks work that has no
   *     linked spec. `prjct ship --no-spec-gate` is the explicit override.
   * The spec pipeline (spec → audit-spec → task --spec → ship) already exists;
   * this only gates it. Mode is surfaced by `prjct sdd`.
   */
  sdd?: { mode: 'off' | 'advisory' | 'strict' }
  /**
   * Hard loop guard — the max turns one work cycle may run before prjct STOPS
   * it (anti-infinite-loop). Unset ⇒ zero behaviour change (only the soft
   * goal-discipline escalation in the per-turn block). When set, exceeding it
   * blocks `ship`/cycle-advance on EVERY rig (CLI gate) and, on hosts whose
   * hook contract supports it, denies further edits — until the human runs
   * `prjct work --extend` to lift it consciously. Opt-in, like `lean`/`tdd`/`sdd`.
   */
  maxTurnsPerCycle?: number
  /**
   * Soft token budget per work cycle. When set, the per-turn state block
   * warns at 80% and calls for a split/check-in at 100% — measurement-backed
   * loop discipline (tokens, not just turns). Advisory: never blocks edits.
   */
  maxTokensPerCycle?: number
  /**
   * Context-density policy (not a session killer).
   * Default: soft cues only — prefer compact tools, never force land/clear.
   * hardBlockShip — opt-in only; when true, critical pressure blocks `prjct ship`
   * unless `--force-pressure`. Most projects should leave this unset/false.
   */
  contextPressure?: {
    hardBlockShip?: boolean
  }
  /**
   * Delivery kill switch (gentle-ai v2.2 steal B1).
   * When `on`, `prjct ship` hard-fails BEFORE task complete / workflow / gate
   * overrides — removes the mutation path without fabricating approval.
   * Lift only by setting killSwitch back to `off` (not via --no-judgment-gate).
   */
  delivery?: {
    killSwitch?: 'off' | 'on'
  }
  /**
   * Delivery-geometry gate at work start when the working tree is already large.
   *   - off — never
   *   - advisory — surface in work output (default for code pack)
   *   - strict — block work start unless `--geometry split|single|direct`
   */
  deliveryGeometry?: { mode: 'off' | 'advisory' | 'strict'; locThreshold?: number }
  /**
   * Session-close land ritual.
   *   - off — never inject
   *   - advisory — SessionStart/Stop cue when a cycle is open (default)
   *   - strict — same cue, stronger wording (code-strict)
   */
  land?: { mode: 'off' | 'advisory' | 'strict' }
  /**
   * Closed-loop judgment + weak-model product mode.
   * conflictMode is dedicated — MUST NOT be inferred from land.mode or sdd.mode.
   * Defaults when unset (pack-gated): off | code→advisory | code-strict→strict
   *   - conflictMode off — gate disabled; classic heads-up only
   *   - conflictMode advisory — warn only
   *   - conflictMode strict — high-confidence deny via PreToolUse deny channel
   *   - weakModelMode on — product mode: intensify conflict (floor strict unless off),
   *     elevate quality ceremony, banner on prime/session — weak-model + prjct ≥ good alone
   */
  judgment?: {
    conflictMode?: 'off' | 'advisory' | 'strict'
    weakModelMode?: 'off' | 'on'
  }
  /**
   * Desktop notifications. **Default ON** (absent / `on`) — prjct pings you
   * when Claude is waiting for input and when a subagent finishes, so a wait
   * never hangs silently. `off` (via `prjct notify off`) silences the OS
   * notifications (the per-prompt work-state block is unaffected). Best-effort:
   * silent if the OS has no notifier. Resolved by `effectiveNotifyMode`.
   */
  notify?: { mode: 'on' | 'off' }

  /**
   * Value-based memory retention (score → active|archive|delete).
   * Unset / `apply` runs archive+delete on sync (capped). `dry-run` only
   * reports. `off` skips the retention phase entirely.
   */
  /**
   * Hard enforcement. Advisory instructions are ignored by models often enough
   * to be worthless as a guarantee, so these are the places prjct BLOCKS a tool
   * call instead of asking. Each defaults ON and can be turned off here.
   */
  enforce?: {
    /**
     * Deny a Grep/Glob whose token prjct already holds recorded judgment about
     * (once per token per session), pointing at `prjct search` instead.
     */
    knowledgeFirst?: boolean
  }
  /**
   * Machine gauntlet. Detection covers the common ecosystems; declaring
   * commands here is the universal escape hatch — ANY language, any runner,
   * including one prjct has never heard of. Declared commands REPLACE
   * detection, so the project owns its own definition of "verified".
   */
  gauntlet?: {
    commands?: Array<{ kind: 'typecheck' | 'lint' | 'test'; command: string }>
  }
  /**
   * QA phase — per-cycle acceptance criteria + flows, verified without any
   * test framework in this repo. Unset mode is pack-gated (code → advisory,
   * code-strict → strict, else off), like `judgment.conflictMode`:
   *   - `advisory` — `work` asks for the plan, `done`/`ship` warn on gaps.
   *   - `strict` — `done`/`ship` block until every flow is machine- or
   *     agent-verified (`--no-qa-gate` is the recorded override).
   * `app` tells prjct how to reach the running app for `http`/`browser`
   * probes (nothing is inferred; the agent registers it once via
   * `prjct qa set app.start|app.baseUrl …`). `commands` are OPTIONAL extra
   * checks a project already owns (an existing e2e suite) — never required.
   */
  qa?: {
    mode?: 'off' | 'advisory' | 'strict'
    app?: {
      start?: string
      baseUrl?: string
      readyPath?: string
      readyTimeoutMs?: number
    }
    commands?: Array<{ kind: 'e2e' | 'integration' | 'smoke'; command: string }>
  }
  retention?: {
    mode?: 'off' | 'dry-run' | 'apply'
    /** Max archive actions per full sync (default 100). */
    maxArchive?: number
    /** Max delete actions per full sync (default 50). */
    maxDelete?: number
    /** Hard-delete soft-deleted rows older than N days on sync (default 7 — no statistical value). */
    softDeletedPurgeDays?: number
    /** Prune archives older than N days on sync (default 7 — repos move fast). */
    archivePruneDays?: number
    /** Max live entries per auto source prefix (default 20). */
    autoSourceMaxLive?: number
  }

  /**
   * Multi-agent coordination (worktree isolation + switch/accept handoff).
   * Unset ⇒ owner stamping always on; isolation defaults to `auto` when a
   * foreign cycle occupies the workspace; switch does not spawn target CLIs
   * unless `switchLaunch` is true or `--launch` is passed.
   */
  multiAgent?: {
    /**
     * When starting work while another agent owns this workspace:
     *   - auto — create a sibling git worktree and start the cycle there
     *   - ask — block with a message telling the agent to isolate or switch
     *   - off — legacy single-workspace gate only
     */
    autoWorktree?: 'auto' | 'ask' | 'off'
    /** When true, `prjct switch` tries to spawn the target CLI with a resume prompt. */
    switchLaunch?: boolean
    /** Pending handoff TTL in hours (default 24). */
    handoffTtlHours?: number
  }

  /**
   * Optional semantic-search layer (phase 3). OFF unless `provider` is set —
   * recall stays pure BM25/keyword by default, zero new dependencies.
   *
   * When enabled, memory entries are embedded and the vectors stored locally
   * in SQLite (`memory_embeddings`); similarity is in-process cosine, so
   * there is NO vector-DB / native dependency. `provider` is an
   * OpenAI-compatible `/embeddings` HTTP endpoint — works with OpenAI,
   * Ollama (`http://localhost:11434/v1`), LM Studio, or any compatible
   * server. The API key (if the endpoint needs one) comes from the
   * `PRJCT_EMBEDDINGS_API_KEY` env var, never from this file.
   */
  embeddings?: {
    provider?: 'openai-compatible'
    /** Base URL of the embeddings endpoint, e.g. https://api.openai.com/v1 */
    baseUrl?: string
    /** Model id, e.g. "text-embedding-3-small" or "nomic-embed-text". */
    model?: string
    /** Expected vector dimensionality (used to invalidate stale vectors). */
    dims?: number
    /** Header carrying the API key. Default `authorization` (Bearer). Set to
     *  `api-key` for Azure OpenAI, or any custom header a gateway expects. */
    authHeader?: string
    /** Scheme/prefix before the key, e.g. `Bearer`. Empty string = raw key. */
    authScheme?: string
    /** Extra static headers sent on every request. */
    headers?: Record<string, string>
    /** Raw query string appended to the URL, e.g. `api-version=2023-05-15`. */
    query?: string
  }

  /**
   * Cloud sync opt-in for THIS project. Absent / `enabled: false` ⇒ the
   * project is local-only and NOTHING leaves the machine — the local-first
   * default. `prjct cloud link` flips `enabled` on; the CLI then pushes the
   * pending queue to the storage API (token in the OS credential store, never here) and
   * pulls remote changes. Safe to commit if a team wants a shared opt-in.
   *
   * Paid enforcement is 100% server-side: the CLI only carries the token and
   * surfaces whatever the API returns (e.g. an upgrade message). There is no
   * paywall logic in this open-source client.
   *
   * `include` is a per-group whitelist (memories, tasks, ideas, shipped,
   * workflows, metrics, archives + the opt-in-only user_prompts /
   * agent_sessions / analysis). Unset groups fall back to the cross-device
   * defaults (sensitive groups off). See `core/sync/entity-map.ts`.
   */
  cloud?: {
    /** Master switch. `false`/absent ⇒ local-only; nothing is pushed/pulled. */
    enabled: boolean
    /** Temporarily stop sync without unlinking (preserves `include`/`linkedAt`). */
    paused?: boolean
    /** ISO timestamp of the first `prjct cloud link`. */
    linkedAt?: string
    /** Per-group sync overrides; merged over the cross-device defaults. */
    include?: Record<string, boolean>
  }
}

/**
 * Global config - stored in ~/.prjct-cli/projects/{id}/project.json
 * Contains all project metadata
 */
export interface GlobalConfig {
  projectId: string
  projectPath?: string
  authors: AuthorEntry[]
  version: string
  created?: string
  lastSync: string
}

/**
 * Author entry in global config
 */
export interface AuthorEntry {
  name: string
  email: string
  github: string
  firstContribution?: string
  lastActivity?: string
}

/**
 * Project config - generic project settings (for registry)
 */
export interface ProjectConfig {
  projectId: string
  name?: string
  createdAt: string
  updatedAt: string
  settings?: ProjectSettings
}

/**
 * Project-specific settings
 */
export interface ProjectSettings {
  autoCommit?: boolean
  commitFooter?: string
  branchNaming?: string
  /** Preferred AI model for this project (e.g., 'opus', 'sonnet', '2.5-pro') */
  preferredModel?: string
}

/**
 * Global settings - user preferences
 */
export interface GlobalSettings {
  defaultAuthor?: string
  theme?: 'light' | 'dark'
  telemetry?: boolean
}
