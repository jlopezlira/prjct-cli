/**
 * Command Installer
 * Installs prjct global config in Claude Code and other AI CLI agents.
 *
 * Simplified: No more router, templates, or module system.
 * prjct = data helper. Skills handle workflows natively.
 *
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { getErrorMessage } from '../types/fs'
import type {
  CheckResult,
  GlobalConfigResult,
  InstallResult,
  SyncResult,
  UninstallResult,
} from '../types/infrastructure'
import { fileExists } from '../utils/file-helper'
import { getActiveProvider } from './ai-provider'
import { installGlobalConfig as installGlobalConfigImpl } from './command-installer/global-config'
import { resolveUserHome, resolveUserPath } from './user-home'

// Re-export the installGlobalConfig used by external callers (e.g. update.ts).
// Defined here as a thin wrapper rather than a re-export for clarity.
export async function installGlobalConfig(): Promise<GlobalConfigResult> {
  return installGlobalConfigImpl()
}

export class CommandInstaller {
  commandsPath = ''
  configPath = ''
  private _initialized = false

  private async ensureInit(): Promise<void> {
    if (this._initialized) return

    const activeProvider = await getActiveProvider()

    this.configPath = activeProvider.configDir ?? ''
    this.commandsPath = this.configPath ? path.join(this.configPath, 'commands') : ''
    this._initialized = true
  }

  async detectActiveProvider(): Promise<boolean> {
    await this.ensureInit()
    return fileExists(this.configPath)
  }

  /**
   * Install commands to active AI agent (no-op — router deprecated)
   */
  async installCommands(): Promise<InstallResult> {
    const providerDetected = await this.detectActiveProvider()
    const activeProvider = await getActiveProvider()

    if (!providerDetected) {
      return {
        success: false,
        error: `${activeProvider.displayName} not detected. Please install it first.`,
      }
    }

    await this.cleanupRouter()

    return { success: true, installed: [], path: this.commandsPath }
  }

  async uninstallCommands(): Promise<UninstallResult> {
    try {
      const uninstalled: string[] = []

      await this.ensureInit()
      for (const routerFile of ['p.md', 'p.toml']) {
        const routerPath = path.join(this.commandsPath, routerFile)
        try {
          await fs.unlink(routerPath)
          uninstalled.push(routerFile)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            return { success: false, error: getErrorMessage(error) }
          }
        }
      }

      return { success: true, uninstalled }
    } catch (error) {
      return { success: false, error: getErrorMessage(error) }
    }
  }

  /**
   * Check if commands are installed (skills-based — no router needed)
   */
  async checkInstallation(): Promise<CheckResult> {
    const providerDetected = await this.detectActiveProvider()

    if (!providerDetected) {
      return { installed: false, providerDetected: false }
    }

    return {
      installed: true,
      providerDetected: true,
      commands: [],
      path: this.commandsPath,
    }
  }

  async getInstallPath(): Promise<string> {
    await this.ensureInit()
    return this.commandsPath
  }

  /**
   * Sync commands - cleanup legacy router + update global config
   */
  async syncCommands(): Promise<SyncResult> {
    const providerDetected = await this.detectActiveProvider()

    if (!providerDetected) {
      return {
        success: false,
        error: 'AI agent not detected',
        added: 0,
        updated: 0,
        removed: 0,
      }
    }

    try {
      const cleaned = await this.cleanupRouter()

      return {
        success: true,
        added: 0,
        updated: 0,
        removed: cleaned ? 1 : 0,
      } as SyncResult
    } catch (error) {
      return {
        success: false,
        error: getErrorMessage(error),
        added: 0,
        updated: 0,
        removed: 0,
      }
    }
  }

  /**
   * Remove legacy router files (p.md, p.toml) from commands directory.
   */
  async cleanupRouter(): Promise<boolean> {
    await this.ensureInit()
    let cleaned = false

    for (const routerFile of ['p.md', 'p.toml']) {
      const routerPath = path.join(this.commandsPath, routerFile)
      try {
        await fs.unlink(routerPath)
        cleaned = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          // Log but don't fail
        }
      }
    }

    return cleaned
  }

  /**
   * Remove legacy ~/.claude/commands/p/ subdirectory (pre-v1.25 architecture).
   */
  async cleanupLegacyCommands(): Promise<boolean> {
    await this.ensureInit()
    const pSubdirPath = path.join(this.commandsPath, 'p')
    try {
      const stat = await fs.stat(pSubdirPath).catch(() => null)
      if (stat?.isDirectory()) {
        await fs.rm(pSubdirPath, { recursive: true, force: true })
        return true
      }
    } catch {
      // already gone
    }
    return false
  }

  async installGlobalConfig(): Promise<GlobalConfigResult> {
    return installGlobalConfigImpl()
  }

  /**
   * Full legacy cleanup — removes ALL stale prjct artifacts from all providers.
   * Called during `prjct update` to ensure clean migration.
   */
  async cleanupAllLegacy(): Promise<{ cleaned: string[] }> {
    const home = resolveUserHome()
    const cleaned: string[] = []

    const legacyFiles = [
      path.join(home, '.claude', 'commands', 'p.md'),
      path.join(home, '.claude', 'commands', 'p.toml'),
      path.join(home, '.gemini', 'commands', 'p.md'),
      path.join(home, '.gemini', 'commands', 'p.toml'),
    ]

    for (const filePath of legacyFiles) {
      try {
        await fs.unlink(filePath)
        cleaned.push(filePath)
      } catch {
        // Already gone
      }
    }

    const legacyDirs = [
      path.join(home, '.claude', 'commands', 'p'),
      path.join(home, '.gemini', 'commands', 'p'),
    ]

    for (const dirPath of legacyDirs) {
      try {
        const stat = await fs.stat(dirPath).catch(() => null)
        if (stat?.isDirectory()) {
          await fs.rm(dirPath, { recursive: true, force: true })
          cleaned.push(dirPath)
        }
      } catch {
        // Already gone
      }
    }

    const brewLegacy = [path.join(home, '.prjct-cli', 'config', 'homebrew-migrated')]

    for (const filePath of brewLegacy) {
      try {
        await fs.unlink(filePath)
        cleaned.push(filePath)
      } catch {
        // Already gone
      }
    }

    return { cleaned }
  }
}

/**
 * Get installation paths for all providers
 */
export function getProviderPaths(): {
  claude: { commands: string; config: string; router: string }
  gemini: { commands: string; config: string; router: string }
} {
  return {
    claude: {
      commands: resolveUserPath('.claude', 'commands'),
      config: resolveUserPath('.claude'),
      router: resolveUserPath('.claude', 'commands', 'p.md'),
    },
    gemini: {
      commands: resolveUserPath('.gemini', 'commands'),
      config: resolveUserPath('.gemini'),
      router: resolveUserPath('.gemini', 'commands', 'p.toml'),
    },
  }
}

const commandInstaller = new CommandInstaller()
export default commandInstaller
