/**
 * ConfigManager - Resolves the repo locator and prjct-owned project settings.
 *
 * The client file is identity only. All mutable policy is persisted under the
 * global project directory and exposed to callers as one effective config.
 */

import { randomUUID } from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import * as jsonc from 'jsonc-parser'
import { getErrorMessage } from '../errors'
import { deriveProjectId } from '../services/sync/project-identity'
import type { Author } from '../types/commands'
import type { GlobalConfig, LocalConfig } from '../types/config'
import { isFileExistsError, isNotFoundError } from '../types/fs'
import { getTimestamp } from '../utils/date-helper'
import { execFileAsync } from '../utils/exec'
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

/** Mutable project policy lives with prjct state, never in the client repo. */
const PROJECT_SETTINGS_FILE = 'config.json'
const SETTINGS_BASELINE = Symbol('prjct.settingsBaseline')
const SETTINGS_LOCK_STALE_MS = 30_000
const SETTINGS_LOCK_RETRIES = 200

type ConfigRecord = Record<string, unknown>
type SettingsPatch =
  | { kind: 'none' }
  | { kind: 'delete' }
  | { kind: 'set'; value: unknown }
  | { kind: 'merge'; entries: Record<string, SettingsPatch> }

type TrackedLocalConfig = LocalConfig & {
  [SETTINGS_BASELINE]?: ConfigRecord
}

export class ProjectSettingsError extends Error {
  constructor(
    readonly settingsPath: string,
    cause: unknown
  ) {
    super(`Project settings at ${settingsPath} are invalid: ${getErrorMessage(cause)}`, { cause })
    this.name = 'ProjectSettingsError'
  }
}

export class ProjectSettingsConflictError extends Error {
  constructor(readonly paths: string[]) {
    super(
      `Project settings changed concurrently at ${paths.join(', ')}. Re-read the config and retry the update.`
    )
    this.name = 'ProjectSettingsConflictError'
  }
}

export class ProjectSettingsMigrationRequiredError extends Error {
  constructor(readonly recoveredSettings: Readonly<Record<string, unknown>>) {
    super(
      'Legacy project settings exist in Git history but were not imported automatically. ' +
        'Review them with `prjct config migrate-project-settings`, then apply explicitly with ' +
        '`prjct config migrate-project-settings confirm`.'
    )
    this.name = 'ProjectSettingsMigrationRequiredError'
  }
}

function isConfigRecord(value: unknown): value is ConfigRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function buildSettingsPatch(base: unknown, desired: unknown, desiredExists = true): SettingsPatch {
  if (!desiredExists) return { kind: 'delete' }
  if (isDeepStrictEqual(base, desired)) return { kind: 'none' }
  if (isConfigRecord(base) && isConfigRecord(desired)) {
    const keys = new Set([...Object.keys(base), ...Object.keys(desired)])
    const entries = Object.fromEntries(
      [...keys]
        .map((key) => [key, buildSettingsPatch(base[key], desired[key], key in desired)] as const)
        .filter(([, patch]) => patch.kind !== 'none')
    )
    return Object.keys(entries).length === 0 ? { kind: 'none' } : { kind: 'merge', entries }
  }
  return { kind: 'set', value: structuredClone(desired) }
}

function applySettingsPatch(current: unknown, patch: SettingsPatch): unknown {
  if (patch.kind === 'none') return current
  if (patch.kind === 'delete') return undefined
  if (patch.kind === 'set') return structuredClone(patch.value)

  const next: ConfigRecord = isConfigRecord(current) ? structuredClone(current) : {}
  for (const [key, childPatch] of Object.entries(patch.entries)) {
    const value = applySettingsPatch(next[key], childPatch)
    if (childPatch.kind === 'delete') delete next[key]
    else next[key] = value
  }
  return next
}

function conflictingSettingsPaths(
  base: unknown,
  current: unknown,
  patch: SettingsPatch,
  prefix = ''
): string[] {
  if (patch.kind === 'none') return []
  if (patch.kind !== 'merge') {
    const desired = applySettingsPatch(base, patch)
    return !isDeepStrictEqual(base, current) && !isDeepStrictEqual(current, desired)
      ? [prefix || '<root>']
      : []
  }

  const baseRecord = isConfigRecord(base) ? base : {}
  const currentRecord = isConfigRecord(current) ? current : {}
  return Object.entries(patch.entries).flatMap(([key, childPatch]) =>
    conflictingSettingsPaths(
      baseRecord[key],
      currentRecord[key],
      childPatch,
      prefix ? `${prefix}.${key}` : key
    )
  )
}

function validProjectId(projectId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(projectId)
}

function assertValidProjectId(projectId: string): void {
  if (!validProjectId(projectId)) {
    throw new Error(
      `Invalid projectId: expected one safe path segment, received ${JSON.stringify(projectId)}`
    )
  }
}

function trackSettingsBaseline<T extends LocalConfig>(config: T, baseline: ConfigRecord): T {
  Object.defineProperty(config, SETTINGS_BASELINE, {
    value: structuredClone(baseline),
    enumerable: true,
  })
  return config
}

/**
 * mtime-keyed cache shared by the tiny client locator and global settings.
 * The daemon still pays only cheap stats after the first parse; JSONC parsing
 * and reads happen only when either file materially changes.
 */
const configCache = new Map<string, { signature: string; config: Partial<LocalConfig> | null }>()
const effectiveConfigCache = new Map<
  string,
  {
    locator: Partial<LocalConfig>
    settings: Partial<LocalConfig> | null
    config: LocalConfig
  }
>()

async function readConfigFile(file: string): Promise<Partial<LocalConfig> | null> {
  // statSync is deliberate on this tiny hot path: it detects external locator
  // replacement immediately and avoids async promise/event-loop overhead.
  const stat = fsSync.statSync(file, { throwIfNoEntry: false })
  if (!stat) {
    configCache.delete(file)
    return null
  }
  const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
  const cached = configCache.get(file)
  if (cached && cached.signature === signature) return cached.config

  const content = await fs.readFile(file, 'utf-8')
  const config = parseJsonc<Partial<LocalConfig>>(content)
  if (configCache.size > 64) configCache.clear()
  configCache.set(file, { signature, config })
  return config
}

async function writeJsonIfChanged(file: string, value: unknown): Promise<void> {
  const next = `${JSON.stringify(value, null, 2)}\n`
  const current = await fs.readFile(file, 'utf-8').catch(() => '')
  if (current === next) return
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`
  )
  try {
    await fs.writeFile(temporary, next, { encoding: 'utf-8', flag: 'wx', mode: 0o600 })
    await fs.rename(temporary, file)
    configCache.delete(file)
  } finally {
    await fs.unlink(temporary).catch(() => undefined)
  }
}

async function acquireSettingsLock(
  settingsPath: string,
  attempt = 0
): Promise<() => Promise<void>> {
  const lockPath = `${settingsPath}.lock`
  await fs.mkdir(path.dirname(lockPath), { recursive: true })
  const token = `${process.pid}:${randomUUID()}`
  try {
    const handle = await fs.open(lockPath, 'wx', 0o600)
    await handle.writeFile(token, 'utf-8')
    return async () => {
      await handle.close()
      const owner = await fs.readFile(lockPath, 'utf-8').catch(() => '')
      if (owner === token) await fs.unlink(lockPath).catch(() => undefined)
    }
  } catch (error) {
    if (!isFileExistsError(error)) throw error
    const stat = await fs.stat(lockPath).catch(() => null)
    if (stat && Date.now() - stat.mtimeMs > SETTINGS_LOCK_STALE_MS) {
      await fs.unlink(lockPath).catch(() => undefined)
    }
    if (attempt >= SETTINGS_LOCK_RETRIES) {
      throw new Error(`Timed out waiting for project settings lock at ${lockPath}`)
    }
    await delay(Math.min(5 + attempt, 25))
    return acquireSettingsLock(settingsPath, attempt + 1)
  }
}

async function withSettingsLock<T>(settingsPath: string, run: () => Promise<T>): Promise<T> {
  const release = await acquireSettingsLock(settingsPath)
  try {
    return await run()
  } finally {
    await release()
  }
}

async function recoverLegacySettingsFromGit(
  projectPath: string,
  projectId: string
): Promise<ConfigRecord | null> {
  const locatorPath = pathManager.getLocalConfigPath(projectPath)
  const relative = path.relative(projectPath, locatorPath).split(path.sep).join('/')
  if (!relative || relative.startsWith('../')) return null

  const commits = await execFileAsync(
    'git',
    ['log', '--format=%H', '--follow', '-n', '50', '--', relative],
    { cwd: projectPath, timeout: 5_000 }
  )
    .then(({ stdout }) => stdout.split('\n').filter(Boolean))
    .catch(() => [])

  const inspectCommit = async (index: number): Promise<ConfigRecord | null> => {
    const commit = commits[index]
    if (!commit) return null
    const prior = await execFileAsync('git', ['show', `${commit}:${relative}`], {
      cwd: projectPath,
      timeout: 5_000,
    })
      .then(({ stdout }) => parseJsonc<Partial<LocalConfig>>(stdout))
      .catch(() => null)
    if (prior?.projectId === projectId) {
      const { projectId: _projectId, dataPath: _dataPath, ...settings } = prior
      if (Object.keys(settings).length > 0) return settings
    }
    return inspectCommit(index + 1)
  }

  return inspectCommit(0)
}

class ConfigManager {
  private async readLocator(projectPath: string): Promise<Partial<LocalConfig> | null> {
    const locatorPath = pathManager.getLocalConfigPath(projectPath)
    try {
      return await readConfigFile(locatorPath)
    } catch (error) {
      if (isNotFoundError(error)) {
        configCache.delete(locatorPath)
        return null
      }
      console.warn(`Warning: Could not read config at ${projectPath}: ${getErrorMessage(error)}`)
      return null
    }
  }

  /**
   * Read the project configuration file
   * Supports both .json and .jsonc formats (with comments)
   */
  async readConfig(projectPath: string): Promise<LocalConfig | null> {
    const locatorPath = pathManager.getLocalConfigPath(projectPath)
    const locator = await this.readLocator(projectPath)
    if (!locator?.projectId) return locator as LocalConfig | null
    assertValidProjectId(locator.projectId)
    const settingsPath = this.getProjectSettingsPath(locator.projectId)
    const settings = await (async () => {
      try {
        return await readConfigFile(settingsPath)
      } catch (error) {
        if (isNotFoundError(error)) return null
        throw new ProjectSettingsError(settingsPath, error)
      }
    })()
    const cached = effectiveConfigCache.get(locatorPath)
    if (cached?.locator === locator && cached.settings === settings) return cached.config
    // Global settings are authoritative. Mutable fields left in a legacy
    // locator are only a migration fallback until the first config write.
    const config = {
      ...locator,
      ...settings,
      projectId: locator.projectId,
      dataPath:
        locator.dataPath ??
        pathManager.getDisplayPath(pathManager.getGlobalProjectPath(locator.projectId)),
    } as TrackedLocalConfig
    trackSettingsBaseline(config, (settings ?? {}) as ConfigRecord)
    if (effectiveConfigCache.size > 32) effectiveConfigCache.clear()
    effectiveConfigCache.set(locatorPath, { locator, settings, config })
    return config
  }

  /**
   * Persist mutable project settings globally. The client repo keeps only the
   * stable locator needed for clone/worktree identity; once normalized, a
   * policy change never touches its bytes or invalidates source caches.
   */
  async writeConfig(projectPath: string, config: LocalConfig): Promise<void> {
    const { projectId, dataPath, ...settings } = config
    if (!projectId || !dataPath) throw new Error('Project config requires projectId and dataPath')
    assertValidProjectId(projectId)
    const settingsPath = this.getProjectSettingsPath(projectId)
    const baseline = (config as TrackedLocalConfig)[SETTINGS_BASELINE]
    const desired = Object.fromEntries(Object.entries(settings))

    // Write the authority first. If this fails, the legacy client config stays
    // intact and no settings are lost during migration.
    await withSettingsLock(settingsPath, async () => {
      const current = ((await readConfigFile(settingsPath)) ?? {}) as ConfigRecord
      const patch = baseline ? buildSettingsPatch(baseline, desired) : null
      const conflicts = patch ? conflictingSettingsPaths(baseline, current, patch) : []
      if (conflicts.length > 0) throw new ProjectSettingsConflictError(conflicts)
      const next = patch ? applySettingsPatch(current, patch) : desired
      await writeJsonIfChanged(settingsPath, next)
    })

    const locatorPath = pathManager.getLocalConfigPath(projectPath)
    await writeJsonIfChanged(locatorPath, { projectId, dataPath })
    effectiveConfigCache.delete(locatorPath)
  }

  getProjectSettingsPath(projectId: string): string {
    assertValidProjectId(projectId)
    const projectsRoot = path.resolve(pathManager.globalProjectsDir)
    const settingsPath = path.resolve(projectsRoot, projectId, PROJECT_SETTINGS_FILE)
    const relative = path.relative(projectsRoot, settingsPath)
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Project settings path escapes the global project directory: ${projectId}`)
    }
    return settingsPath
  }

  /**
   * One-time upgrade for projects created before mutable settings moved out of
   * the client repository. Global values win if both copies already exist.
   */
  async migrateLegacyProjectSettings(
    projectPath: string,
    options: { allowGitRecovery?: boolean } = {}
  ): Promise<boolean> {
    const locator = await readConfigFile(pathManager.getLocalConfigPath(projectPath))
    if (!locator?.projectId) return false
    assertValidProjectId(locator.projectId)
    const { projectId: _projectId, dataPath: _dataPath, ...legacySettings } = locator
    const settingsPath = this.getProjectSettingsPath(locator.projectId)
    const existingSettings = await readConfigFile(settingsPath)
    const recoveredSettings =
      Object.keys(legacySettings).length > 0
        ? legacySettings
        : existingSettings === null
          ? await recoverLegacySettingsFromGit(projectPath, locator.projectId)
          : null
    if (!recoveredSettings) return false
    if (
      Object.keys(legacySettings).length === 0 &&
      existingSettings === null &&
      !options.allowGitRecovery
    ) {
      throw new ProjectSettingsMigrationRequiredError(recoveredSettings)
    }

    const config = trackSettingsBaseline(
      {
        ...locator,
        ...recoveredSettings,
        ...existingSettings,
        projectId: locator.projectId,
        dataPath:
          locator.dataPath ??
          pathManager.getDisplayPath(pathManager.getGlobalProjectPath(locator.projectId)),
      } as LocalConfig,
      (existingSettings ?? {}) as ConfigRecord
    )
    await this.writeConfig(projectPath, config)
    return true
  }

  async previewLegacyProjectSettings(projectPath: string): Promise<ConfigRecord | null> {
    const locator = await this.readLocator(projectPath)
    if (!locator?.projectId) return null
    assertValidProjectId(locator.projectId)
    if ((await readConfigFile(this.getProjectSettingsPath(locator.projectId))) !== null) return null
    return recoverLegacySettingsFromGit(projectPath, locator.projectId)
  }

  /**
   * Read global project metadata (authors, version and sync timestamps).
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
   * Write global project metadata.
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
    const locator = await this.readLocator(projectPath)
    if (locator?.projectId && validProjectId(locator.projectId)) {
      return locator.projectId
    }

    // Worktree fallback: check if this is a child worktree and read main config
    try {
      const { worktreeService } = await import('../services/worktree-service')
      const worktreeInfo = await worktreeService.detect(projectPath)
      if (worktreeInfo) {
        const mainPath = await worktreeService.getMainWorktree(projectPath)
        if (mainPath !== projectPath) {
          const mainLocator = await this.readLocator(mainPath)
          if (mainLocator?.projectId && validProjectId(mainLocator.projectId)) {
            return mainLocator.projectId
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
