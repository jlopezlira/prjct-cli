/**
 * prjct CLI Commands Handler
 *
 * MD-First Architecture - All state in Markdown files.
 *
 * COMMANDS:
 * - Workflow: done, next, pause, resume
 * - Planning: init, bug, idea, spec
 * - Shipping: ship
 * - Analytics: dash, help
 * - Maintenance: cleanup, design, recover, undo, redo, history
 * - Analysis: analyze, sync
 * - Setup: start, setup
 * - Context: context
 */

import type { AgentInfo } from '../types/agent-info'
import type { MdOption } from '../types/cli'
import type { AnalyzeOptions, Author, CommandResult, SetupOptions } from '../types/commands'
import type { AnalysisCommands } from './analysis'
import type { CaptureCommands } from './capture'
import type { ConfigCommands } from './config'
import type { ContextCommands } from './context'
import type { EmbeddingsCommands } from './embeddings'
import type { GuardCommands } from './guard'
import type { InstallCommands } from './install'
import type { McpCommands } from './mcp'
import type { PlanningCommands } from './planning'
import type { PrimitiveCommands } from './primitives'
import type { SeedCommands } from './seed'
import type { SetupCommands } from './setup'
import type { ShippingCommands } from './shipping'
import type { SpecCommands } from './spec'
import type { TeamCommands } from './team'
import type { UpdateCommands } from './update'
import type { WorkflowCommands } from './workflow'

/**
 * PrjctCommands - Combined class with all commands
 * Uses mixins pattern to combine all command groups
 */
class PrjctCommands {
  // Lazy, memoized group loaders. The classes load on FIRST USE via
  // dynamic import — constructing PrjctCommands costs nothing, so the
  // daemon answers its first socket request without parsing the 17
  // command modules (sync-service alone drags in the BM25 indexer,
  // import-graph walker and skill generator). Type-only imports above
  // keep the signatures without the load.
  private _workflow?: Promise<WorkflowCommands>
  private workflowG(): Promise<WorkflowCommands> {
    return (this._workflow ??= import('./workflow')
      .then((m) => new m.WorkflowCommands())
      .catch((err) => {
        // Don't memoize a failed load — clear so the next call retries.
        this._workflow = undefined
        throw err
      }))
  }
  private _planning?: Promise<PlanningCommands>
  private planningG(): Promise<PlanningCommands> {
    return (this._planning ??= import('./planning')
      .then((m) => new m.PlanningCommands())
      .catch((err) => {
        // Don't memoize a failed load — clear so the next call retries.
        this._planning = undefined
        throw err
      }))
  }
  private _shipping?: Promise<ShippingCommands>
  private shippingG(): Promise<ShippingCommands> {
    return (this._shipping ??= import('./shipping')
      .then((m) => new m.ShippingCommands())
      .catch((err) => {
        // Don't memoize a failed load — clear so the next call retries.
        this._shipping = undefined
        throw err
      }))
  }
  private _analysis?: Promise<AnalysisCommands>
  private analysisG(): Promise<AnalysisCommands> {
    return (this._analysis ??= import('./analysis')
      .then((m) => new m.AnalysisCommands())
      .catch((err) => {
        // Don't memoize a failed load — clear so the next call retries.
        this._analysis = undefined
        throw err
      }))
  }
  private _setupCmds?: Promise<SetupCommands>
  private setupCmdsG(): Promise<SetupCommands> {
    return (this._setupCmds ??= import('./setup')
      .then((m) => new m.SetupCommands())
      .catch((err) => {
        // Don't memoize a failed load — clear so the next call retries.
        this._setupCmds = undefined
        throw err
      }))
  }
  private _updateCmds?: Promise<UpdateCommands>
  private updateCmdsG(): Promise<UpdateCommands> {
    return (this._updateCmds ??= import('./update')
      .then((m) => new m.UpdateCommands())
      .catch((err) => {
        // Don't memoize a failed load — clear so the next call retries.
        this._updateCmds = undefined
        throw err
      }))
  }
  private _contextCmds?: Promise<ContextCommands>
  private contextCmdsG(): Promise<ContextCommands> {
    return (this._contextCmds ??= import('./context')
      .then((m) => new m.ContextCommands())
      .catch((err) => {
        // Don't memoize a failed load — clear so the next call retries.
        this._contextCmds = undefined
        throw err
      }))
  }
  private _primitivesCmds?: Promise<PrimitiveCommands>
  private primitivesCmdsG(): Promise<PrimitiveCommands> {
    return (this._primitivesCmds ??= import('./primitives')
      .then((m) => new m.PrimitiveCommands())
      .catch((err) => {
        // Don't memoize a failed load — clear so the next call retries.
        this._primitivesCmds = undefined
        throw err
      }))
  }
  private _seedCmds?: Promise<SeedCommands>
  private seedCmdsG(): Promise<SeedCommands> {
    return (this._seedCmds ??= import('./seed')
      .then((m) => new m.SeedCommands())
      .catch((err) => {
        // Don't memoize a failed load — clear so the next call retries.
        this._seedCmds = undefined
        throw err
      }))
  }
  private _installCmds?: Promise<InstallCommands>
  private installCmdsG(): Promise<InstallCommands> {
    return (this._installCmds ??= import('./install')
      .then((m) => new m.InstallCommands())
      .catch((err) => {
        // Don't memoize a failed load — clear so the next call retries.
        this._installCmds = undefined
        throw err
      }))
  }
  private _captureCmds?: Promise<CaptureCommands>
  private captureCmdsG(): Promise<CaptureCommands> {
    return (this._captureCmds ??= import('./capture')
      .then((m) => new m.CaptureCommands())
      .catch((err) => {
        // Don't memoize a failed load — clear so the next call retries.
        this._captureCmds = undefined
        throw err
      }))
  }
  private _mcpCmds?: Promise<McpCommands>
  private mcpCmdsG(): Promise<McpCommands> {
    return (this._mcpCmds ??= import('./mcp')
      .then((m) => new m.McpCommands())
      .catch((err) => {
        // Don't memoize a failed load — clear so the next call retries.
        this._mcpCmds = undefined
        throw err
      }))
  }
  private _teamCmds?: Promise<TeamCommands>
  private teamCmdsG(): Promise<TeamCommands> {
    return (this._teamCmds ??= import('./team')
      .then((m) => new m.TeamCommands())
      .catch((err) => {
        // Don't memoize a failed load — clear so the next call retries.
        this._teamCmds = undefined
        throw err
      }))
  }
  private _configCmds?: Promise<ConfigCommands>
  private configCmdsG(): Promise<ConfigCommands> {
    return (this._configCmds ??= import('./config')
      .then((m) => new m.ConfigCommands())
      .catch((err) => {
        // Don't memoize a failed load — clear so the next call retries.
        this._configCmds = undefined
        throw err
      }))
  }
  private _embeddingsCmds?: Promise<EmbeddingsCommands>
  private embeddingsCmdsG(): Promise<EmbeddingsCommands> {
    return (this._embeddingsCmds ??= import('./embeddings')
      .then((m) => new m.EmbeddingsCommands())
      .catch((err) => {
        // Don't memoize a failed load — clear so the next call retries.
        this._embeddingsCmds = undefined
        throw err
      }))
  }
  private _guardCmds?: Promise<GuardCommands>
  private guardCmdsG(): Promise<GuardCommands> {
    return (this._guardCmds ??= import('./guard')
      .then((m) => new m.GuardCommands())
      .catch((err) => {
        // Don't memoize a failed load — clear so the next call retries.
        this._guardCmds = undefined
        throw err
      }))
  }
  private _specCmds?: Promise<SpecCommands>
  private specCmdsG(): Promise<SpecCommands> {
    return (this._specCmds ??= import('./spec')
      .then((m) => new m.SpecCommands())
      .catch((err) => {
        // Don't memoize a failed load — clear so the next call retries.
        this._specCmds = undefined
        throw err
      }))
  }

  // Shared state
  agent: unknown
  agentInfo: AgentInfo | null
  currentAuthor: Author | null
  prjctDir: string

  constructor() {
    this.agent = null
    this.agentInfo = null
    this.currentAuthor = null
    this.prjctDir = '.prjct'
  }

  // ========== Workflow Commands ==========

  async task(
    description: string | null = null,
    projectPath: string = process.cwd(),
    options: { md?: boolean; skipHooks?: boolean; spec?: string } = {}
  ): Promise<CommandResult> {
    return (await this.workflowG()).now(description, projectPath, options)
  }

  async workflowPrefs(
    input: string | null = null,
    projectPath: string = process.cwd(),
    options: MdOption = {}
  ): Promise<CommandResult> {
    return (await this.workflowG()).workflow(input, projectPath, options)
  }

  // ========== Planning Commands ==========

  async init(
    optionsOrIdea: import('../types/commands').InitOptions | string | null = null,
    projectPath: string = process.cwd()
  ): Promise<CommandResult> {
    return (await this.planningG()).init(optionsOrIdea, projectPath)
  }

  // ========== Shipping Commands ==========

  async ship(
    feature: string | null,
    projectPath: string = process.cwd(),
    options: {
      md?: boolean
      skipHooks?: boolean
      intent?:
        | 'register-only'
        | 'seed-code-workflow'
        | 'proceed'
        | 'pr-convention-auto'
        | 'pr-convention-manual'
        | 'review-full'
        | 'review-standard'
        | 'review-skip'
      noSpecGate?: boolean
      noTestGate?: boolean
      allowNewDeps?: boolean
      forcePressure?: boolean
      noJudgmentGate?: boolean
      geometry?: 'direct' | 'single' | 'split'
    } = {}
  ): Promise<CommandResult> {
    return (await this.shippingG()).ship(feature, projectPath, { ...options })
  }

  // ========== Analysis Commands ==========

  async analyze(
    options: AnalyzeOptions = {},
    projectPath: string = process.cwd()
  ): Promise<CommandResult> {
    return (await this.analysisG()).analyze(options, projectPath)
  }

  async sync(
    projectPath: string = process.cwd(),
    options: {
      preview?: boolean
      yes?: boolean
      json?: boolean
      md?: boolean
      package?: string
      full?: boolean
    } = {}
  ): Promise<CommandResult> {
    return (await this.analysisG()).sync(projectPath, options)
  }

  async saveLlmAnalysis(
    analysisJson: string,
    projectPath: string = process.cwd(),
    options: MdOption = {}
  ): Promise<CommandResult> {
    return (await this.analysisG()).saveLlmAnalysis(analysisJson, projectPath, options)
  }

  // ========== Context Commands ==========

  async context(
    input: string | null = null,
    projectPath: string = process.cwd(),
    options: MdOption = {}
  ): Promise<CommandResult> {
    return (await this.contextCmdsG()).context(input, projectPath, options)
  }

  async search(
    query: string | null = null,
    projectPath: string = process.cwd(),
    options: MdOption = {}
  ): Promise<CommandResult> {
    return (await this.contextCmdsG()).search(query, projectPath, options)
  }

  // ========== v2 Primitives ==========

  async status(
    value: string | null = null,
    projectPath: string = process.cwd(),
    options: MdOption = {}
  ): Promise<CommandResult> {
    return (await this.primitivesCmdsG()).status(value, projectPath, options)
  }

  async tag(
    args: string | null = null,
    projectPath: string = process.cwd(),
    options: MdOption = {}
  ): Promise<CommandResult> {
    return (await this.primitivesCmdsG()).tag(args, projectPath, options)
  }

  async remember(
    args: string | null = null,
    projectPath: string = process.cwd(),
    options: { md?: boolean; tags?: string } = {}
  ): Promise<CommandResult> {
    return (await this.primitivesCmdsG()).remember(args, projectPath, options)
  }

  async forget(
    id: string | null = null,
    projectPath: string = process.cwd(),
    options: MdOption = {}
  ): Promise<CommandResult> {
    return (await this.primitivesCmdsG()).forget(id, projectPath, options)
  }

  async close(
    id: string | null = null,
    projectPath: string = process.cwd(),
    options: MdOption & { reason?: string } = {}
  ): Promise<CommandResult> {
    return (await this.primitivesCmdsG()).close(id, projectPath, options)
  }

  // v2 alpha.8: declarative packs + Claude Code hook install
  async seed(
    input: string | null = null,
    projectPath: string = process.cwd(),
    options: MdOption = {}
  ): Promise<CommandResult> {
    return (await this.seedCmdsG()).seed(input, projectPath, options)
  }

  async install(
    _arg: string | null = null,
    projectPath: string = process.cwd(),
    options: MdOption = {}
  ): Promise<CommandResult> {
    return (await this.installCmdsG()).install(null, projectPath, options)
  }

  async capture(
    content: string | null = null,
    projectPath: string = process.cwd(),
    options: { md?: boolean; tags?: string; force?: boolean } = {}
  ): Promise<CommandResult> {
    return (await this.captureCmdsG()).capture(content, projectPath, options)
  }

  async mcp(
    input: string | null = null,
    projectPath: string = process.cwd(),
    options: MdOption = {}
  ): Promise<CommandResult> {
    return (await this.mcpCmdsG()).mcp(input, projectPath, options)
  }

  async team(
    input: string | null = null,
    projectPath: string = process.cwd(),
    options: { md?: boolean; required?: boolean; minVersion?: string } = {}
  ): Promise<CommandResult> {
    return (await this.teamCmdsG()).team(input, projectPath, options)
  }

  async config(
    input: string | null = null,
    projectPath: string = process.cwd(),
    options: MdOption = {}
  ): Promise<CommandResult> {
    return (await this.configCmdsG()).config(input, projectPath, options)
  }

  async embeddings(
    input: string | null = null,
    projectPath: string = process.cwd(),
    options: MdOption & {
      key?: string
      model?: string
      baseUrl?: string
      authHeader?: string
      authScheme?: string
      headers?: string
      query?: string
    } = {}
  ): Promise<CommandResult> {
    return (await this.embeddingsCmdsG()).embeddings(input, projectPath, options)
  }

  async guard(
    input: string | null = null,
    projectPath: string = process.cwd(),
    options: MdOption & { limit?: number; sourceInspectionToken?: string } = {}
  ): Promise<CommandResult> {
    return (await this.guardCmdsG()).guard(input, projectPath, options)
  }

  // ========== Auth Commands ==========

  async auth(action: string | null = null, options: MdOption = {}): Promise<CommandResult> {
    return (await this.setupCmdsG()).auth(action, options)
  }

  async login(options: { md?: boolean } = {}): Promise<CommandResult> {
    return (await this.setupCmdsG()).login(options)
  }

  async logout(): Promise<CommandResult> {
    return (await this.setupCmdsG()).logout()
  }

  // ========== Setup Commands ==========

  async start(): Promise<CommandResult> {
    return (await this.setupCmdsG()).start()
  }

  async setup(options: SetupOptions = {}): Promise<CommandResult> {
    return (await this.setupCmdsG()).setup(options)
  }

  async update(
    options: { 'dry-run'?: boolean; md?: boolean } = {},
    projectPath: string = process.cwd()
  ): Promise<CommandResult> {
    return (await this.updateCmdsG()).update(options, projectPath)
  }

  async installStatusLine(): Promise<{ success: boolean; error?: string }> {
    return (await this.setupCmdsG()).installStatusLine()
  }

  // ========== Delegated Base Methods ==========

  async initializeAgent(): Promise<unknown> {
    return (await this.workflowG()).initializeAgent()
  }

  async ensureProjectInit(projectPath: string): Promise<CommandResult> {
    return (await this.workflowG()).ensureProjectInit(projectPath)
  }

  async ensureAuthor(): Promise<Author> {
    return (await this.workflowG()).ensureAuthor()
  }

  async getGlobalProjectPath(projectPath: string): Promise<string> {
    return (await this.workflowG()).getGlobalProjectPath(projectPath)
  }

  async logToMemory(
    projectPath: string,
    action: string,
    data: Record<string, unknown>
  ): Promise<void> {
    return (await this.workflowG()).logToMemory(projectPath, action, data)
  }

  // ========== SDD Spec Commands ==========

  async spec(
    title: string | null = null,
    projectPath: string = process.cwd(),
    options: {
      md?: boolean
      goal?: string
      tags?: string
    } = {}
  ): Promise<CommandResult> {
    return (await this.specCmdsG()).draft(title, projectPath, options)
  }

  async specList(
    projectPath: string = process.cwd(),
    options: { md?: boolean; status?: string } = {}
  ): Promise<CommandResult> {
    return (await this.specCmdsG()).list(null, projectPath, options)
  }

  async specShow(
    id: string | null = null,
    projectPath: string = process.cwd(),
    options: { md?: boolean } = {}
  ): Promise<CommandResult> {
    return (await this.specCmdsG()).show(id, projectPath, options)
  }

  async specUpdate(
    id: string | null = null,
    projectPath: string = process.cwd(),
    options: { md?: boolean; json?: string } = {}
  ): Promise<CommandResult> {
    return (await this.specCmdsG()).update(id, projectPath, options)
  }

  async specApplyDelta(
    id: string | null = null,
    projectPath: string = process.cwd(),
    options: { md?: boolean | string; file?: string } = {}
  ): Promise<CommandResult> {
    return (await this.specCmdsG()).applyDelta(id, projectPath, options)
  }

  async specSetStatus(
    id: string | null = null,
    projectPath: string = process.cwd(),
    options: { md?: boolean; status?: string } = {}
  ): Promise<CommandResult> {
    return (await this.specCmdsG()).setStatus(id, projectPath, options)
  }

  async specRecordReview(
    id: string | null = null,
    projectPath: string = process.cwd(),
    options: { md?: boolean; reviewer?: string; verdict?: string; notes?: string } = {}
  ): Promise<CommandResult> {
    return (await this.specCmdsG()).recordReview(id, projectPath, options)
  }

  async specLinkTask(
    id: string | null = null,
    projectPath: string = process.cwd(),
    options: { md?: boolean; taskId?: string } = {}
  ): Promise<CommandResult> {
    return (await this.specCmdsG()).linkTask(id, projectPath, options)
  }

  async specShip(
    id: string | null = null,
    projectPath: string = process.cwd(),
    options: { md?: boolean; pr?: number | string } = {}
  ): Promise<CommandResult> {
    return (await this.specCmdsG()).ship(id, projectPath, options)
  }

  async specAudit(
    id: string | null = null,
    projectPath: string = process.cwd(),
    options: { md?: boolean; lenses?: string; strict?: boolean } = {}
  ): Promise<CommandResult> {
    return (await this.specCmdsG()).audit(id, projectPath, options)
  }

  async specValidate(
    id: string | null = null,
    projectPath: string = process.cwd(),
    options: { md?: boolean; strict?: boolean } = {}
  ): Promise<CommandResult> {
    return (await this.specCmdsG()).validate(id, projectPath, options)
  }

  async specBreakdown(
    id: string | null = null,
    projectPath: string = process.cwd(),
    options: { md?: boolean; force?: boolean } = {}
  ): Promise<CommandResult> {
    return (await this.specCmdsG()).breakdown(id, projectPath, options)
  }

  async specInventory(
    projectPath: string = process.cwd(),
    options: { md?: boolean; json?: boolean } = {}
  ): Promise<CommandResult> {
    return (await this.specCmdsG()).inventory(null, projectPath, options)
  }
}

export { PrjctCommands }
