/**
 * UpdateChecker - Checks for package updates from npm registry
 *
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import chalk from 'chalk'
import { getErrorMessage } from '../types/fs'
import { fileExists, readJson, writeJson } from '../utils/file-helper'
import { PACKAGE_ROOT } from '../utils/version'
import pathManager from './path-manager'

interface UpdateCache {
  lastCheck: number
  latestVersion: string
}

interface UpdateResult {
  updateAvailable: boolean
  currentVersion: string
  latestVersion: string
}

class UpdateChecker {
  packageName: string
  cacheDir: string
  cacheFile: string
  checkInterval: number

  constructor() {
    this.packageName = 'prjct-cli'
    // Via pathManager so PRJCT_CLI_HOME is honored (prod === ~/.prjct-cli/config).
    this.cacheDir = pathManager.globalConfigDir
    this.cacheFile = path.join(this.cacheDir, 'update-cache.json')
    this.checkInterval = 24 * 60 * 60 * 1000 // 24 hours in milliseconds
  }

  /**
   * Get current installed version from package.json
   */
  async getCurrentVersion(): Promise<string | null> {
    try {
      const packageJsonPath = path.join(__dirname, '..', '..', 'package.json')
      const packageJson = await readJson<{ version?: string }>(packageJsonPath)
      return packageJson?.version ?? null
    } catch (error) {
      console.error('Error reading package version:', getErrorMessage(error))
      return null
    }
  }

  /**
   * Fetch latest version from npm registry (never from monorepo / local package.json).
   * Cache-busting query + no-cache headers so upgrade always sees the published dist-tag.
   */
  async getLatestVersion(): Promise<string> {
    return new Promise((resolve, reject) => {
      const bust = Date.now()
      const options = {
        hostname: 'registry.npmjs.org',
        path: `/${this.packageName}/latest?prjct_bust=${bust}`,
        method: 'GET',
        headers: {
          'User-Agent': 'prjct-cli-update-checker',
          Accept: 'application/json',
          'Cache-Control': 'no-cache, no-store',
          Pragma: 'no-cache',
        },
      }

      const req = https.request(options, (res) => {
        const chunks: string[] = []

        res.on('data', (chunk) => {
          chunks.push(String(chunk))
        })

        res.on('end', () => {
          try {
            if (res.statusCode === 200) {
              const packageData = JSON.parse(chunks.join(''))
              const version =
                typeof packageData.version === 'string' ? packageData.version.trim() : ''
              if (!/^\d+\.\d+\.\d+/.test(version)) {
                reject(new Error(`npm registry returned invalid version: ${version || '(empty)'}`))
                return
              }
              resolve(version)
            } else {
              reject(new Error(`npm registry returned status ${res.statusCode}`))
            }
          } catch (error) {
            reject(error)
          }
        })
      })

      req.on('error', (error) => {
        reject(error)
      })

      req.setTimeout(5000, () => {
        req.destroy()
        reject(new Error('Request timeout'))
      })

      req.end()
    })
  }

  /**
   * Compare two semantic versions
   * Returns: 1 if v1 > v2, -1 if v1 < v2, 0 if equal
   */
  compareVersions(v1: string, v2: string): number {
    const parts1 = v1.split('.').map(Number)
    const parts2 = v2.split('.').map(Number)

    return (
      [0, 1, 2]
        .map((index) => Math.sign((parts1[index] || 0) - (parts2[index] || 0)))
        .find((comparison) => comparison !== 0) ?? 0
    )
  }

  /**
   * Read cache file
   */
  async readCache(): Promise<UpdateCache | null> {
    try {
      if (await fileExists(this.cacheFile)) {
        return await readJson<UpdateCache>(this.cacheFile)
      }
    } catch (_error) {
      // Cache file doesn't exist or is corrupted - expected
    }
    return null
  }

  /**
   * Write cache file
   */
  async writeCache(data: UpdateCache): Promise<void> {
    try {
      await writeJson(this.cacheFile, data)
    } catch (_error) {
      // Fail silently - cache is not critical
    }
  }

  /**
   * Check if update is available (respects 24-hour cache)
   * Returns: { updateAvailable: boolean, currentVersion: string, latestVersion: string } or null
   */
  async checkForUpdates(): Promise<UpdateResult | null> {
    try {
      const currentVersion = await this.getCurrentVersion()
      if (!currentVersion) {
        return null
      }

      // Check cache first
      const cache = await this.readCache()
      const now = Date.now()

      if (cache?.lastCheck && now - cache.lastCheck < this.checkInterval) {
        // Cache is still valid
        if (cache.latestVersion && this.compareVersions(cache.latestVersion, currentVersion) > 0) {
          return {
            updateAvailable: true,
            currentVersion,
            latestVersion: cache.latestVersion,
          }
        }
        return {
          updateAvailable: false,
          currentVersion,
          latestVersion: currentVersion,
        }
      }

      // Cache expired or doesn't exist, fetch from npm
      const latestVersion = await this.getLatestVersion()

      // Update cache
      await this.writeCache({
        lastCheck: now,
        latestVersion,
      })

      // Compare versions
      const updateAvailable = this.compareVersions(latestVersion, currentVersion) > 0

      return {
        updateAvailable,
        currentVersion,
        latestVersion,
      }
    } catch (_error) {
      // Network error or other issue - fail silently (expected)
      // Return null to indicate check couldn't be performed
      return null
    }
  }

  /**
   * Get formatted update notification message
   */
  async getUpdateNotification(): Promise<string | null> {
    const result = await this.checkForUpdates()
    if (!result || !result.updateAvailable) return null
    return formatUpdateBanner(result.currentVersion, result.latestVersion)
  }
}

export default UpdateChecker

// ---------------------------------------------------------------------------
// Sync surface for the CLI exit handler
// ---------------------------------------------------------------------------
//
// The CLI prints the update banner from a `process.on('exit', ...)` handler
// so the message appears AFTER the command's own output. `'exit'` is a
// synchronous event — no awaits, no async I/O — so the lookup has to be
// sync. We read the cache file with `fs.readFileSync` instead of going
// through the async `UpdateChecker` instance.
//
// Cache freshness is maintained by `triggerBackgroundRefreshIfStale()` which
// spawns an unref'd child process to do the network fetch without delaying
// the user-visible command.

// Lazy: resolve via pathManager at call time (honors PRJCT_CLI_HOME and
// test-time setGlobalBaseDir). Production === ~/.prjct-cli/config, unchanged.
const updateCacheDir = (): string => pathManager.globalConfigDir
const updateCacheFile = (): string => path.join(updateCacheDir(), 'update-cache.json')
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  return (
    [0, 1, 2]
      .map((index) => Math.sign((pa[index] || 0) - (pb[index] || 0)))
      .find((comparison) => comparison !== 0) ?? 0
  )
}

function readCacheSync(): { lastCheck: number; latestVersion: string } | null {
  try {
    const raw = fs.readFileSync(updateCacheFile(), 'utf-8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function formatUpdateBanner(current: string, latest: string): string {
  const headline = `Update available! ${current} → ${latest}`
  // ONE command that updates every install AND consolidates parallel copies.
  // The old hardcoded `npm install -g` ignored the user's actual package
  // manager and is exactly what creates the multi-install footgun.
  const cmd = 'prjct upgrade'
  // Pad to whatever length the longest visible line needs — do this
  // dynamically rather than baking widths into the literal so locale
  // changes don't cause misalignment.
  const inner = Math.max(headline.length, `Run: ${cmd}`.length) + 4
  const top = `┌${'─'.repeat(inner)}┐`
  const bot = `└${'─'.repeat(inner)}┘`
  const pad = (s: string): string => `│  ${s}${' '.repeat(inner - s.length - 2)}│`
  return [
    '',
    chalk.yellow(top),
    chalk.yellow(pad('')),
    chalk.yellow(`│  ${chalk.bold(headline)}${' '.repeat(inner - headline.length - 2)}│`),
    chalk.yellow(`│  Run: ${chalk.cyan(cmd)}${' '.repeat(inner - cmd.length - 7)}│`),
    chalk.yellow(pad('')),
    chalk.yellow(bot),
    '',
  ].join('\n')
}

/**
 * Read the cached latest version and return a printable banner if the
 * installed version is older. Synchronous — safe to call from a
 * `process.on('exit')` handler.
 *
 * Returns null when the cache is missing, the version is current, or
 * any read/parse fails.
 */
export function getUpdateNotificationSync(currentVersion: string): string | null {
  if (!currentVersion) return null
  const cache = readCacheSync()
  if (!cache?.latestVersion) return null
  if (compareSemver(cache.latestVersion, currentVersion) <= 0) return null
  return formatUpdateBanner(currentVersion, cache.latestVersion)
}

/**
 * If the cache is older than the check interval (or missing), spawn a
 * detached child process that refreshes the cache from npm. The child
 * is unref'd so the main process can exit without waiting. The next
 * `prjct` invocation will see the fresh cache and (if relevant) show
 * the banner.
 */
export function triggerBackgroundRefreshIfStale(): void {
  try {
    const cache = readCacheSync()
    if (cache?.lastCheck && Date.now() - cache.lastCheck < CHECK_INTERVAL_MS) return
  } catch {
    // proceed with refresh
  }

  try {
    fs.mkdirSync(updateCacheDir(), { recursive: true })
  } catch {
    return
  }

  // Spawn a separate, on-disk script (not `node -e <string>`).
  // Avoids the dynamic-code-execution pattern that supply-chain scanners
  // flag as suspicious. Behaviour is identical — only the delivery
  // mechanism changed.
  const scriptPath = path.join(PACKAGE_ROOT, 'assets', 'scripts', 'refresh-update.mjs')
  if (!fs.existsSync(scriptPath)) return
  try {
    const child = spawn(process.execPath, [scriptPath, updateCacheFile()], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
  } catch {
    // best-effort
  }
}
