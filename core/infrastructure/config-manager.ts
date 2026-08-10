/**
 * ConfigManager - Manages prjct.config.json files
 *
 * Key responsibilities:
 * - Read and write prjct.config.json (supports .jsonc with comments)
 * - Validate configuration structure
 * - Create new configurations
 * - Update existing configurations
 *
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import * as jsonc from 'jsonc-parser'
import { getErrorMessage } from '../errors'
import { deriveProjectId } from '../services/sync/project-identity'
import type { Author } from '../types/commands'
import type { GlobalConfig, LocalConfig } from '../types/config'
import { isNotFoundError } from '../types/fs'
import { getTimestamp } from '../utils/date-helper'
import { writeJson } from '../utils/file-helper'
import { VERSION } from '../utils/version'
import * as authorDetector from './author-detector'
import pathManager from './path-manager'

/**
 * Parse JSON or JSONC content safely
 * Supports comments (line and block style) in config files
 */
function parseJsonc<T>(content: string): T {
  const errors: jsonc.ParseError[] = []
  const result = jsonc.parse(content, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  })
  if (errors.length > 0) {
    const firstError = errors[0]
    throw new SyntaxError(
      `JSON parse error at offset ${firstError.offset}: ${jsonc.printParseErrorCode(firstError.error)}`
    )
  }
  return result
}

/**
 * mtime-keyed config cache. The hooks read prjct.config.json up to 4× per
 * EDIT (pre-edit ×2, post-edit + memoryService.getProjectId) and 1-2× per
 * prompt/stop — each a disk read + jsonc scanner parse (~5-10× slower than
 * JSON.parse). The daemon keeps this map warm across hook invocations; the
 * mtime check keeps it correct when the user (or prjct itself) edits the
 * file. Bounded like the git-snapshot cache: hooks only ever see a handful
 * of cwds per daemon.
 */
const configCache = new Map<string, { mtimeMs: number; config: LocalConfig | null }>()

class ConfigManager {
  /**
   * Read the project configuration file
   * Supports both .json and .jsonc formats (with comments)
   */
  async readConfig(projectPath: string): Promise<LocalConfig | null> {
    const configPath = pathManager.getLocalConfigPath(projectPath)
    const stat = await fs.stat(configPath).catch(() => null)
    if (!stat) {
      configCache.delete(configPath)
      return null // no file — same result the read would produce
    }
    const mtimeMs = stat.mtimeMs
    const cached = configCache.get(configPath)
    if (cached && cached.mtimeMs === mtimeMs) return cached.config

    try {
      const content = await fs.readFile(configPath, 'utf-8')
      const config = parseJsonc<LocalConfig>(content)
      if (configCache.size > 32) configCache.clear()
      configCache.set(configPath, { mtimeMs, config })
      return config
    } catch (error) {
      // File vanished between stat and read is expected - return null
      if (isNotFoundError(error)) {
        configCache.delete(configPath)
        return null
      }
      // JSON parse errors or other issues - log and return null
      console.warn(`Warning: Could not read config at ${projectPath}: ${getErrorMessage(error)}`)
      return null
    }
  }

  /**
   * Write the project configuration file
   */
  async writeConfig(projectPath: string, config: LocalConfig): Promise<void> {
    const configPath = pathManager.getLocalConfigPath(projectPath)
    await writeJson(configPath, config)
    // Drop rather than update: the next read re-stats and re-caches, keeping
    // one authority (the file + its mtime) for what the cache holds.
    configCache.delete(configPath)
  }

  /**
   * Read the global project configuration file
   * Contains authors array and other system data
   * Supports both .json and .jsonc formats (with comments)
   */
  async readGlobalConfig(projectId: string): Promise<GlobalConfig | null> {
    try {
      const configPath = pathManager.getGlobalProjectConfigPath(projectId)
      const content = await fs.readFile(configPath, 'utf-8')
      return parseJsonc<GlobalConfig>(content)
    } catch (error) {
      // File not found is expected for new projects
      if (isNotFoundError(error)) {
        return null
      }
      // Log other errors for debugging
      console.warn(
        `Warning: Could not read global config for ${projectId}: ${getErrorMessage(error)}`
      )
      return null
    }
  }

  /**
   * Write the global project configuration file
   */
  async writeGlobalConfig(projectId: string, config: GlobalConfig): Promise<void> {
    const configPath = pathManager.getGlobalProjectConfigPath(projectId)
    await writeJson(configPath, config)
  }

  /**
   * Ensure global config exists, create if not
   */
  async ensureGlobalConfig(projectId: string): Promise<GlobalConfig> {
    const existing = await this.readGlobalConfig(projectId)
    const globalConfig =
      existing ??
      (() => {
        const now = getTimestamp()
        return {
          projectId,
          authors: [],
          version: VERSION,
          lastSync: now,
        }
      })()
    if (!existing) {
      await this.writeGlobalConfig(projectId, globalConfig)
    }

    return globalConfig
  }

  /**
   * Create a new project configuration
   */
  async createConfig(
    projectPath: string,
    author: { name?: string; email?: string; github?: string }
  ): Promise<LocalConfig> {
    // Prefer a deterministic id derived from the git remote so the SAME repo
    // gets the SAME cloud project on every machine (no duplicates). Repos with
    // no remote fall back to a random id (can't be deduplicated cross-machine).
    const projectId =
      (await deriveProjectId(projectPath)) ?? pathManager.generateProjectId(projectPath)
    const globalPath = pathManager.getGlobalProjectPath(projectId)
    const displayPath = pathManager.getDisplayPath(globalPath)
    const now = getTimestamp()

    const localConfig: LocalConfig = {
      projectId,
      dataPath: displayPath,
      showMetrics: true, // PRJ-70: default to true for new projects
    }

    await this.writeConfig(projectPath, localConfig)

    const globalConfig: GlobalConfig = {
      projectId,
      authors: [
        {
          name: author.name || 'Unknown',
          email: author.email || '',
          github: author.github || '',
          firstContribution: now,
          lastActivity: now,
        },
      ],
      version: VERSION,
      created: now,
      lastSync: now,
    }

    await this.writeGlobalConfig(projectId, globalConfig)

    return localConfig
  }

  /**
   * Update the lastSync timestamp in global config
   */
  async updateLastSync(projectPath: string): Promise<void> {
    const projectId = await this.getProjectId(projectPath)
    const globalConfig = await this.readGlobalConfig(projectId)
    if (globalConfig) {
      globalConfig.lastSync = getTimestamp()
      await this.writeGlobalConfig(projectId, globalConfig)
    }
  }

  /**
   * Validate a local configuration object
   * Local config only contains project metadata (projectId, dataPath)
   * All system data (version, created, lastSync, authors) is in global config
   */
  validateConfig(config: LocalConfig | null): boolean {
    if (!config) return false
    if (!config.projectId) return false
    if (!config.dataPath) return false

    return true
  }

  /**
   * Check if a project needs migration
   * Migration is needed if:
   * - Has legacy .prjct/ structure
   * - AND either no config exists OR files not yet in global location
   */
  async needsMigration(projectPath: string): Promise<boolean> {
    const hasLegacy = await pathManager.hasLegacyStructure(projectPath)
    if (!hasLegacy) return false

    const hasConfig = await pathManager.hasConfig(projectPath)

    if (!hasConfig) return true

    const config = await this.readConfig(projectPath)
    if (!config || !config.projectId) return true

    const globalPath = pathManager.getGlobalProjectPath(config.projectId)

    try {
      const coreFiles = await fs.readdir(path.join(globalPath, 'core'))
      return coreFiles.length === 0
    } catch (error) {
      // Directory not found means migration needed
      if (isNotFoundError(error)) {
        return true
      }
      // Permission errors or other issues - assume migration needed
      return true
    }
  }

  /**
   * Resolve the project ID from config (or the main worktree's config when
   * running in a child worktree).
   *
   * Returns `''` when the path is not an initialized prjct project. It does
   * NOT mint a new id here: `generateProjectId()` is `crypto.randomUUID()`,
   * so minting on a config-read miss silently forks a fresh orphan project
   * every time a path-resolution miss happens (daemon resolving the wrong
   * cwd, config transiently unreadable, etc.) — scattering specs/memory
   * across ghost projects with no error surfaced. Only explicit project
   * creation (`createConfig`, i.e. `prjct init`) is allowed to mint.
   *
   * The empty-string sentinel is what 31/32 call sites already guard for
   * (`if (!projectId) return "run prjct init"`), so callers fail loud
   * instead of writing into a random new project.
   */
  async getProjectId(projectPath: string): Promise<string> {
    const config = await this.readConfig(projectPath)
    if (config?.projectId) {
      return config.projectId
    }

    // Worktree fallback: check if this is a child worktree and read main config
    try {
      const { worktreeService } = await import('../services/worktree-service')
      const worktreeInfo = await worktreeService.detect(projectPath)
      if (worktreeInfo) {
        const mainPath = await worktreeService.getMainWorktree(projectPath)
        if (mainPath !== projectPath) {
          const mainConfig = await this.readConfig(mainPath)
          if (mainConfig?.projectId) {
            return mainConfig.projectId
          }
        }
      }
    } catch {
      // worktree detection failed — not critical, fall through
    }

    // Not an initialized project. Fail loud (callers guard `!projectId`),
    // never silently mint a random orphan project.
    return ''
  }

  /**
   * Find an author in the authors array by github username
   * Reads from GLOBAL config
   */
  async findAuthor(projectId: string, githubUsername: string): Promise<Author | null> {
    const globalConfig = await this.readGlobalConfig(projectId)
    if (!globalConfig || !globalConfig.authors) return null

    return globalConfig.authors.find((a) => a.github === githubUsername) || null
  }

  /**
   * Add a new author to the authors array
   * Writes to GLOBAL config
   */
  async addAuthor(
    projectId: string,
    author: { name?: string; email?: string; github?: string }
  ): Promise<void> {
    const globalConfig = await this.ensureGlobalConfig(projectId)

    const exists = globalConfig.authors.some((a) => a.github === author.github)
    if (exists) return

    const now = getTimestamp()
    globalConfig.authors.push({
      name: author.name || 'Unknown',
      email: author.email || '',
      github: author.github || '',
      firstContribution: now,
      lastActivity: now,
    })

    globalConfig.lastSync = now
    await this.writeGlobalConfig(projectId, globalConfig)
  }

  /**
   * Update author's last activity timestamp
   * Updates GLOBAL config
   */
  async updateAuthorActivity(projectId: string, githubUsername: string): Promise<void> {
    const globalConfig = await this.readGlobalConfig(projectId)
    if (!globalConfig || !globalConfig.authors) return

    const author = globalConfig.authors.find((a) => a.github === githubUsername)
    if (author) {
      author.lastActivity = getTimestamp()
      globalConfig.lastSync = author.lastActivity
      await this.writeGlobalConfig(projectId, globalConfig)
    }
  }

  /**
   * Get current author for session (detect or get from global config)
   */
  async getCurrentAuthor(projectPath: string): Promise<string> {
    const author = await authorDetector.detect()

    const projectId = await this.getProjectId(projectPath)
    await this.addAuthor(projectId, {
      name: author.name ?? undefined,
      email: author.email ?? undefined,
      github: author.github ?? undefined,
    })

    return author.github || author.name || 'Unknown'
  }

  /**
   * Check if config exists and is valid
   */
  async isConfigured(projectPath: string): Promise<boolean> {
    const config = await this.readConfig(projectPath)
    return this.validateConfig(config)
  }

  /**
   * Get showMetrics setting from config.
   * Defaults to true for new or existing projects without the setting.
   * @see PRJ-70
   */
  async getShowMetrics(projectPath: string): Promise<boolean> {
    const config = await this.readConfig(projectPath)
    // Default to true if not set
    return config?.showMetrics ?? true
  }

  /**
   * Set showMetrics setting in config.
   * @see PRJ-70
   */
  async setShowMetrics(projectPath: string, showMetrics: boolean): Promise<void> {
    const config = await this.readConfig(projectPath)
    if (config) {
      config.showMetrics = showMetrics
      await this.writeConfig(projectPath, config)
    }
  }

  /**
   * Get configuration with defaults
   * Returns LOCAL config only (projectId, dataPath)
   */
  async getConfigWithDefaults(projectPath: string): Promise<LocalConfig> {
    const config = await this.readConfig(projectPath)
    if (config) {
      return config
    }

    const projectId = pathManager.generateProjectId(projectPath)
    return {
      projectId,
      dataPath: pathManager.getDisplayPath(pathManager.getGlobalProjectPath(projectId)),
    }
  }
}

const configManager = new ConfigManager()
export default configManager
