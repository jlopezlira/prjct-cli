/**
 * Analysis Helpers - Extracted display/formatting functions from AnalysisCommands
 *
 * Standalone functions for sync result display, stats formatting,
 * session activity tracking, and analysis summary generation.
 *
 */

import path from 'node:path'
import commandInstaller from '../infrastructure/command-installer'
import { formatCost } from '../schemas/metrics'
import { memoryService } from '../services/memory-service'
import type { syncService } from '../services/sync-service'
import type { CommandResult } from '../types/commands'
import * as dateHelper from '../utils/date-helper'
import { showNextSteps } from '../utils/next-steps'
import out from '../utils/output'

// Sync Result Display

export async function showSyncResult(
  result: Awaited<ReturnType<typeof syncService.sync>>,
  startTime: number
): Promise<CommandResult> {
  const elapsed = Date.now() - startTime

  // Update global config (silent - don't clutter output)
  await commandInstaller.installGlobalConfig()

  // SUCCESS LINE
  out.done(`Synced ${result.stats.name || 'project'} (${(elapsed / 1000).toFixed(1)}s)`)
  console.log('')

  // SUMMARY BOX — real data from indexes
  const framework = result.stats.frameworks.length > 0 ? ` (${result.stats.frameworks[0]})` : ''
  const idx = result.syncMetrics?.indexes
  const boxLines = [
    `${result.stats.fileCount} files indexed`,
    `Stack: ${result.stats.ecosystem}${framework} | Branch: ${result.git.branch}`,
  ]
  if (idx?.bm25Files) {
    const totalTokens = idx.bm25Files * (idx.bm25AvgTokens || 0)
    boxLines.push(
      `Index: ${formatTokens(totalTokens)} tokens | ${idx.bm25VocabSize || 0} terms | ${idx.importEdges || 0} imports`
    )
  }
  out.box('Sync Summary', boxLines.join('\n'))

  // CHANGES SECTION
  const generatedItems: string[] = []
  if (result.generatedSkills?.generated && result.generatedSkills.generated.length > 0) {
    const count = result.generatedSkills.generated.length
    const word = count === 1 ? 'skill' : 'skills'
    generatedItems.push(`${count} ${word} generated`)
  }
  if (result.context7) {
    generatedItems.push(
      `Context7: ${result.context7.verified ? 'verified' : `not ready${result.context7.message ? ` (${result.context7.message})` : ''}`}`
    )
  }
  if (result.analysisSummary) {
    generatedItems.push(
      `Analysis: ${result.analysisSummary.patterns} patterns | ${result.analysisSummary.antiPatterns} anti-patterns (${result.analysisSummary.criticalAntiPatterns} critical)`
    )
  }
  if (result.contextQuality) {
    const q = result.contextQuality
    const action =
      q.irrelevantRemoved > 0 || q.repairEntriesCreated > 0
        ? `, repaired ${q.repairEntriesCreated}, removed ${q.irrelevantRemoved}`
        : ''
    generatedItems.push(
      `Context quality: ${q.score}/${q.threshold}${q.passed ? '' : ' (needs review)'}${action}`
    )
  }

  out.section('Generated')
  out.list(generatedItems, { bullet: '✓' })
  console.log('')

  // PHASE TIMINGS — top 3 slowest, compact. Full breakdown lives in --md.
  if (result.phaseTimings && result.phaseTimings.length > 0) {
    const slowest = [...result.phaseTimings]
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 3)
      .map((t) => `${t.phase} ${(t.ms / 1000).toFixed(1)}s`)
      .join(', ')
    console.log(`Slowest phases: ${slowest}`)
    console.log('')
  }

  // STATUS INDICATOR
  if (result.git.hasChanges) {
    out.warn('Uncommitted changes detected')
    console.log('')
  }

  // VERIFICATION
  if (result.verification) {
    const v = result.verification
    if (v.passed) {
      const items = v.checks.map((c) => `${c.name} (${c.durationMs}ms)`)
      out.section('Verified')
      out.list(items, { bullet: '✓' })
    } else {
      out.section('Verification')
      const items = v.checks.map((c) =>
        c.passed ? `✓ ${c.name}` : `✗ ${c.name}${c.error ? ` — ${c.error}` : ''}`
      )
      out.list(items)
      if (v.skippedCount > 0) {
        out.warn(`${v.skippedCount} check(s) skipped (fail-fast)`)
      }
    }
    console.log('')
  }

  // NEXT STEPS
  showNextSteps('sync')

  return {
    success: true,
    data: result,
    metrics: {
      elapsed,
      fileCount: result.stats.fileCount,
    },
  }
}

// Session Activity

export async function getSessionActivity(projectId: string): Promise<{
  sessionDuration: string | null
  tasksCompleted: number
  featuresShipped: number
  agentsUsed: { name: string; count: number }[]
}> {
  try {
    const recentHistory = await memoryService.getRecentEvents(projectId, 100)

    const today = new Date().toISOString().split('T')[0]
    const todayEvents = recentHistory.filter((e) => {
      const ts = (e.timestamp || e.ts) as string | undefined
      return ts?.startsWith(today)
    })

    const sessionDuration = (() => {
      if (todayEvents.length < 2) return null
      const timestamps = todayEvents
        .map((e) => new Date((e.timestamp || e.ts) as string).getTime())
        .filter((t) => !Number.isNaN(t))
        .sort((a, b) => a - b)

      if (timestamps.length < 2) return null
      const durationMs = timestamps[timestamps.length - 1] - timestamps[0]
      return dateHelper.formatDuration(durationMs)
    })()

    const tasksCompleted = todayEvents.filter((e) => e.action === 'task_completed').length
    const featuresShipped = todayEvents.filter((e) => e.action === 'feature_shipped').length

    const agentCounts = new Map<string, number>()
    for (const event of todayEvents) {
      if (event.action === 'sync' && Array.isArray(event.subagents)) {
        for (const agent of event.subagents as string[]) {
          agentCounts.set(agent, (agentCounts.get(agent) || 0) + 1)
        }
      }
    }

    const agentsUsed = Array.from(agentCounts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)

    return { sessionDuration, tasksCompleted, featuresShipped, agentsUsed }
  } catch {
    return { sessionDuration: null, tasksCompleted: 0, featuresShipped: 0, agentsUsed: [] }
  }
}

// Stats Formatting

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}K`
  }
  return tokens.toLocaleString()
}

export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`
  }
  return `${(ms / 1000).toFixed(1)}s`
}

export function generateSparkline(dailyStats: { tokensSaved: number }[]): string {
  if (dailyStats.length === 0) return ''

  const chars = '▁▂▃▄▅▆▇█'
  const values = dailyStats.map((d) => d.tokensSaved)
  const max = Math.max(...values, 1)

  return values
    .map((v) => {
      const idx = Math.min(Math.floor((v / max) * (chars.length - 1)), chars.length - 1)
      return chars[idx]
    })
    .join('')
}

export function generateStatsMarkdown(
  summary: {
    totalTokensSaved: number
    estimatedCostSaved: number
    compressionRate: number
    syncCount: number
    avgSyncDuration: number
    topAgents: { agentName: string; usageCount: number }[]
    last30DaysTokens: number
    trend: number
  },
  _dailyStats: { date: string; tokensSaved: number; syncs: number }[],
  projectName: string,
  firstSyncDate: string,
  sessionActivity?: {
    sessionDuration: string | null
    tasksCompleted: number
    featuresShipped: number
    agentsUsed: { name: string; count: number }[]
  },
  patternsSummary?: {
    decisions: number
    learnedDecisions: number
    workflows: number
    preferences: number
  }
): string {
  const lines: string[] = []

  lines.push(`# ${projectName} - Stats Dashboard`)
  lines.push('')
  lines.push(`_Generated: ${new Date().toLocaleString()} | Tracking since: ${firstSyncDate}_`)
  lines.push('')

  // Session Activity (PRJ-89)
  if (sessionActivity) {
    lines.push("## Today's Activity")
    lines.push('')
    lines.push(`| Metric | Value |`)
    lines.push(`|--------|-------|`)
    if (sessionActivity.sessionDuration) {
      lines.push(`| Duration | ${sessionActivity.sessionDuration} |`)
    }
    lines.push(`| Tasks completed | ${sessionActivity.tasksCompleted} |`)
    lines.push(`| Features shipped | ${sessionActivity.featuresShipped} |`)
    if (sessionActivity.agentsUsed.length > 0) {
      const agentStr = sessionActivity.agentsUsed
        .slice(0, 3)
        .map((a) => `${a.name} (${a.count}×)`)
        .join(', ')
      lines.push(`| Agents used | ${agentStr} |`)
    }
    lines.push('')
  }

  // Patterns Learned (PRJ-89)
  if (patternsSummary && (patternsSummary.decisions > 0 || patternsSummary.preferences > 0)) {
    lines.push('## Patterns Learned')
    lines.push('')
    lines.push(`| Type | Count |`)
    lines.push(`|------|-------|`)
    lines.push(
      `| Decisions | ${patternsSummary.learnedDecisions} confirmed (${patternsSummary.decisions} total) |`
    )
    lines.push(`| Preferences | ${patternsSummary.preferences} |`)
    lines.push(`| Workflows | ${patternsSummary.workflows} |`)
    lines.push('')
  }

  lines.push('## Context Efficiency')
  lines.push('')
  lines.push(`| Metric | Value |`)
  lines.push(`|--------|-------|`)
  lines.push(`| Tokens reduced | ${formatTokens(summary.totalTokensSaved)} |`)
  lines.push(`| Compression | ${(summary.compressionRate * 100).toFixed(0)}% |`)
  lines.push(`| Est. cost saved | ${formatCost(summary.estimatedCostSaved)} |`)
  lines.push('')

  lines.push('## Performance')
  lines.push('')
  lines.push(`| Metric | Value |`)
  lines.push(`|--------|-------|`)
  lines.push(`| Syncs | ${summary.syncCount} |`)
  lines.push(`| Avg time | ${formatDuration(summary.avgSyncDuration)} |`)
  lines.push('')

  if (summary.topAgents.length > 0) {
    lines.push('## Agent Usage')
    lines.push('')
    lines.push(`| Agent | Usage |`)
    lines.push(`|-------|-------|`)
    const totalUsage = summary.topAgents.reduce((sum, a) => sum + a.usageCount, 0)
    for (const agent of summary.topAgents) {
      const pct = totalUsage > 0 ? ((agent.usageCount / totalUsage) * 100).toFixed(0) : 0
      lines.push(`| ${agent.agentName} | ${pct}% (${agent.usageCount}) |`)
    }
    lines.push('')
  }

  lines.push('## 30-Day Trend')
  lines.push('')
  lines.push(`- Tokens saved: ${formatTokens(summary.last30DaysTokens)}`)
  if (summary.trend !== 0) {
    const trendSign = summary.trend > 0 ? '+' : ''
    lines.push(`- Trend: ${trendSign}${summary.trend.toFixed(0)}% vs previous period`)
  }
  lines.push('')

  lines.push('---')
  lines.push('')
  lines.push('_Generated with [prjct-cli](https://prjct.app)_')

  return lines.join('\n')
}

// Analysis Summary

export function generateAnalysisSummary(
  data: Record<string, unknown>,
  projectPath: string
): string {
  const lines: string[] = []

  lines.push('# Repository Analysis\n')
  lines.push(`Generated: ${new Date().toLocaleString()}\n`)

  const projectName = path.basename(projectPath)
  lines.push(`## Project: ${projectName}\n`)

  lines.push('## Stack Detected\n')

  if (data.packageJson) {
    const pkg = data.packageJson as { dependencies?: Record<string, string> }
    lines.push('### JavaScript/TypeScript\n')
    lines.push('- **Package Manager**: npm/yarn/pnpm')
    if (pkg.dependencies) {
      const deps = Object.keys(pkg.dependencies)
      if (deps.length > 0) {
        lines.push(
          `- **Dependencies**: ${deps.slice(0, 10).join(', ')}${deps.length > 10 ? ` (+${deps.length - 10} more)` : ''}`
        )
      }
    }
    if (data.hasNextConfig) lines.push('- **Framework**: Next.js detected')
    if (data.hasViteConfig) lines.push('- **Build Tool**: Vite detected')
    if (data.hasTsconfig) lines.push('- **Language**: TypeScript')
    lines.push('')
  }

  if (data.cargoToml) {
    lines.push('### Rust\n')
    lines.push('- **Package Manager**: Cargo')
    lines.push('- **Language**: Rust\n')
  }

  if (data.goMod) {
    lines.push('### Go\n')
    lines.push('- **Package Manager**: Go modules')
    lines.push('- **Language**: Go\n')
  }

  if (data.requirements) {
    lines.push('### Python\n')
    lines.push('- **Package Manager**: pip')
    lines.push('- **Language**: Python\n')
  }

  const directories = data.directories as string[] | undefined
  lines.push('## Structure\n')
  lines.push(`- **Total Files**: ${data.fileCount}`)
  lines.push(
    `- **Directories**: ${directories?.slice(0, 15).join(', ') || 'none'}${(directories?.length || 0) > 15 ? ` (+${(directories?.length || 0) - 15} more)` : ''}`
  )

  if (data.hasDockerfile) lines.push('- **Docker**: Detected')
  if (data.hasDockerCompose) lines.push('- **Docker Compose**: Detected')
  if (data.hasReadme) lines.push('- **Documentation**: README.md found')
  lines.push('')

  const gitStats = data.gitStats as
    | { totalCommits?: number; contributors?: number; age?: string }
    | undefined
  lines.push('## Git Statistics\n')
  lines.push(`- **Total Commits**: ${gitStats?.totalCommits || 0}`)
  lines.push(`- **Contributors**: ${gitStats?.contributors || 0}`)
  lines.push(`- **Age**: ${gitStats?.age || 'unknown'}`)
  lines.push('')

  if (data.gitLog) {
    lines.push('## Recent Activity\n')
    const logLines = (data.gitLog as string).split('\n').slice(0, 5)
    logLines.forEach((line) => {
      if (line.trim()) {
        const [hash, , time, msg] = line.split('|')
        lines.push(`- \`${hash}\` ${msg} (${time})`)
      }
    })
    lines.push('')
  }

  lines.push('## Recommendations\n')
  lines.push('Based on detected stack, consider generating specialized agents using `p. sync`.\n')

  lines.push('---\n')
  lines.push(
    '*This analysis was generated automatically. For updated information, run `p. analyze` again.*\n'
  )

  return lines.join('\n')
}
