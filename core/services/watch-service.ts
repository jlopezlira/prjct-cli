/**
 * WatchService - Smart file watcher for auto-sync
 *
 * Monitors project files and triggers sync on meaningful changes.
 * Features:
 * - Debouncing to batch rapid changes
 * - Smart filtering of meaningful files
 * - Graceful shutdown
 * - Low CPU/memory footprint
 */

import path from 'node:path'
import chalk from 'chalk'
import chokidar, { type FSWatcher } from 'chokidar'
import configManager from '../infrastructure/config-manager'
import { getErrorMessage } from '../types/fs'
import * as dateHelper from '../utils/date-helper'
import { syncService } from './sync-service'

// TYPES

interface WatchOptions {
  debounceMs?: number // Debounce window (default: 2000ms)
  minIntervalMs?: number // Minimum sync interval (default: 30000ms)
  verbose?: boolean // Show detailed output
  quiet?: boolean // Suppress all output except errors
}

interface WatchResult {
  success: boolean
  error?: string
}

// DEFAULT CONFIGURATION

// Files that trigger a sync when changed
const TRIGGER_PATTERNS = [
  'package.json',
  'package-lock.json',
  'bun.lockb',
  'pnpm-lock.yaml',
  'yarn.lock',
  'tsconfig.json',
  'tsconfig.*.json',
  '.env',
  '.env.*',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'requirements.txt',
  // Source files (new files trigger sync)
  'src/**/*.ts',
  'src/**/*.tsx',
  'src/**/*.js',
  'src/**/*.jsx',
  'lib/**/*.ts',
  'core/**/*.ts',
  'app/**/*.ts',
  'app/**/*.tsx',
  'pages/**/*.ts',
  'pages/**/*.tsx',
]

// Patterns to always ignore
const IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/coverage/**',
  '**/*.log',
  '**/*.tmp',
  '**/CLAUDE.md', // Don't trigger on our own output
  '**/.cursorrules',
  '**/.prjct/**',
  '**/.prjct-cli/**',
]

// WATCH SERVICE

class WatchService {
  private watcher: FSWatcher | null = null
  private projectPath: string = ''
  private projectId: string | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private lastSyncTime: number = 0
  private pendingChanges: Set<string> = new Set()
  private options: Required<WatchOptions> = {
    debounceMs: 2000,
    minIntervalMs: 30000,
    verbose: false,
    quiet: false,
  }
  private isRunning: boolean = false
  private syncCount: number = 0
  private sigintHandler: (() => void) | null = null
  private sigtermHandler: (() => void) | null = null

  /**
   * Start watching for file changes
   */
  async start(
    projectPath: string = process.cwd(),
    options: WatchOptions = {}
  ): Promise<WatchResult> {
    this.projectPath = projectPath
    this.options = { ...this.options, ...options }

    // Get project ID
    this.projectId = await configManager.getProjectId(projectPath)
    if (!this.projectId) {
      return { success: false, error: 'No prjct project. Run "prjct init" first.' }
    }

    if (this.isRunning) {
      return { success: false, error: 'Watch mode is already running' }
    }

    this.isRunning = true

    // Print startup message
    if (!this.options.quiet) {
      this.printStartup()
    }

    this.watcher = chokidar.watch(TRIGGER_PATTERNS, {
      cwd: this.projectPath,
      ignored: IGNORE_PATTERNS,
      persistent: true,
      ignoreInitial: true, // Don't trigger on initial scan
      awaitWriteFinish: {
        // Wait for writes to complete
        stabilityThreshold: 500,
        pollInterval: 100,
      },
    })

    // Set up event handlers
    this.watcher
      .on('add', (filePath: string) => this.handleChange('add', filePath))
      .on('change', (filePath: string) => this.handleChange('change', filePath))
      .on('unlink', (filePath: string) => this.handleChange('unlink', filePath))
      .on('error', (error: unknown) => this.handleError(error as Error))

    // Handle graceful shutdown — store references for proper removal
    if (this.sigintHandler) process.off('SIGINT', this.sigintHandler)
    if (this.sigtermHandler) process.off('SIGTERM', this.sigtermHandler)
    this.sigintHandler = () => this.stop()
    this.sigtermHandler = () => this.stop()
    process.on('SIGINT', this.sigintHandler)
    process.on('SIGTERM', this.sigtermHandler)

    return { success: true }
  }

  /**
   * Stop watching
   */
  async stop(): Promise<void> {
    if (!this.options.quiet) {
      console.log('')
      console.log(chalk.dim(`\n👋 Stopped watching (${this.syncCount} syncs performed)`))
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }

    if (this.watcher) {
      await this.watcher.close()
      this.watcher = null
    }

    // Remove signal handlers to prevent accumulation
    if (this.sigintHandler) {
      process.off('SIGINT', this.sigintHandler)
      this.sigintHandler = null
    }
    if (this.sigtermHandler) {
      process.off('SIGTERM', this.sigtermHandler)
      this.sigtermHandler = null
    }

    this.pendingChanges.clear()
    this.isRunning = false
    // Never hard-exit when hosted inside the daemon — process.exit(0) here
    // would take the whole daemon down (and every other in-flight request)
    // instead of just stopping the watcher. Stopping the watcher above is
    // sufficient; the standalone `prjct watch` CLI still exits via its own
    // signal handlers.
    if (process.env.PRJCT_IN_DAEMON === '1') return
    process.exit(0)
  }

  /**
   * Handle file change event
   */
  private handleChange(event: 'add' | 'change' | 'unlink', filePath: string): void {
    this.pendingChanges.add(filePath)

    if (this.options.verbose && !this.options.quiet) {
      const eventIcon = event === 'add' ? '➕' : event === 'unlink' ? '➖' : '📝'
      console.log(chalk.dim(`  ${eventIcon} ${filePath}`))
    }

    // Debounce the sync
    this.scheduleSyncIfNeeded()
  }

  /**
   * Schedule a sync with debouncing and rate limiting
   */
  private scheduleSyncIfNeeded(): void {
    // Clear existing timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }

    // Schedule new sync
    this.debounceTimer = setTimeout(async () => {
      // Check rate limit
      const now = Date.now()
      const timeSinceLastSync = now - this.lastSyncTime

      if (timeSinceLastSync < this.options.minIntervalMs && this.lastSyncTime > 0) {
        // Too soon, reschedule
        const waitTime = this.options.minIntervalMs - timeSinceLastSync
        if (this.options.verbose && !this.options.quiet) {
          console.log(chalk.dim(`  ⏳ Rate limited, waiting ${Math.round(waitTime / 1000)}s...`))
        }
        this.debounceTimer = setTimeout(() => this.performSync(), waitTime)
        return
      }

      await this.performSync()
    }, this.options.debounceMs)
  }

  /**
   * Perform the actual sync
   */
  private async performSync(): Promise<void> {
    const changedFiles = Array.from(this.pendingChanges)
    this.pendingChanges.clear()

    if (changedFiles.length === 0) return

    const timestamp = dateHelper.getTimestamp().split('T')[1].split('.')[0]

    if (!this.options.quiet) {
      const filesSummary =
        changedFiles.length === 1 ? changedFiles[0] : `${changedFiles.length} files`
      console.log(
        `\n${chalk.dim(`[${timestamp}]`)} ${chalk.cyan('⟳')} ${filesSummary} changed → syncing...`
      )
    }

    try {
      const result = await syncService.sync(this.projectPath, { changedFiles })

      this.lastSyncTime = Date.now()
      this.syncCount++

      if (result.success) {
        if (!this.options.quiet) {
          console.log(`${chalk.dim(`[${timestamp}]`)} ${chalk.green('✓')} Synced`)
        }
      } else {
        console.error(
          `${chalk.dim(`[${timestamp}]`)} ${chalk.red('✗')} Sync failed: ${result.error}`
        )
      }
    } catch (error) {
      console.error(
        `${chalk.dim(`[${timestamp}]`)} ${chalk.red('✗')} Error: ${getErrorMessage(error)}`
      )
    }
  }

  /**
   * Handle watcher errors
   */
  private handleError(error: Error): void {
    console.error(chalk.red(`Watch error: ${error.message}`))
  }

  /**
   * Print startup message
   */
  private printStartup(): void {
    console.log('')
    console.log(chalk.cyan('👁️  Watching for changes...'))
    console.log(chalk.dim(`   Project: ${path.basename(this.projectPath)}`))
    console.log(chalk.dim(`   Debounce: ${this.options.debounceMs}ms`))
    console.log(chalk.dim(`   Min interval: ${this.options.minIntervalMs / 1000}s`))
    console.log('')
    console.log(chalk.dim('   Press Ctrl+C to stop'))
    console.log('')
  }
}

export const watchService = new WatchService()
export { WatchService }
