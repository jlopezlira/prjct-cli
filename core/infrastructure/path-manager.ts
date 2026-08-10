/**
 * PathManager - Manages project paths between local and global storage
 *
 * Key responsibilities:
 * - Generate unique project identifiers from project paths
 * - Manage paths between local project and global storage
 * - Ensure directory structures exist
 * - Detect monorepos (delegates to ./path-manager/monorepo)
 *
 */

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { MonorepoInfo, MonorepoPackage } from '../types/infrastructure'
import type { SessionInfo } from '../types/session'
import * as dateHelper from '../utils/date-helper'
import * as fileHelper from '../utils/file-helper'
import { resolveCliHome } from './cli-home'
import {
  detectMonorepo,
  discoverMonorepoPackages,
  findContainingPackage,
  findMonorepoRoot,
} from './path-manager/monorepo'
import { resolveUserHome, resolveUserPath } from './user-home'

class PathManager {
  globalBaseDir: string
  globalConfigDir: string

  constructor() {
    // PRJCT_CLI_HOME: Override global storage location (default: ~/.prjct-cli).
    // NOTE: resolved at construction (singleton import time) — tests must set
    // the env var in the preload, before any prjct module is imported. The
    // per-call consumers (global-config, secure-key, …) use resolveCliHome()
    // directly so late mutation still works there.
    this.globalBaseDir = resolveCliHome()
    this.globalConfigDir = path.join(this.globalBaseDir, 'config')
  }

  /**
   * Global projects dir. Honors `PRJCT_PROJECTS_DIR` (test isolation — point it
   * at a temp dir so a test run never writes into the real
   * `~/.prjct-cli/projects`), else `<globalBaseDir>/projects`. Resolved at
   * ACCESS time, so tests that set the env var in `beforeEach` (i.e. after
   * import) are honored. Production never sets `PRJCT_PROJECTS_DIR`, so this is
   * unchanged there. See mem_1560 (test vault pollution root cause).
   */
  get globalProjectsDir(): string {
    const override = process.env.PRJCT_PROJECTS_DIR
    return override ? path.resolve(override) : path.join(this.globalBaseDir, 'projects')
  }

  /**
   * Override global storage location (primarily for tests and sandboxed environments).
   */
  setGlobalBaseDir(globalBaseDir: string): void {
    this.globalBaseDir = path.resolve(globalBaseDir)
    this.globalConfigDir = path.join(this.globalBaseDir, 'config')
  }

  /**
   * Generate a unique project ID using UUID.
   * Standard UUID format for PostgreSQL consistency.
   */
  generateProjectId(_projectPath: string): string {
    return crypto.randomUUID()
  }

  // Core paths

  getGlobalBasePath(): string {
    return this.globalBaseDir
  }

  getGlobalProjectPath(projectId: string): string {
    return path.join(this.globalProjectsDir, projectId)
  }

  getLocalConfigPath(projectPath: string): string {
    return path.join(projectPath, '.prjct', 'prjct.config.json')
  }

  /**
   * Stores authors and other system data that shouldn't be versioned.
   */
  getGlobalProjectConfigPath(projectId: string): string {
    return path.join(this.getGlobalProjectPath(projectId), 'project.json')
  }

  getLegacyPrjctPath(projectPath: string): string {
    return path.join(projectPath, '.prjct')
  }

  async hasLegacyStructure(projectPath: string): Promise<boolean> {
    return await fileHelper.dirExists(this.getLegacyPrjctPath(projectPath))
  }

  async hasConfig(projectPath: string): Promise<boolean> {
    return await fileHelper.fileExists(this.getLocalConfigPath(projectPath))
  }

  async ensureGlobalStructure(): Promise<void> {
    await fileHelper.ensureDir(this.globalBaseDir)
    await fileHelper.ensureDir(this.globalProjectsDir)
    await fileHelper.ensureDir(this.globalConfigDir)
  }

  /**
   * Creates the layered directory structure for a project.
   */
  async ensureProjectStructure(projectId: string): Promise<string> {
    await this.ensureGlobalStructure()

    const projectPath = this.getGlobalProjectPath(projectId)
    // Legacy write-through dirs (core/, progress/, planning/) are gone:
    // nothing read those .md/.json stubs and they orphaned as garbage.
    // State lives in SQLite; analysis/ + memory/ have real consumers and
    // sessions/ backs context-save.
    const layers = ['analysis', 'memory']

    for (const layer of layers) {
      await fileHelper.ensureDir(path.join(projectPath, layer))
    }

    await fileHelper.ensureDir(path.join(projectPath, 'sessions'))

    return projectPath
  }

  // Sessions

  /**
   * Creates hierarchical structure: sessions/YYYY/MM/DD/
   */
  getSessionPath(projectId: string, date: Date = new Date()): string {
    const { year, month, day } = dateHelper.getYearMonthDay(date)
    return path.join(this.getGlobalProjectPath(projectId), 'sessions', year, month, day)
  }

  getCurrentSessionPath(projectId: string): string {
    return this.getSessionPath(projectId, new Date())
  }

  async ensureSessionPath(projectId: string, date: Date = new Date()): Promise<string> {
    const sessionPath = this.getSessionPath(projectId, date)
    await fileHelper.ensureDir(sessionPath)
    return sessionPath
  }

  async listSessions(
    projectId: string,
    year: number | null = null,
    month: number | null = null
  ): Promise<SessionInfo[]> {
    const sessionsDir = path.join(this.getGlobalProjectPath(projectId), 'sessions')
    const sessions: SessionInfo[] = []

    try {
      const years = await fs.readdir(sessionsDir, { withFileTypes: true })

      for (const yearEntry of years) {
        if (!yearEntry.isDirectory()) continue
        if (year && yearEntry.name !== year.toString()) continue

        const yearPath = path.join(sessionsDir, yearEntry.name)
        const months = await fs.readdir(yearPath, { withFileTypes: true })

        for (const monthEntry of months) {
          if (!monthEntry.isDirectory()) continue
          if (month && monthEntry.name !== month.toString().padStart(2, '0')) continue

          const monthPath = path.join(yearPath, monthEntry.name)
          const days = await fs.readdir(monthPath, { withFileTypes: true })

          for (const dayEntry of days) {
            if (!dayEntry.isDirectory()) continue

            sessions.push({
              year: yearEntry.name,
              month: monthEntry.name,
              day: dayEntry.name,
              path: path.join(monthPath, dayEntry.name),
              date: new Date(`${yearEntry.name}-${monthEntry.name}-${dayEntry.name}`),
            })
          }
        }
      }

      sessions.sort((a, b) => b.date.getTime() - a.date.getTime())
      return sessions
    } catch {
      // Sessions directory might not exist - expected for new projects
      return []
    }
  }

  async getSessionsInRange(
    projectId: string,
    fromDate: Date,
    toDate: Date = new Date()
  ): Promise<SessionInfo[]> {
    const allSessions = await this.listSessions(projectId)
    return allSessions.filter((session) => session.date >= fromDate && session.date <= toDate)
  }

  // Misc paths

  getFilePath(projectId: string, layer: string, filename: string): string {
    return path.join(this.getGlobalProjectPath(projectId), layer, filename)
  }

  async listProjects(): Promise<string[]> {
    try {
      await this.ensureGlobalStructure()
      const entries = await fs.readdir(this.globalProjectsDir, { withFileTypes: true })
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch {
      return []
    }
  }

  async projectExists(projectId: string): Promise<boolean> {
    return await fileHelper.dirExists(this.getGlobalProjectPath(projectId))
  }

  /**
   * Get the relative path from home directory for display
   */
  getDisplayPath(absolutePath: string): string {
    const homeDir = resolveUserHome()
    if (absolutePath.startsWith(homeDir)) return absolutePath.replace(homeDir, '~')
    return absolutePath
  }

  getAuthConfigPath(): string {
    return path.join(this.globalConfigDir, 'auth.json')
  }

  getSyncPendingPath(projectId: string): string {
    return path.join(this.getGlobalProjectPath(projectId), 'sync', 'pending.json')
  }

  getLastSyncPath(projectId: string): string {
    return path.join(this.getGlobalProjectPath(projectId), 'sync', 'last-sync.json')
  }

  /**
   * Used to indicate when prjct CLI is actively running
   */
  getRunningStatusPath(): string {
    return path.join(this.globalBaseDir, '.running')
  }

  /** Global cache dir (~/.prjct-cli/cache by default; honors PRJCT_CLI_HOME). */
  getCachePath(): string {
    return path.join(this.globalBaseDir, 'cache')
  }

  /** Global state dir (~/.prjct-cli/state by default; honors PRJCT_CLI_HOME). */
  getStatePath(): string {
    return path.join(this.globalBaseDir, 'state')
  }

  /** Global statusline dir (~/.prjct-cli/statusline; honors PRJCT_CLI_HOME). */
  getStatusLinePath(): string {
    return path.join(this.globalBaseDir, 'statusline')
  }

  /**
   * Get the Claude/Gemini directory path (~/.claude or ~/.gemini)
   */
  async getAgentDir(): Promise<string> {
    const provider = await require('./ai-provider').getActiveProvider()
    return provider.configDir
  }

  /**
   * Get the agent settings file path (~/.claude/settings.json or ~/.gemini/settings.json)
   */
  async getAgentSettingsPath(): Promise<string> {
    const provider = await require('./ai-provider').getActiveProvider()
    const aiProvider = require('./ai-provider')
    return aiProvider.getGlobalSettingsPath(provider.name)
  }

  getClaudeDir(): string {
    return resolveUserPath('.claude')
  }

  getClaudeSettingsPath(): string {
    return path.join(this.getClaudeDir(), 'settings.json')
  }

  getStoragePath(projectId: string, filename: string): string {
    return path.join(this.getGlobalProjectPath(projectId), 'storage', filename)
  }

  getContextPath(projectId: string): string {
    return path.join(this.getGlobalProjectPath(projectId), 'context')
  }

  // Monorepo (delegates to ./path-manager/monorepo)

  async detectMonorepo(projectPath: string): Promise<MonorepoInfo> {
    return detectMonorepo(projectPath)
  }

  async discoverMonorepoPackages(
    rootPath: string,
    type: MonorepoInfo['type']
  ): Promise<MonorepoPackage[]> {
    return discoverMonorepoPackages(rootPath, type)
  }

  async findContainingPackage(
    currentPath: string,
    monoInfo: MonorepoInfo
  ): Promise<MonorepoPackage | null> {
    return findContainingPackage(currentPath, monoInfo)
  }

  async findMonorepoRoot(startPath: string): Promise<string | null> {
    return findMonorepoRoot(startPath)
  }
}

const pathManager = new PathManager()
export default pathManager
