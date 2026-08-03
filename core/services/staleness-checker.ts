/**
 * Staleness Checker Service (PRJ-120)
 *
 * Detects when CLAUDE.md context is stale and needs resync.
 * Uses git commit history to determine if significant changes have occurred.
 *
 * Pattern from Warp Agent: "Use VCS to detect recent changes"
 */

import { prjctDb } from '../storage/database'
import { getErrorMessage } from '../types/fs'
import type { SessionInfo, StalenessConfig, StalenessStatus } from '../types/services.js'
import { runGit } from '../utils/exec'
import { sessionTracker } from './session-tracker'

const DEFAULT_CONFIG: StalenessConfig = {
  commitThreshold: 10,
  dayThreshold: 3,
  significantFiles: [
    'package.json',
    'tsconfig.json',
    'Cargo.toml',
    'go.mod',
    'requirements.txt',
    'pyproject.toml',
    '.env.example',
    'docker-compose.yml',
    'Dockerfile',
  ],
}

// STALENESS CHECKER

class StalenessChecker {
  private projectPath: string
  private config: StalenessConfig

  constructor(projectPath: string, config: Partial<StalenessConfig> = {}) {
    this.projectPath = projectPath
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Check if the project context is stale
   */
  async check(projectId: string): Promise<StalenessStatus> {
    const status: StalenessStatus = {
      isStale: false,
      reason: null,
      lastSyncCommit: null,
      currentCommit: null,
      commitsSinceSync: 0,
      daysSinceSync: 0,
      changedFiles: [],
      significantChanges: [],
    }

    try {
      // Read project doc from SQLite to get last sync info
      let projectJson: Record<string, unknown> = {}
      try {
        const doc = prjctDb.getDoc<Record<string, unknown>>(projectId, 'project')
        if (!doc) {
          status.isStale = true
          status.reason = 'No sync history found. Run `prjct sync` to initialize.'
          return status
        }
        projectJson = doc
      } catch {
        // No project doc = definitely stale
        status.isStale = true
        status.reason = 'No sync history found. Run `prjct sync` to initialize.'
        return status
      }

      status.lastSyncCommit = (projectJson.lastSyncCommit as string) || null
      const lastSync = projectJson.lastSync as string

      // If no last sync commit, we can't compare.
      if (!status.lastSyncCommit) {
        status.isStale = true
        status.reason = 'No sync commit recorded. Run `prjct sync` to track.'
        return status
      }

      // Bounded git (timeouts match land-synthesis ~3s). HEAD resolution and
      // exact range counting are independent, so start both before awaiting.
      const cwd = this.projectPath
      const gitOpts = { cwd, timeoutMs: 3000, maxBuffer: 1024 * 256 }
      const range = `${status.lastSyncCommit}..HEAD`
      const [head, revList] = await Promise.all([
        runGit(['rev-parse', '--short', 'HEAD'], gitOpts),
        runGit(['rev-list', '--count', range], gitOpts),
      ])

      // Get current HEAD commit (bounded)
      if (!head.ok) {
        // Typed exit = genuinely not a git repo; timeout/spawn = git is
        // broken — report unknown, never confuse the two.
        status.reason =
          head.kind === 'exit' ? 'Not a git repository' : `git ${head.kind} — staleness unknown`
        return status
      }
      status.currentCommit = head.stdout.trim()

      // Same commit = not stale
      if (status.lastSyncCommit === status.currentCommit) {
        status.reason = 'Context is up to date'
        return status
      }

      if (!revList.ok) {
        if (revList.kind === 'exit') {
          // Bad revision range = the recorded sync commit is really gone.
          status.isStale = true
          status.reason = 'Sync commit no longer exists (history changed). Run `prjct sync`.'
        } else {
          // A git timeout/spawn is NOT a history rewrite — never report
          // staleness from an infra failure.
          status.reason = `git ${revList.kind} reading history — staleness unknown. Retry shortly.`
        }
        return status
      }

      status.commitsSinceSync = parseInt(revList.stdout.trim(), 10) || 0

      // Calculate days since sync
      if (lastSync) {
        const syncDate = new Date(lastSync)
        const now = new Date()
        status.daysSinceSync = Math.floor(
          (now.getTime() - syncDate.getTime()) / (1000 * 60 * 60 * 24)
        )
      }

      // Only fetch names when commit count alone may not decide staleness
      // (under commit threshold), avoiding the diff for high drift.
      const needNames =
        status.commitsSinceSync > 0 && status.commitsSinceSync < this.config.commitThreshold
      if (needNames) {
        const diff = await runGit(['diff', '--name-only', range], gitOpts)
        // Cap name list so a huge range cannot blow SessionStart memory.
        // Any failure (exit or infra) degrades to an empty list — the
        // count-based verdict above already stands on its own.
        const names = diff.ok ? diff.stdout.trim().split('\n').filter(Boolean).slice(0, 200) : []
        status.changedFiles = names
        status.significantChanges = names.filter((file) =>
          this.config.significantFiles.some((sig) => file.endsWith(sig) || file.includes(sig))
        )
      } else {
        status.changedFiles = []
        status.significantChanges = []
      }

      // Determine staleness
      if (status.commitsSinceSync >= this.config.commitThreshold) {
        status.isStale = true
        status.reason = `${status.commitsSinceSync} commits since last sync (threshold: ${this.config.commitThreshold})`
      } else if (status.daysSinceSync >= this.config.dayThreshold) {
        status.isStale = true
        status.reason = `${status.daysSinceSync} days since last sync (threshold: ${this.config.dayThreshold})`
      } else if (status.significantChanges.length > 0) {
        status.isStale = true
        status.reason = `Significant files changed: ${status.significantChanges.join(', ')}`
      } else if (status.commitsSinceSync > 0) {
        // Not stale yet, but has changes
        status.reason = `${status.commitsSinceSync} commits since sync (threshold: ${this.config.commitThreshold})`
      } else {
        status.reason = 'Context is up to date'
      }

      return status
    } catch (error) {
      status.reason = `Error checking staleness: ${getErrorMessage(error)}`
      return status
    }
  }

  /**
   * Format staleness status for display
   */
  formatStatus(status: StalenessStatus): string {
    const lines: string[] = []

    if (status.isStale) {
      lines.push('CLAUDE.md status: ⚠️  STALE')
    } else {
      lines.push('CLAUDE.md status: ✓ Fresh')
    }

    // Build key-value table content
    const details: string[] = []
    if (status.lastSyncCommit) {
      details.push(`Last sync:      ${status.lastSyncCommit}`)
    }
    if (status.currentCommit) {
      details.push(`Current:        ${status.currentCommit}`)
    }
    if (status.commitsSinceSync > 0) {
      details.push(`Commits since:  ${status.commitsSinceSync}`)
    }
    if (status.daysSinceSync > 0) {
      details.push(`Days since:     ${status.daysSinceSync}`)
    }
    if (status.changedFiles.length > 0) {
      details.push(`Files changed:  ${status.changedFiles.length}`)
    }

    // Wrap details in a box
    if (details.length > 0) {
      const maxLen = Math.max(...details.map((l) => l.length))
      const border = '─'.repeat(maxLen + 2)
      lines.push(`┌${border}┐`)
      for (const detail of details) {
        lines.push(`│ ${detail.padEnd(maxLen)} │`)
      }
      lines.push(`└${border}┘`)
    }

    if (status.significantChanges.length > 0) {
      lines.push(``)
      lines.push(`Significant changes:`)
      for (const file of status.significantChanges.slice(0, 5)) {
        lines.push(`  • ${file}`)
      }
      if (status.significantChanges.length > 5) {
        lines.push(`  ... and ${status.significantChanges.length - 5} more`)
      }
    }

    if (status.reason) {
      lines.push(``)
      lines.push(status.reason)
    }

    if (status.isStale) {
      lines.push(``)
      lines.push(`Run \`prjct sync\` to update context`)
    }

    return lines.join('\n')
  }

  /**
   * Get session info for the project
   */
  async getSessionInfo(projectId: string): Promise<SessionInfo> {
    return sessionTracker.getInfo(projectId)
  }

  /**
   * Format session info for display
   */
  formatSessionInfo(info: SessionInfo): string {
    const lines: string[] = []

    if (!info.active) {
      lines.push('Session: ○ No active session')
      return lines.join('\n')
    }

    lines.push(`Session: ▶ Active (${info.duration})`)

    const details: string[] = []
    if (info.commandCount > 0) {
      // Show unique command sequence
      const seen = new Set<string>()
      const unique: string[] = []
      for (const cmd of info.commands) {
        if (!seen.has(cmd)) {
          seen.add(cmd)
          unique.push(cmd)
        }
      }
      details.push(`Commands:       ${unique.join(' → ')} (${info.commandCount} total)`)
    }
    if (info.filesRead > 0 || info.filesWritten > 0) {
      details.push(`Files:          ${info.filesRead} read, ${info.filesWritten} written`)
    }
    details.push(`Idle:           ${info.expiresIn} until timeout`)

    if (details.length > 0) {
      const maxLen = Math.max(...details.map((l) => l.length))
      const border = '─'.repeat(maxLen + 2)
      lines.push(`┌${border}┐`)
      for (const detail of details) {
        lines.push(`│ ${detail.padEnd(maxLen)} │`)
      }
      lines.push(`└${border}┘`)
    }

    return lines.join('\n')
  }

  /**
   * Get a short warning message if stale (for other commands)
   */
  getWarning(status: StalenessStatus): string | null {
    if (!status.isStale) return null

    if (status.commitsSinceSync > 0) {
      return `⚠️  Context stale (${status.commitsSinceSync} commits behind). Run \`prjct sync\``
    }
    if (status.daysSinceSync > 0) {
      return `⚠️  Context stale (${status.daysSinceSync} days old). Run \`prjct sync\``
    }
    return `⚠️  Context may be stale. Run \`prjct sync\``
  }
}

// EXPORTS

export const createStalenessChecker = (projectPath: string, config?: Partial<StalenessConfig>) =>
  new StalenessChecker(projectPath, config)
