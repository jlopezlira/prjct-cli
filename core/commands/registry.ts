/**
 * Command Registry - Central command routing and execution
 *
 * Replaces the aggregator anti-pattern in commands.ts with a proper registry.
 * Each command is registered as a handler that receives context and returns a result.
 */

import configManager from '../infrastructure/config-manager'
import pathManager from '../infrastructure/path-manager'
import type {
  CategoryInfo,
  CommandHandler,
  CommandMeta,
  CommandResult,
  ExecutionContext,
  HandlerFn,
  RegistryStats,
} from '../types/commands'
import { getErrorMessage } from '../types/fs'
import { getTimestamp } from '../utils/date-helper'

/**
 * Command Registry - Routes commands to handlers
 *
 * Single source of truth for command metadata and execution.
 * Supports:
 * - Class-based handlers (CommandHandler interface)
 * - Function-based handlers (HandlerFn type)
 * - Bound method registration from existing classes
 * - Full metadata registration from static definitions
 */
class CommandRegistry {
  private handlers: Map<string, CommandHandler<unknown>> = new Map()
  private handlerFns: Map<string, HandlerFn<unknown>> = new Map()
  /** Option-aware bridges: (param, projectPath, options) → result. Set by
   *  registerLazyMethod; consumed by executeWithOptions for schema-covered
   *  commands. */
  private optionFns: Map<
    string,
    (
      param: string | null,
      projectPath: string,
      options: Record<string, unknown>
    ) => Promise<CommandResult>
  > = new Map()
  /** SIGHUP support: per-command resolved {instance, method} memo resets. */
  private lazyResetters: Array<() => void> = []
  private metadata: Map<string, CommandMeta> = new Map()
  private categories: Map<string, CategoryInfo> = new Map()
  private noProjectCommands: Set<string> = new Set(['init', 'setup', 'start', 'migrateAll'])

  /**
   * Register a command handler (class-based)
   */
  register<TParams>(handler: CommandHandler<TParams>, meta?: Partial<CommandMeta>): void {
    this.handlers.set(handler.name, handler as CommandHandler<unknown>)
    this.setMeta(handler.name, meta)
  }

  /**
   * Register a command handler function (function-based)
   */
  registerFn<TParams>(
    name: string,
    handler: HandlerFn<TParams>,
    meta?: Partial<CommandMeta>
  ): void {
    this.handlerFns.set(name, handler as HandlerFn<unknown>)
    this.setMeta(name, meta)
  }

  /**
   * Set command metadata with defaults
   */
  private setMeta(name: string, meta?: Partial<CommandMeta>): void {
    const requiresProject = meta?.requiresProject ?? !this.noProjectCommands.has(name)
    this.metadata.set(name, {
      name,
      group: meta?.group ?? 'unknown',
      surface: meta?.surface,
      description: meta?.description ?? '',
      requiresProject,
      usage: meta?.usage ?? { claude: null, terminal: null },
      implemented: meta?.implemented ?? true,
      hasTemplate: meta?.hasTemplate ?? false,
      params: meta?.params,
      blockingRules: meta?.blockingRules,
      features: meta?.features,
      isOptional: meta?.isOptional,
      deprecated: meta?.deprecated,
      replacedBy: meta?.replacedBy,
      routingMode: meta?.routingMode,
      optionSchema: meta?.optionSchema,
    })
  }

  /**
   * Register a category
   */
  registerCategory(name: string, info: CategoryInfo): void {
    this.categories.set(name, info)
  }

  /**
   * Register a command whose owning instance loads lazily on first
   * dispatch — register.ts hands a memoized async factory instead of a
   * constructed instance, so registering every command at import time
   * costs nothing (the daemon cold-start win). The "method exists"
   * validation moves from registration to first call (CI-guarded by
   * manifest-completeness.test.ts, which instantiates every group).
   *
   * This is the ONLY registration path for group methods — the old
   * eager `registerMethod` was deleted when register.ts migrated, so
   * the two mechanisms can't drift.
   */
  registerLazyMethod(
    name: string,
    loadInstance: () => Promise<object>,
    methodName: string,
    meta?: Partial<CommandMeta>
  ): void {
    type LegacyMethod = (...args: unknown[]) => Promise<CommandResult>
    // Memoized on success only: a failed load/lookup leaves `resolved`
    // unset so the next dispatch retries instead of replaying the error.
    const resolvedMethods: { instance: object; method: LegacyMethod }[] = []
    this.lazyResetters.push(() => {
      resolvedMethods.length = 0
    })
    const resolve = async (): Promise<{ instance: object; method: LegacyMethod }> => {
      const resolved = resolvedMethods.at(-1)
      if (resolved) return resolved
      const instance = await loadInstance()
      const method = (instance as Record<string, unknown>)[methodName]
      if (typeof method !== 'function') {
        throw new Error(`${methodName} is not a function`)
      }
      const loaded = { instance, method: method as LegacyMethod }
      resolvedMethods.push(loaded)
      return loaded
    }

    const wrapper: HandlerFn<unknown> = async (params, context) => {
      const { instance, method } = await resolve()
      if (params !== undefined && params !== null) {
        return method.call(instance, params, context.projectPath)
      }
      return method.call(instance, context.projectPath)
    }

    this.handlerFns.set(name, wrapper)
    this.optionFns.set(name, async (param, projectPath, options) => {
      const { instance, method } = await resolve()
      return method.call(instance, param, projectPath, options)
    })
    this.setMeta(name, meta)
  }

  /**
   * Drop every memoized resolved handler so the next dispatch re-resolves
   * through the (also reset) group loaders. SIGHUP's reload path — without
   * this, schema-covered commands kept pre-reload instances forever while
   * the explicit dispatch cases got fresh ones.
   */
  resetLazyResolutions(): void {
    for (const reset of this.lazyResetters) reset()
  }

  /**
   * Check if a command is registered
   */
  has(name: string): boolean {
    return this.handlers.has(name) || this.handlerFns.has(name)
  }

  /**
   * Get list of registered commands
   */
  list(): string[] {
    return [...this.handlers.keys(), ...this.handlerFns.keys()]
  }

  /**
   * Get commands by group
   */
  listByGroup(group: string): string[] {
    return Array.from(this.metadata.entries())
      .filter(([, meta]) => meta.group === group)
      .map(([name]) => name)
  }

  /**
   * Get all groups
   */
  getGroups(): string[] {
    const groups = new Set<string>()
    for (const meta of this.metadata.values()) {
      groups.add(meta.group)
    }
    return Array.from(groups)
  }

  /**
   * Get command metadata
   */
  getMeta(name: string): CommandMeta | undefined {
    return this.metadata.get(name)
  }

  // ===== Query Methods (from static registry) =====

  /**
   * Get all commands
   */
  getAll(): CommandMeta[] {
    return Array.from(this.metadata.values())
  }

  /**
   * Get command by name
   */
  getByName(name: string): CommandMeta | undefined {
    return this.metadata.get(name)
  }

  /**
   * Get commands by category/group
   */
  getByCategory(category: string): CommandMeta[] {
    return this.getAll().filter((c) => c.group === category)
  }

  /**
   * Get all implemented commands
   */
  getAllImplemented(): CommandMeta[] {
    return this.getAll().filter((c) => c.implemented)
  }

  /**
   * Get all commands with templates
   */
  getAllWithTemplates(): CommandMeta[] {
    return this.getAll().filter((c) => c.hasTemplate)
  }

  /**
   * Get commands available in Claude Code
   */
  getClaudeCommands(): CommandMeta[] {
    return this.getAll().filter((c) => c.usage.claude !== null)
  }

  /**
   * Get commands available in terminal
   */
  getTerminalCommands(): CommandMeta[] {
    return this.getAll().filter((c) => c.usage.terminal !== null)
  }

  /**
   * Get all categories
   */
  getAllCategories(): Map<string, CategoryInfo> {
    return new Map(this.categories)
  }

  /**
   * Get category metadata
   */
  getCategory(category: string): CategoryInfo | undefined {
    return this.categories.get(category)
  }

  /**
   * Get commands that require initialization
   */
  getRequiresInit(): CommandMeta[] {
    return this.getAll().filter((c) => c.requiresProject)
  }

  /**
   * Get commands with blocking rules
   */
  getWithBlockingRules(): CommandMeta[] {
    return this.getAll().filter((c) => c.blockingRules !== undefined)
  }

  /**
   * Get optional commands
   */
  getOptionalCommands(): CommandMeta[] {
    return this.getAll().filter((c) => c.isOptional)
  }

  /**
   * Get deprecated commands
   */
  getDeprecatedCommands(): CommandMeta[] {
    return this.getAll().filter((c) => c.deprecated)
  }

  /**
   * Get statistics
   */
  getStats(): RegistryStats {
    const all = this.getAll()
    const byCategory: Record<string, number> = {}

    for (const category of this.categories.keys()) {
      byCategory[category] = all.filter((c) => c.group === category).length
    }

    return {
      total: all.length,
      implemented: all.filter((c) => c.implemented).length,
      withTemplates: all.filter((c) => c.hasTemplate).length,
      claudeOnly: all.filter((c) => c.usage.claude && !c.usage.terminal).length,
      terminalOnly: all.filter((c) => !c.usage.claude && c.usage.terminal).length,
      both: all.filter((c) => c.usage.claude && c.usage.terminal).length,
      requiresInit: all.filter((c) => c.requiresProject).length,
      byCategory,
    }
  }

  /**
   * Validate registry
   */
  validate(): { valid: boolean; issues: string[] } {
    const issues: string[] = []
    const all = this.getAll()

    // Check for duplicate names
    const names = all.map((c) => c.name)
    const duplicates = names.filter((name, index) => names.indexOf(name) !== index)
    if (duplicates.length > 0) {
      issues.push(`Duplicate command names: ${duplicates.join(', ')}`)
    }

    // Check for commands with templates but not implemented
    const notImplemented = all.filter((c) => c.hasTemplate && !c.implemented)
    if (notImplemented.length > 0) {
      issues.push(
        `Commands with templates but not implemented: ${notImplemented.map((c) => c.name).join(', ')}`
      )
    }

    // Check for invalid categories
    const validCategories = Array.from(this.categories.keys())
    if (validCategories.length > 0) {
      const invalidCategories = all.filter((c) => !validCategories.includes(c.group))
      if (invalidCategories.length > 0) {
        issues.push(
          `Invalid categories: ${invalidCategories.map((c) => `${c.name}:${c.group}`).join(', ')}`
        )
      }
    }

    return {
      valid: issues.length === 0,
      issues,
    }
  }

  /**
   * Build execution context for a project
   */
  async buildContext(projectPath: string): Promise<ExecutionContext> {
    const projectId = await configManager.getProjectId(projectPath)

    if (!projectId) {
      throw new Error('No prjct project found. Run p. init first.')
    }

    return {
      projectId,
      projectPath,
      globalPath: pathManager.getGlobalProjectPath(projectId),
      timestamp: getTimestamp(),
    }
  }

  /**
   * Execute a command by name
   */
  async execute<TParams = void>(
    name: string,
    params: TParams,
    projectPath: string = process.cwd()
  ): Promise<CommandResult> {
    const meta = this.metadata.get(name)

    // Build context (may throw if project not initialized)
    const context = await (async (): Promise<ExecutionContext | CommandResult> => {
      if (meta?.requiresProject === false) {
        return {
          projectId: '',
          projectPath,
          globalPath: '',
          timestamp: getTimestamp(),
        }
      }
      try {
        return await this.buildContext(projectPath)
      } catch (error) {
        return {
          success: false,
          error: getErrorMessage(error),
        }
      }
    })()
    if ('success' in context) return context

    // Check class-based handlers first
    const handler = this.handlers.get(name)
    if (handler) {
      return handler.execute(params, context)
    }

    // Check function-based handlers
    const handlerFn = this.handlerFns.get(name)
    if (handlerFn) {
      return handlerFn(params, context)
    }

    return {
      success: false,
      error: `Command not found: ${name}`,
    }
  }

  /**
   * Execute a registerLazyMethod-bound command WITH its options object —
   * (param, projectPath, options), the uniform group-method shape. The
   * caller maps wire flags through the command's `optionSchema` first
   * (see option-mapper.ts). Same context rules as execute().
   */
  async executeWithOptions(
    name: string,
    param: string | null,
    projectPath: string,
    options: Record<string, unknown>
  ): Promise<CommandResult> {
    const fn = this.optionFns.get(name)
    if (!fn) {
      return { success: false, error: `Command not found: ${name}` }
    }
    const meta = this.metadata.get(name)
    if (meta?.requiresProject !== false) {
      try {
        await this.buildContext(projectPath)
      } catch (error) {
        return { success: false, error: getErrorMessage(error) }
      }
    }
    return fn(param, projectPath, options)
  }

  /**
   * Execute without requiring project (for init, setup commands)
   * @deprecated Use execute() - it auto-detects based on command metadata
   */
  async executeWithoutProject<TParams = void>(
    name: string,
    params: TParams,
    projectPath: string = process.cwd()
  ): Promise<CommandResult> {
    const handler = this.handlers.get(name)
    if (handler) {
      const context: ExecutionContext = {
        projectId: '',
        projectPath,
        globalPath: '',
        timestamp: getTimestamp(),
      }
      return handler.execute(params, context)
    }

    const handlerFn = this.handlerFns.get(name)
    if (handlerFn) {
      const context: ExecutionContext = {
        projectId: '',
        projectPath,
        globalPath: '',
        timestamp: getTimestamp(),
      }
      return handlerFn(params, context)
    }

    return {
      success: false,
      error: `Command not found: ${name}`,
    }
  }

  /**
   * Clear all registrations (useful for testing)
   */
  clear(): void {
    this.handlers.clear()
    this.handlerFns.clear()
    this.metadata.clear()
    this.categories.clear()
  }
}

// Singleton instance
export const commandRegistry = new CommandRegistry()
