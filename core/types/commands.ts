/**
 * Command Types
 * Types for the command system.
 */

// Core Command Types

/**
 * Structured clarification surfaced when a command can't proceed
 * autonomously — the agent is expected to ask the user and re-invoke
 * with `--intent=<option>`.
 */
export interface CommandClarification {
  question: string
  options: string[]
  state?: Record<string, unknown>
}

/**
 * Command execution result with optional extra data.
 * This is the EXTENDED version with command-specific fields.
 */
export interface CommandResult {
  success: boolean
  message?: string
  error?: string
  /** Duration of command execution */
  duration?: string
  /** Task that was affected */
  task?: string
  /** Feature that was affected */
  feature?: string
  /** Files that were modified */
  filesModified?: string[]
  /** Command declined to proceed; agent should ask the user. */
  clarification?: CommandClarification
  /** Allow any additional properties for command-specific data */
  [key: string]: unknown
}

/**
 * Command usage - which interfaces support this command
 */
export interface CommandUsage {
  human: string
  claude: string
}

/**
 * Command metadata for requirements and categorization
 */
export interface CommandMetadata {
  requiresProject: boolean
  requiresActiveTask: boolean
  modifiesState: boolean
  category: string
}

/**
 * Feature status for a command
 */
export interface CommandFeature {
  name: string
  status: 'implemented' | 'planned' | 'deprecated'
}

/**
 * Command definition
 */
export interface Command {
  name: string
  description: string
  category: string
  usage: CommandUsage
  metadata: CommandMetadata
  features: CommandFeature[]
  implemented: boolean
}

/**
 * Command registry interface
 */
export interface CommandRegistry {
  getByName(name: string): Command | undefined
  getByCategory(category: string): Command[]
  getAll(): Command[]
  getStats(): CommandStats
}

/**
 * Command statistics
 */
export interface CommandStats {
  total: number
  implemented: number
  planned: number
  byCategory: Record<string, number>
}

// Command Options Types

/**
 * Author information
 */
export interface Author {
  name?: string
  email?: string
  github?: string
}

/**
 * Options for the design command.
 */
export interface DesignOptions {
  /** Type of design */
  type?: 'architecture' | 'api' | 'component' | 'database' | 'flow'
  /** Output format */
  format?: 'markdown' | 'mermaid'
}

/**
 * Options for the cleanup command.
 */
export interface CleanupOptions {
  /** Clean up memory/history */
  memory?: boolean
  /** Type of cleanup */
  type?: 'all' | 'memory' | 'sessions' | 'cache'
  /** Dry run without making changes */
  dryRun?: boolean
}

/**
 * Options for the setup command.
 */
export interface SetupOptions {
  /** Force re-setup even if already configured */
  force?: boolean
  /** Skip interactive prompts */
  nonInteractive?: boolean
}

/**
 * Options for the uninstall command.
 */
export interface UninstallOptions {
  /** Skip confirmation prompt */
  force?: boolean
  /** Create backup before deletion */
  backup?: boolean
  /** Show what would be deleted without actually deleting */
  dryRun?: boolean
  /** Keep the npm/homebrew package, only remove data */
  keepPackage?: boolean
}

/**
 * Options for the analyze command.
 */
export interface AnalyzeOptions {
  /** Force re-analysis even if cached */
  force?: boolean
  /** Analysis depth */
  depth?: 'quick' | 'normal' | 'deep'
  /** Allow additional options */
  [key: string]: unknown
}

/**
 * Options for the init (planning) command.
 */
export interface InitOptions {
  /** Skip interactive wizard, use defaults */
  yes?: boolean
  /** Initial idea for architect mode */
  idea?: string | null
  /** Comma-separated pack names to activate (e.g. "code,daily"). */
  pack?: string
  /** Persona role label to declare (e.g. "PM", "Founder"). */
  persona?: string
}

// Migration Types

/**
 * Result from project migration.
 */
export interface MigrationResult {
  success: boolean
  projectId: string | null
  filesCopied?: number
  layerCounts: LayerCounts
  config: MigrationConfig | null
  author: Author | null
  issues: string[]
  dryRun: boolean
}

/**
 * Layer counts for migration
 */
export interface LayerCounts {
  core: number
  progress: number
  planning: number
  analysis: number
  memory: number
  other: number
}

/**
 * Migration configuration
 */
export interface MigrationConfig {
  projectId: string
  version: string
  migratedAt: string
}

// Analysis Types

/**
 * Complexity analysis result
 */
export interface ComplexityResult {
  level: 'low' | 'medium' | 'high'
  hours: number
  type: string
}

/**
 * Health check result
 */
export interface HealthResult {
  score: number
  message: string
}

// Command Function Types

/**
 * Type-safe command method names (for dynamic invocation).
 * Mirrors the v2 registered verbs — see core/commands/verb-names.ts.
 */
export type CommandMethodName =
  | 'now' // backing method for `prjct work`
  | 'workflow'
  | 'init'
  | 'ship'
  | 'analyze'
  | 'sync'
  | 'context'
  | 'status'
  | 'tag'
  | 'remember'
  | 'seed'
  | 'install'
  | 'capture'
  | 'auth'
  | 'login'
  | 'logout'
  | 'start'
  | 'setup'
  | 'update'
  | 'uninstall'

/**
 * Function signature for standard command methods
 */
export type StandardCommandFn = (
  param: string | null,
  projectPath?: string
) => Promise<CommandResult>

// Registry Types

/**
 * Execution context passed to all command handlers
 */
export interface ExecutionContext {
  projectId: string
  projectPath: string
  globalPath: string
  timestamp: string
}

/**
 * Command handler interface - all commands implement this
 */
export interface CommandHandler<TParams = void, TResult = CommandResult> {
  /** Command name for registration */
  readonly name: string
  /** Execute the command */
  execute(params: TParams, context: ExecutionContext): Promise<TResult>
}

/**
 * Handler function type for simple commands
 */
export type HandlerFn<TParams = void> = (
  params: TParams,
  context: ExecutionContext
) => Promise<CommandResult>

/**
 * Registry command usage - which interfaces support this command
 */
export interface RegistryCommandUsage {
  claude: string | null
  terminal: string | null
}

/**
 * Blocking rules for commands
 */
export interface BlockingRules {
  check: string
  message: string
}

/**
 * Command metadata for introspection (registry version)
 */
/**
 * Single source of truth for verb → handler dispatch.
 * `register.ts` walks this to call `commandRegistry.registerLazyMethod`,
 * and `verb-names.ts` derives the fast-path verb set from it. Both
 * used to maintain hand-written copies — adding a new command meant
 * three coordinated edits across files (the "triple-touch" smell).
 */
export type CommandRoutingGroup =
  | 'workflow'
  | 'planning'
  | 'shipping'
  | 'memoryExport'
  | 'workflowsReference'
  | 'changelog'
  | 'workGraph'
  | 'ceremonies'
  | 'analysis'
  | 'setup'
  | 'context'
  | 'primitives'
  | 'seed'
  | 'install'
  | 'capture'
  | 'mcp'
  | 'team'
  | 'config'
  | 'uninstall'
  | 'update'
  | 'spec'
  | 'embeddings'
  | 'llm'
  | 'agent'
  | 'guard'
  | 'lean'
  | 'cloud'
  | 'tdd'
  | 'sdd'
  | 'notify'
  | 'agents'
  | 'product'
  | 'eval'
  | 'judgment'
  | 'code'

export interface CommandRouting {
  /** Which command-group instance owns the handler. */
  group: CommandRoutingGroup
  /** Method name on the group instance. */
  method: string
}

/**
 * Where a command executes — the single fact that four hand-maintained
 * lists used to encode independently (`_binCommands` in bin/prjct.ts, the
 * shim skip-set in scripts/build.js, `standardCommands` in core/index.ts,
 * and the dispatch.ts switch). All four now DERIVE from this field.
 *
 *  - 'bin-only': handled directly in bin/prjct.ts; never forwarded to the
 *    daemon (TTY needs, daemon lifecycle, or process-level concerns).
 *  - 'daemon': forwarded to the daemon when its socket exists; falls
 *    through to cold in-process execution otherwise. The default for any
 *    entry with `routing` set.
 *  - 'cold-only': the SHIM must not forward it (multi-positional parsing
 *    the wire protocol can't reconstruct — spec/audit-spec), but the full
 *    bin/prjct.ts can. Used to live as a side list in scripts/build.js.
 */
export type CommandRoutingMode = 'bin-only' | 'daemon' | 'cold-only'

/**
 * Declarative option surface for a daemon-routed command. dispatch.ts and
 * core/index.ts map raw parsed flags through this schema generically, so a
 * command can never lose its options by lacking a hand-written case (the
 * historical daemon "flag-strip" bug class disappears by construction).
 */
export interface CommandOptionSchema {
  /** Flags coerced with `=== true` (e.g. preview, yes, full). `md` is
   *  always mapped and need not be listed. */
  booleans?: string[]
  /** Flags passed through as strings (e.g. tags, package, status). */
  strings?: string[]
  /** Flags coerced with Number() (e.g. limit). */
  numbers?: string[]
}

export interface CommandMeta {
  name: string
  group: string
  /** Product-facing surface. `legacy` commands still execute for compatibility
   *  but are hidden from the v3 command surface. */
  surface?: 'ai-agile' | 'support' | 'legacy' | 'internal'
  description: string
  requiresProject: boolean
  usage: RegistryCommandUsage
  params?: string
  implemented: boolean
  hasTemplate: boolean
  blockingRules?: BlockingRules
  features?: string[]
  isOptional?: boolean
  requiresLlm?: boolean
  deprecated?: boolean
  replacedBy?: string
  /**
   * Dispatch routing. Present means "wired into commandRegistry";
   * absent means "metadata only" (help-text placeholders, future
   * commands, deprecated verbs whose entries we keep for the user).
   */
  routing?: CommandRouting
  /** Execution surface. Defaults to 'daemon' when `routing` is present;
   *  'bin-only' marks bin/prjct.ts-handled commands. */
  routingMode?: CommandRoutingMode
  /** Generic flag mapping for daemon/standard dispatch. Commands with a
   *  complex signature (object params, multi-positional) omit this and
   *  keep an explicit case. */
  optionSchema?: CommandOptionSchema
}

/**
 * Category metadata
 */
export interface CategoryInfo {
  title: string
  description: string
  order: number
}

/**
 * Registry statistics
 */
export interface RegistryStats {
  total: number
  implemented: number
  withTemplates: number
  claudeOnly: number
  terminalOnly: number
  both: number
  requiresInit: number
  byCategory: Record<string, number>
}

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean
  issues: string[]
}

// Note: AgentInfo and AgentAssignmentResult moved to agents.ts

// Context Output Types

/**
 * Output of the context command
 */
export interface ContextOutput {
  projectId: string
  globalPath: string
  currentTask: {
    id: string
    description: string
    startedAt: string
    subtasks?: Array<{
      id: string
      description: string
      status: string
      domain: string
    }>
    currentSubtaskIndex?: number
  } | null
  domains: string[]
  primaryDomain: string | null
  subtasks: Array<{
    id: string
    description: string
    domain: string
    agent: string
    status: string
    order: number
  }> | null
  repoAnalysis: {
    ecosystem: string
    frameworks: string[]
    hasTests: boolean
    technologies: string[]
  }
}

// Global Config Types (command-related) — GlobalConfig/AuthorEntry live in
// './config' (their canonical home); import from there directly.
