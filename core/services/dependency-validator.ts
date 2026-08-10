/**
 * Dependency Validator
 *
 * Provides graceful degradation for missing system dependencies.
 * Checks tool availability before operations and provides helpful
 * recovery hints when tools are missing.
 *
 * Pattern from Google Gemini CLI: "Never assumes library availability.
 * Checks --help before using unknown flags."
 *
 * @see PRJ-114
 */

import { execFileSync, execSync } from 'node:child_process'
import type { ErrorWithHint } from '../types/errors'
import type { ToolDefinition, ToolStatus } from '../types/services.js'
import { isExpired } from '../utils/cache'
import { createError } from '../utils/error-messages'

// TOOL DEFINITIONS

/**
 * Known tools that prjct depends on
 */
export const TOOLS: Record<string, ToolDefinition> = {
  git: {
    name: 'git',
    command: 'git --version',
    versionRegex: /git version ([\d.]+)/,
    required: true,
    installHint: 'Install Git: https://git-scm.com/downloads',
    docs: 'https://git-scm.com/doc',
  },
  node: {
    name: 'node',
    command: 'node --version',
    versionRegex: /v([\d.]+)/,
    required: true,
    installHint: 'Install Node.js: https://nodejs.org',
    docs: 'https://nodejs.org/docs',
  },
  bun: {
    name: 'bun',
    command: 'bun --version',
    versionRegex: /([\d.]+)/,
    required: false,
    installHint: 'Install Bun: curl -fsSL https://bun.sh/install | bash',
    docs: 'https://bun.sh/docs',
  },
  gh: {
    name: 'gh',
    command: 'gh --version',
    versionRegex: /gh version ([\d.]+)/,
    required: false,
    installHint: 'Install GitHub CLI: https://cli.github.com',
    docs: 'https://cli.github.com/manual',
  },
  npm: {
    name: 'npm',
    command: 'npm --version',
    versionRegex: /([\d.]+)/,
    required: false,
    installHint: 'npm comes with Node.js: https://nodejs.org',
  },
  claude: {
    name: 'claude',
    command: 'claude --version',
    versionRegex: /claude ([\d.]+)/,
    required: false,
    installHint: 'Install Claude Code: npm install -g @anthropic-ai/claude-code',
    docs: 'https://docs.anthropic.com/claude-code',
  },
  gemini: {
    name: 'gemini',
    command: 'gemini --version',
    versionRegex: /gemini ([\d.]+)/,
    required: false,
    installHint: 'Install Gemini CLI: npm install -g @google/gemini-cli',
    docs: 'https://ai.google.dev/gemini-api/docs',
  },
}

// DEPENDENCY VALIDATOR

class DependencyValidator {
  private cache = new Map<string, ToolStatus>()
  private cacheTimeout = 60_000 // 1 minute cache
  private cacheTimestamps = new Map<string, number>()

  /**
   * Check if a tool is available
   * Uses caching to avoid repeated execSync calls
   */
  checkTool(toolName: string): ToolStatus {
    // Check cache first
    const cached = this.getCached(toolName)
    if (cached) return cached

    const definition = TOOLS[toolName]
    if (!definition) {
      // Unknown tool - try to check directly
      return this.checkUnknownTool(toolName)
    }

    const status = this.executeCheck(definition)
    this.setCache(toolName, status)
    return status
  }

  /**
   * Ensure a tool is available, throw helpful error if not
   * Use this before operations that require a specific tool
   */
  ensureTool(toolName: string): void {
    const status = this.checkTool(toolName)

    if (!status.available) {
      const definition = TOOLS[toolName]
      const error = status.error || {
        message: `${toolName} is not available`,
        hint: definition?.installHint || `Install ${toolName} and try again`,
        docs: definition?.docs,
      }

      throw new DependencyError(error)
    }
  }

  /**
   * Ensure multiple tools are available
   */
  ensureTools(toolNames: string[]): void {
    const missing: string[] = []

    for (const name of toolNames) {
      const status = this.checkTool(name)
      if (!status.available) {
        missing.push(name)
      }
    }

    if (missing.length > 0) {
      const hints = missing
        .map((name) => {
          const def = TOOLS[name]
          return def ? `  ${name}: ${def.installHint}` : `  ${name}: Install and try again`
        })
        .join('\n')

      throw new DependencyError({
        message: `Missing required tools: ${missing.join(', ')}`,
        hint: `Install the following:\n${hints}`,
      })
    }
  }

  /**
   * Check if tool is available (boolean convenience method)
   */
  isAvailable(toolName: string): boolean {
    return this.checkTool(toolName).available
  }

  /**
   * Get tool version if available
   */
  getVersion(toolName: string): string | undefined {
    return this.checkTool(toolName).version
  }

  /**
   * Check multiple tools and return summary
   */
  checkAll(toolNames?: string[]): Map<string, ToolStatus> {
    const names = toolNames || Object.keys(TOOLS)
    const results = new Map<string, ToolStatus>()

    for (const name of names) {
      results.set(name, this.checkTool(name))
    }

    return results
  }

  /**
   * Clear the cache (useful for tests or after installations)
   */
  clearCache(): void {
    this.cache.clear()
    this.cacheTimestamps.clear()
  }

  // PRIVATE METHODS

  private executeCheck(definition: ToolDefinition): ToolStatus {
    try {
      const output = execSync(definition.command, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000, // 5 second timeout
      })

      const version = definition.versionRegex?.exec(output)?.[1]

      return { available: true, version }
    } catch {
      return {
        available: false,
        error: createError(
          `${definition.name} is not installed or not in PATH`,
          definition.installHint,
          { docs: definition.docs }
        ),
      }
    }
  }

  private checkUnknownTool(toolName: string): ToolStatus {
    // Validate toolName to prevent command injection
    if (!/^[a-zA-Z0-9_-]+$/.test(toolName)) {
      return {
        available: false,
        error: createError(
          `Invalid tool name: ${toolName}`,
          'Tool names must only contain alphanumeric characters, hyphens, and underscores'
        ),
      }
    }

    try {
      // Use execFileSync to avoid shell injection
      execFileSync(toolName, ['--version'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      })
      return { available: true }
    } catch {
      // Try running with -v
      try {
        execFileSync(toolName, ['-v'], {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 5000,
        })
        return { available: true }
      } catch {
        return {
          available: false,
          error: createError(
            `${toolName} is not installed or not in PATH`,
            `Install ${toolName} and try again`
          ),
        }
      }
    }
  }

  private getCached(toolName: string): ToolStatus | null {
    const timestamp = this.cacheTimestamps.get(toolName)
    if (!timestamp) return null

    if (isExpired(timestamp, this.cacheTimeout)) {
      this.cache.delete(toolName)
      this.cacheTimestamps.delete(toolName)
      return null
    }

    return this.cache.get(toolName) || null
  }

  private setCache(toolName: string, status: ToolStatus): void {
    this.cache.set(toolName, status)
    this.cacheTimestamps.set(toolName, Date.now())
  }
}

// CUSTOM ERROR

/**
 * Error thrown when a required dependency is missing
 */
export class DependencyError extends Error {
  readonly hint?: string
  readonly docs?: string

  constructor(error: ErrorWithHint) {
    super(error.message)
    this.name = 'DependencyError'
    this.hint = error.hint
    this.docs = error.docs
  }
}

// EXPORTS

export const dependencyValidator = new DependencyValidator()
