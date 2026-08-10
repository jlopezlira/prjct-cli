/**
 * HooksService - Git hooks integration for auto-sync
 *
 * Manages git hooks that automatically sync prjct context on
 * commit and checkout. Supports multiple hook managers:
 * - lefthook
 * - husky
 * - direct .git/hooks/ scripts
 *
 * @see PRJ-128
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import chalk from 'chalk'
import configManager from '../infrastructure/config-manager'
import { prjctDb } from '../storage/database'
import { getErrorMessage } from '../types/fs'
import type { HookName, HookStrategy } from '../types/services/extracted'
import { fileExists } from '../utils/file-helper'
import out from '../utils/output'
import {
  detectHookManagers,
  installDirect,
  installHusky,
  installLefthook,
  selectStrategy,
  uninstallDirect,
  uninstallHusky,
  uninstallLefthook,
} from './hooks-service/strategies'

interface HookConfig {
  enabled: boolean
  strategy: HookStrategy
  hooks: HookName[]
  installedAt?: string
}

interface HooksStatusResult {
  installed: boolean
  strategy: HookStrategy | null
  hooks: Array<{ name: HookName; installed: boolean; path: string }>
  detectedManagers: HookStrategy[]
}

interface HooksInstallResult {
  success: boolean
  strategy: HookStrategy
  hooksInstalled: HookName[]
  error?: string
}

class HooksService {
  async install(
    projectPath: string,
    options: { strategy?: HookStrategy; hooks?: HookName[] } = {}
  ): Promise<HooksInstallResult> {
    const hooks: HookName[] = options.hooks || ['post-commit', 'post-checkout']

    const detected = await detectHookManagers(projectPath)
    if (detected.length === 0) {
      return {
        success: false,
        strategy: 'direct',
        hooksInstalled: [],
        error: 'Not a git repository. Run "git init" first.',
      }
    }

    const strategy = options.strategy || selectStrategy(detected)

    try {
      const success = await (strategy === 'lefthook'
        ? installLefthook(projectPath, hooks)
        : strategy === 'husky'
          ? installHusky(projectPath, hooks)
          : installDirect(projectPath, hooks))

      if (success) {
        await this.saveHookConfig(projectPath, {
          enabled: true,
          strategy,
          hooks,
          installedAt: new Date().toISOString(),
        })
      }

      return { success, strategy, hooksInstalled: success ? hooks : [] }
    } catch (error) {
      return {
        success: false,
        strategy,
        hooksInstalled: [],
        error: getErrorMessage(error),
      }
    }
  }

  async uninstall(projectPath: string): Promise<{ success: boolean; error?: string }> {
    try {
      const config = await this.getHookConfig(projectPath)
      const strategy = config?.strategy || 'direct'

      const success = await (strategy === 'lefthook'
        ? uninstallLefthook(projectPath)
        : strategy === 'husky'
          ? uninstallHusky(projectPath)
          : uninstallDirect(projectPath))

      if (success) {
        await this.saveHookConfig(projectPath, { enabled: false, strategy, hooks: [] })
      }

      return { success }
    } catch (error) {
      return { success: false, error: getErrorMessage(error) }
    }
  }

  async status(projectPath: string): Promise<HooksStatusResult> {
    const detected = await detectHookManagers(projectPath)
    const config = await this.getHookConfig(projectPath)

    const hookNames: HookName[] = ['post-commit', 'post-checkout']
    const hooks = await Promise.all(
      hookNames.map(async (name) => ({
        name,
        installed: await this.isHookInstalled(projectPath, name, config?.strategy || null),
        path: await this.getHookPath(projectPath, name, config?.strategy || null),
      }))
    )

    return {
      installed: hooks.some((h) => h.installed),
      strategy: config?.strategy || null,
      hooks,
      detectedManagers: detected,
    }
  }

  async run(projectPath: string, subcommand: string): Promise<number> {
    const projectId = await configManager.getProjectId(projectPath)
    if (!projectId) {
      console.error('No prjct project found. Run "prjct init" first.')
      return 1
    }

    switch (subcommand) {
      case 'install':
        return this.runInstall(projectPath)
      case 'uninstall':
        return this.runUninstall(projectPath)
      case 'status':
        return this.runStatus(projectPath)
      default:
        return this.runStatus(projectPath)
    }
  }

  // CLI SUBCOMMANDS

  private async runInstall(projectPath: string): Promise<number> {
    out.start()
    out.section('Git Hooks Installation')

    const detected = await detectHookManagers(projectPath)
    const strategy = selectStrategy(detected)

    console.log(`  Strategy: ${chalk.cyan(strategy)}`)
    console.log(`  Hooks:    ${chalk.dim('post-commit, post-checkout')}`)
    console.log('')

    const result = await this.install(projectPath, { strategy })

    if (result.success) {
      out.done(`Hooks installed via ${result.strategy}`)
      console.log('')
      for (const hook of result.hooksInstalled) {
        console.log(`  ${chalk.green('✓')} ${hook}`)
      }
      console.log('')
      console.log(chalk.dim('  Context will auto-sync on commit and branch switch.'))
      console.log(chalk.dim('  Remove with: prjct hooks uninstall'))
    } else {
      out.fail(result.error || 'Failed to install hooks')
    }

    console.log('')
    out.end()
    return result.success ? 0 : 1
  }

  private async runUninstall(projectPath: string): Promise<number> {
    out.start()
    out.section('Git Hooks Removal')

    const result = await this.uninstall(projectPath)
    if (result.success) out.done('Hooks removed')
    else out.fail(result.error || 'Failed to remove hooks')

    console.log('')
    out.end()
    return result.success ? 0 : 1
  }

  private async runStatus(projectPath: string): Promise<number> {
    out.start()
    out.section('Git Hooks Status')

    const status = await this.status(projectPath)

    if (status.installed) {
      console.log(`  Status:   ${chalk.green('Active')}`)
      console.log(`  Strategy: ${chalk.cyan(status.strategy)}`)
    } else {
      console.log(`  Status:   ${chalk.dim('Not installed')}`)
    }

    console.log('')
    for (const hook of status.hooks) {
      const icon = hook.installed ? chalk.green('✓') : chalk.dim('○')
      const label = hook.installed ? hook.name : chalk.dim(hook.name)
      console.log(`  ${icon} ${label}`)
    }

    if (status.detectedManagers.length > 0) {
      console.log('')
      console.log(`  ${chalk.dim('Available managers:')} ${status.detectedManagers.join(', ')}`)
    }

    if (!status.installed) {
      console.log('')
      console.log(chalk.dim('  Install with: prjct hooks install'))
    }

    console.log('')
    out.end()
    return 0
  }

  // HELPERS

  private async isHookInstalled(
    projectPath: string,
    hook: HookName,
    strategy: HookStrategy | null
  ): Promise<boolean> {
    if (strategy === 'lefthook') {
      const configFile = (await fileExists(path.join(projectPath, 'lefthook.yml')))
        ? 'lefthook.yml'
        : 'lefthook.yaml'
      const configPath = path.join(projectPath, configFile)
      if (!(await fileExists(configPath))) return false
      return (await fs.readFile(configPath, 'utf-8')).includes(`prjct-sync-${hook}`)
    }

    if (strategy === 'husky') {
      const hookPath = path.join(projectPath, '.husky', hook)
      if (!(await fileExists(hookPath))) return false
      return (await fs.readFile(hookPath, 'utf-8')).includes('prjct sync')
    }

    const hookPath = path.join(projectPath, '.git', 'hooks', hook)
    if (!(await fileExists(hookPath))) return false
    return (await fs.readFile(hookPath, 'utf-8')).includes('prjct sync')
  }

  private async getHookPath(
    projectPath: string,
    hook: HookName,
    strategy: HookStrategy | null
  ): Promise<string> {
    if (strategy === 'lefthook') {
      return (await fileExists(path.join(projectPath, 'lefthook.yml')))
        ? 'lefthook.yml'
        : 'lefthook.yaml'
    }
    if (strategy === 'husky') return `.husky/${hook}`
    return `.git/hooks/${hook}`
  }

  private async getHookConfig(projectPath: string): Promise<HookConfig | null> {
    const projectId = await configManager.getProjectId(projectPath)
    if (!projectId) return null

    try {
      const project = prjctDb.getDoc<Record<string, unknown>>(projectId, 'project')
      if (!project) return null
      return (project.hooks as HookConfig) || null
    } catch {
      return null
    }
  }

  private async saveHookConfig(projectPath: string, config: HookConfig): Promise<void> {
    const projectId = await configManager.getProjectId(projectPath)
    if (!projectId) return

    try {
      const project = prjctDb.getDoc<Record<string, unknown>>(projectId, 'project') || {}
      project.hooks = config
      prjctDb.setDoc(projectId, 'project', project)
    } catch {
      // Non-fatal
    }
  }
}

export const hooksService = new HooksService()
