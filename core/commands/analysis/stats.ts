/**
 * Stats / diff commands — `stats` (session dashboard) and `diff`
 * (compare two analysis snapshots).
 *
 * Extracted from the AnalysisCommands god-class for the 500-LOC
 * limit. Both functions are pure over their args + the storage
 * layer; no `this` access.
 */

import { formatCost } from '../../schemas/metrics'
import { formatAnalysisDiffMd, formatAnalysisDiffText } from '../../services/analysis-diff'
import { analysisStorage } from '../../storage/analysis-storage'
import { prjctDb } from '../../storage/database'
import { metricsStorage } from '../../storage/metrics-storage'
import type { CommandResult } from '../../types/commands'
import { getErrorMessage } from '../../types/fs'
import { failFromError } from '../../utils/md-aware'
import { mdOutput } from '../../utils/md-formatter'
import out from '../../utils/output'
import {
  formatDuration,
  formatTokens,
  generateSparkline,
  generateStatsMarkdown,
  getSessionActivity,
} from '../analysis-helpers'
import { requireProject } from '../guards'

export async function stats(
  projectPath: string = process.cwd(),
  options: { json?: boolean; export?: boolean } = {}
): Promise<CommandResult> {
  try {
    const proj = await requireProject(projectPath)
    if (!proj.ok) return proj.result
    const projectId = proj.value

    // Get metrics summary
    const summary = await metricsStorage.getSummary(projectId)
    const dailyStats = await metricsStorage.getDailyStats(projectId, 30)

    // Get session activity (today's events)
    const sessionActivity = await getSessionActivity(projectId)

    // Learned-patterns summary (decisions/preferences/workflows) was
    // backed by the pre-v2 memory-system — deleted in Phase C. The
    // stats page still shows zeros for backward-compat with callers
    // that read the shape; project memory now lives under
    // `prjct memory list` / `context memory`.
    const patternsSummary = {
      decisions: 0,
      preferences: 0,
      workflows: 0,
      learnedDecisions: 0,
    }

    // JSON output mode
    if (options.json) {
      const jsonOutput = {
        session: sessionActivity,
        patterns: patternsSummary,
        totalTokensSaved: summary.totalTokensSaved,
        estimatedCostSaved: summary.estimatedCostSaved,
        compressionRate: summary.compressionRate,
        syncCount: summary.syncCount,
        avgSyncDuration: summary.avgSyncDuration,
        topAgents: summary.topAgents.slice(0, 5),
        last30DaysTokens: summary.last30DaysTokens,
        trend: summary.trend,
        dailyStats: dailyStats.slice(0, 7),
      }
      console.log(JSON.stringify(jsonOutput))
      return { success: true, data: jsonOutput }
    }

    // Get project info for header
    const projectName = (() => {
      try {
        const projectDoc = prjctDb.getDoc<Record<string, unknown>>(projectId, 'project')
        return (projectDoc?.name as string) || 'Unknown'
      } catch {
        return 'Unknown'
      }
    })()

    // Determine first sync date (MIN(date) over the typed metrics_daily rows)
    const firstSync = await metricsStorage.getFirstSyncDate(projectId)
    const firstSyncDate = firstSync
      ? new Date(firstSync).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })
      : 'N/A'

    // ASCII Dashboard
    console.log('')
    console.log('╭─────────────────────────────────────────────────╮')
    console.log('│  📊 prjct-cli Stats Dashboard                   │')
    console.log(
      `│  Project: ${projectName.padEnd(20).slice(0, 20)} | Since: ${firstSyncDate.padEnd(12).slice(0, 12)} │`
    )
    console.log('╰─────────────────────────────────────────────────╯')
    console.log('')

    // Session Activity Section (PRJ-89)
    console.log("🎯 TODAY'S ACTIVITY")
    if (sessionActivity.sessionDuration) {
      console.log(`   Duration:        ${sessionActivity.sessionDuration}`)
    }
    console.log(`   Tasks completed: ${sessionActivity.tasksCompleted}`)
    console.log(`   Features shipped: ${sessionActivity.featuresShipped}`)
    if (sessionActivity.agentsUsed.length > 0) {
      const agentStr = sessionActivity.agentsUsed
        .slice(0, 3)
        .map((a) => `${a.name} (${a.count}×)`)
        .join(', ')
      console.log(`   Agents used:     ${agentStr}`)
    }
    console.log('')

    // Learned Patterns Section (PRJ-89)
    if (patternsSummary.decisions > 0 || patternsSummary.preferences > 0) {
      console.log('🧠 PATTERNS LEARNED')
      console.log(
        `   Decisions:    ${patternsSummary.learnedDecisions} confirmed (${patternsSummary.decisions} total)`
      )
      console.log(`   Preferences:  ${patternsSummary.preferences} saved`)
      console.log(`   Workflows:    ${patternsSummary.workflows} tracked`)
      console.log('')
    }

    // Token Savings Section
    console.log('💰 TOKEN SAVINGS')
    console.log(`   Total saved:     ${formatTokens(summary.totalTokensSaved)} tokens`)
    console.log(
      `   Compression:     ${(summary.compressionRate * 100).toFixed(0)}% average reduction`
    )
    console.log(`   Estimated cost:  ${formatCost(summary.estimatedCostSaved)} saved`)
    console.log('')

    // Performance Section
    console.log('⚡ PERFORMANCE')
    console.log(`   Syncs completed: ${summary.syncCount.toLocaleString()}`)
    console.log(`   Avg sync time:   ${formatDuration(summary.avgSyncDuration)}`)
    console.log('')

    // Agent Usage Section
    if (summary.topAgents.length > 0) {
      console.log('🤖 AGENT USAGE (all time)')
      const totalUsage = summary.topAgents.reduce((sum, a) => sum + a.usageCount, 0)
      for (const agent of summary.topAgents) {
        const pct = totalUsage > 0 ? ((agent.usageCount / totalUsage) * 100).toFixed(0) : 0
        console.log(`   ${agent.agentName.padEnd(12)}: ${pct}% (${agent.usageCount} uses)`)
      }
      console.log('')
    }

    // 30-Day Trend Section
    if (dailyStats.length > 0) {
      console.log('📈 TREND (last 30 days)')
      const sparkline = generateSparkline(dailyStats)
      console.log(`   ${sparkline} ${formatTokens(summary.last30DaysTokens)} tokens saved`)

      if (summary.trend !== 0) {
        const trendIcon = summary.trend > 0 ? '↑' : '↓'
        const trendSign = summary.trend > 0 ? '+' : ''
        console.log(`   ${trendIcon} ${trendSign}${summary.trend.toFixed(0)}% vs previous 30 days`)
      }
      console.log('')
    }

    // Footer
    console.log('───────────────────────────────────────────────────')
    console.log(`Export: prjct stats --export > stats.md`)
    console.log('')

    // Export mode - return markdown
    if (options.export) {
      const markdown = generateStatsMarkdown(
        summary,
        dailyStats,
        projectName,
        firstSyncDate,
        sessionActivity,
        patternsSummary
      )
      console.log(markdown)
      return { success: true, data: { markdown } }
    }

    return {
      success: true,
      data: { ...summary, session: sessionActivity, patterns: patternsSummary },
    }
  } catch (error) {
    console.error('❌ Error:', getErrorMessage(error))
    return failFromError(error)
  }
}

/**
 * prjct diff - Show diff between draft and sealed analysis (PRJ-275)
 *
 * Compares the current draft with the sealed version to show
 * what changed: languages, frameworks, patterns, file count, etc.
 */
export async function diff(
  projectPath: string = process.cwd(),
  options: { json?: boolean; md?: boolean } = {}
): Promise<CommandResult> {
  try {
    const proj = await requireProject(projectPath)
    if (!proj.ok) {
      if (options.json) {
        console.log(JSON.stringify({ success: false, error: 'No project ID found' }))
      }
      return proj.result
    }
    const projectId = proj.value

    const diff = await analysisStorage.diff(projectId)

    if (!diff) {
      const msg =
        'Cannot compute diff: need both a sealed and a draft analysis. Run `p. sync` to create a draft.'
      if (options.json) {
        console.log(JSON.stringify({ success: false, error: msg }))
      } else if (options.md) {
        console.log(mdOutput(`## Analysis Diff`, `> ${msg}`))
      } else {
        out.warn(msg)
      }
      return { success: false, error: msg }
    }

    if (options.json) {
      console.log(JSON.stringify({ success: true, ...diff }))
      return { success: true, data: diff }
    }

    if (options.md) {
      console.log(mdOutput(formatAnalysisDiffMd(diff)))
      return { success: true, data: diff }
    }

    // Terminal output
    if (!diff.hasChanges) {
      out.done('No changes between draft and sealed analysis')
    } else {
      out.section('Analysis Diff')
      console.log(formatAnalysisDiffText(diff))
      console.log('')

      const parts: string[] = []
      if (diff.summary.added > 0) parts.push(`${diff.summary.added} added`)
      if (diff.summary.removed > 0) parts.push(`${diff.summary.removed} removed`)
      if (diff.summary.changed > 0) parts.push(`${diff.summary.changed} changed`)
      out.done(parts.join(', '))
    }
    console.log('')

    return { success: true, data: diff }
  } catch (error) {
    const errMsg = getErrorMessage(error)
    if (options.json) {
      console.log(JSON.stringify({ success: false, error: errMsg }))
    } else if (options.md) {
      console.log(mdOutput(`## Diff Failed`, `> ${errMsg}`))
    } else {
      out.fail(errMsg)
    }
    return { success: false, error: errMsg }
  }
}
