/**
 * Analysis Commands: analyze, sync, and related helpers
 */

import analyzer from '../domain/analyzer'
import pathManager from '../infrastructure/path-manager'
import { deriveTitle } from '../memory/format'
import { projectMemory } from '../memory/project-memory'
import { formatAnalysisDiffMd } from '../services/analysis-diff'
import { buildAnalysisPayload } from '../services/analysis-payload-builder'
import { syncService } from '../services/sync-service'
import { analysisStorage } from '../storage/analysis-storage'
import llmAnalysisStorage from '../storage/llm-analysis-storage'
import type { AnalyzeOptions, CommandResult } from '../types/commands'
import { getErrorMessage } from '../types/fs'
import * as dateHelper from '../utils/date-helper'
import { failFromError } from '../utils/md-aware'
import {
  mdDone,
  mdList,
  mdNextSteps,
  mdOutput,
  mdSection,
  mdStats,
  mdWarn,
} from '../utils/md-formatter'
import { getNextSteps } from '../utils/next-steps'
import out from '../utils/output'
import { rollback, seal, semanticVerifyCommand, verify } from './analysis/lifecycle'
import { getLlmAnalysis, saveLlmAnalysis } from './analysis/llm'
import { diff, stats } from './analysis/stats'
import { generateAnalysisSummary, showSyncResult } from './analysis-helpers'
import { PrjctCommandsBase } from './base'
import { requireProject } from './guards'

const ANALYSIS_NOTES_INSTRUCTIONS = [
  `> Review this project data and save durable notes for future AI agents (architecture, conventions, risks, gotchas).`,
  `> **Prefer schema v1 JSON** with: architecture{style,insights,domains}, patterns[], antiPatterns[], techDebt[], riskAreas[], refactorSuggestions[], projectInsights[], conventions[], optional stack/commands. See core/schemas/llm-analysis.ts.`,
  `> Markdown alone saves style=unknown and empty patterns (thin notes) — agents then retry and burn tokens. Use markdown only to append insight bullets when a rich analysis already exists.`,
  `> Save path: write the JSON file, then \`prjct analysis-save-llm <file> --md\`.`,
].join('\n')

export class AnalysisCommands extends PrjctCommandsBase {
  /**
   * p. analyze - Analyze repository and generate summary
   */
  async analyze(
    options: AnalyzeOptions = {},
    projectPath: string = process.cwd()
  ): Promise<CommandResult> {
    try {
      await this.initializeAgent()

      console.log('🔍 Analyzing repository...\n')

      analyzer.init(projectPath)

      // Inline path resolution — `contextBuilder.build` (pre-v2 agentic
      // harness) was only consulted for `paths.analysis`. Going direct
      // to `pathManager` keeps this callsite alive without the wider
      // context-builder graph.
      void options

      const analysisData = {
        packageJson: await analyzer.readPackageJson(),
        cargoToml: await analyzer.readCargoToml(),
        goMod: await analyzer.readGoMod(),
        requirements: await analyzer.readRequirements(),
        directories: await analyzer.listDirectories(),
        fileCount: await analyzer.countFiles(),
        gitStats: await analyzer.getGitStats(),
        gitLog: await analyzer.getGitLog(20),
        hasDockerfile: await analyzer.fileExists('Dockerfile'),
        hasDockerCompose: await analyzer.fileExists('docker-compose.yml'),
        hasReadme: await analyzer.fileExists('README.md'),
        hasTsconfig: await analyzer.fileExists('tsconfig.json'),
        hasViteConfig:
          (await analyzer.fileExists('vite.config.ts')) ||
          (await analyzer.fileExists('vite.config.js')),
        hasNextConfig:
          (await analyzer.fileExists('next.config.js')) ||
          (await analyzer.fileExists('next.config.mjs')),
      }

      const summary = generateAnalysisSummary(analysisData, projectPath)

      await this.logToMemory(projectPath, 'repository_analyzed', {
        timestamp: dateHelper.getTimestamp(),
        fileCount: analysisData.fileCount,
        gitCommits: analysisData.gitStats.totalCommits,
      })

      console.log('✅ Analysis complete!\n')
      console.log(summary)
      console.log('\nNext steps:')
      console.log('• p. sync → Generate agents based on stack')
      console.log('• p. work "<intent>" → Start a work cycle')

      return {
        success: true,
        summary,
        data: analysisData,
      }
    } catch (error) {
      console.error('❌ Error:', getErrorMessage(error))
      return failFromError(error)
    }
  }

  /**
   * p. sync - Comprehensive project sync with diff preview
   *
   * Uses syncService to do ALL operations in one TypeScript execution:
   * - Git analysis
   * - Project stats
   * - Agent generation
   * - Context file generation
   * - Skill configuration
   * - State updates
   *
   * Options:
   * - --preview: Show what would change without applying
   * - --yes: Skip confirmation prompt
   * - --json: Output structured JSON for LLM consumption (non-interactive)
   *
   * When running in non-TTY mode (e.g., from an LLM), the CLI outputs
   * structured JSON instead of interactive prompts. The LLM should:
   * 1. Run `prjct sync --preview --json` to get diff data
   * 2. Show diff to user and use AskUserQuestion for confirmation
   * 3. Run `prjct sync --yes` if user confirms
   *
   * This eliminates the need for Claude to make 50+ individual tool calls.
   *
   * @see PRJ-125
   */
  async sync(
    projectPath: string = process.cwd(),
    options: {
      preview?: boolean
      yes?: boolean
      json?: boolean
      md?: boolean
      package?: string
      full?: boolean
    } = {}
  ): Promise<CommandResult> {
    try {
      const proj = await requireProject(projectPath)
      if (!proj.ok) return proj.result
      const projectId = proj.value

      const startTime = Date.now()

      // Handle package-specific sync for monorepos
      if (options.package) {
        const monoInfo = await pathManager.detectMonorepo(projectPath)
        if (!monoInfo.isMonorepo) {
          return {
            success: false,
            error: 'Not a monorepo. --package flag only works in monorepos.',
          }
        }

        const pkg = monoInfo.packages.find(
          (p) => p.name === options.package || p.relativePath === options.package
        )
        if (!pkg) {
          const available = monoInfo.packages.map((p) => p.name).join(', ')
          return {
            success: false,
            error: `Package "${options.package}" not found. Available: ${available}`,
          }
        }

        // Sync only the specified package
        const result = await syncService.sync(projectPath, {
          packagePath: pkg.path,
          packageName: pkg.name,
        })

        if (options.json) {
          console.log(
            JSON.stringify({ success: result.success, package: pkg.name, path: pkg.relativePath })
          )
        } else if (options.md) {
          console.log(mdOutput(mdDone(`Synced package: ${pkg.name}`)))
        } else {
          out.done(`Synced package: ${pkg.name}`)
        }

        return { success: result.success }
      }

      // Static per-project CLAUDE.md generation was removed in commit 7c091013
      // (skill-on-demand architecture). The interactive diff-preview that used
      // it is gone — sync runs directly and writes results.
      if (!options.md) out.spin('Syncing project...')

      // Use syncService to do EVERYTHING in one call
      const result = await syncService.sync(projectPath, {
        full: options.full,
      })

      if (!result.success) {
        if (options.md) {
          console.log(mdOutput(`## Sync Failed`, `> ${result.error || 'Unknown error'}`))
        } else {
          out.fail(result.error || 'Sync failed')
        }
        return { success: false, error: result.error }
      }

      if (!options.md) out.stop()

      if (options.md) {
        const elapsed = Date.now() - startTime
        const skillCount = result.generatedSkills?.generated?.length ?? 0

        // Check for analysis diff (PRJ-275)
        const analysisDiffSection: string | null = await analysisStorage
          .diff(projectId)
          .then((diff) => (diff?.hasChanges ? formatAnalysisDiffMd(diff) : null))
          .catch(() => null)

        // Auto-include analysis payload if analysis is stale (instead of suggesting manual step)
        const currentCommit = result.git.recentCommits[0]?.hash ?? null
        const analysisIsCurrent =
          currentCommit && llmAnalysisStorage.isCurrent(projectId, currentCommit)
        const llmAnalysisInstructions: string | null = analysisIsCurrent
          ? null
          : await buildAnalysisPayload(projectId, projectPath, result.git, result.stats)
              .then((payload) =>
                [
                  `## Analysis Payload`,
                  ANALYSIS_NOTES_INSTRUCTIONS,
                  '### Data',
                  '```json',
                  JSON.stringify(payload),
                  '```',
                ].join('\n')
              )
              .catch(
                () => `### Next: Run \`prjct analysis-payload --md\` to update project analysis`
              )

        const steps = getNextSteps('sync', true)
        // Evaluate the recent context: surface the task contexts captured since
        // the last sync so the agent folds their patterns/anti-patterns into the
        // project's understanding (incremental — "lo que se generó al final").
        const contextReviewSection: string | null = (() => {
          try {
            const recentContexts = projectMemory
              .recall(projectId, { types: ['context'], limit: 5 })
              .map((e) => `- ${deriveTitle(e)}  \`${e.id}\``)
            return recentContexts.length > 0
              ? [
                  '### Evaluate recent context',
                  'Task contexts captured recently — fold their decisions, patterns and',
                  'anti-patterns into the project analysis (and supersede anything now wrong):',
                  '',
                  ...recentContexts,
                ].join('\n')
              : null
          } catch {
            return null
          }
        })()
        const idx = result.syncMetrics?.indexes
        const mdStatsObj: Record<string, string | number> = {
          Duration: `${(elapsed / 1000).toFixed(1)}s`,
          Skills: `${skillCount} generated`,
          'Files indexed': result.stats.fileCount,
        }
        if (idx?.bm25Files) {
          const totalTokens = idx.bm25Files * (idx.bm25AvgTokens || 0)
          mdStatsObj['Tokens indexed'] = `${Math.round(totalTokens / 1000)}K`
          mdStatsObj['Import edges'] = idx.importEdges || 0
          mdStatsObj['Co-change commits'] = idx.cochangeCommits || 0
        }
        if (result.contextQuality) {
          mdStatsObj['Context quality'] =
            `${result.contextQuality.score}/${result.contextQuality.threshold}` +
            (result.contextQuality.passed ? '' : ' needs review')
          mdStatsObj['Context removed'] = result.contextQuality.irrelevantRemoved
          mdStatsObj['Context repairs'] = result.contextQuality.repairEntriesCreated
        }
        const phaseTimingsSection: string | null =
          result.phaseTimings && result.phaseTimings.length > 0
            ? mdSection(
                'Phase timings (slowest first)',
                mdList(
                  [...result.phaseTimings]
                    .sort((a, b) => b.ms - a.ms)
                    .map((t) => `${t.phase}: ${(t.ms / 1000).toFixed(2)}s`)
                )
              )
            : null
        const retentionSection: string | null = (() => {
          if (!result.retentionDryRun) return null
          const r = result.retentionDryRun
          const mode = r.dryRun === false ? 'applied' : 'dry-run'
          const acted =
            r.dryRun === false
              ? ` · acted: ${r.archived ?? 0} archived, ${r.deleted ?? 0} deleted` +
                (r.inboxMerged || r.inboxArchived
                  ? `, inbox ${r.inboxMerged ?? 0} merged/${r.inboxArchived ?? 0} archived`
                  : '')
              : ''
          mdStatsObj[`Retention (${mode})`] =
            `${r.active} active · ${r.archive} archive · ${r.delete} delete${acted}`
          if (r.vault) {
            const v = r.vault
            const purged =
              r.dryRun === false
                ? ` · purged: hardΔ${v.softDeletedPurged ?? 0} distillΔ${v.distilledDiscarded ?? 0} digests+${v.digestsWritten ?? 0} archΔ${v.archivesPruned ?? 0}`
                : ''
            mdStatsObj.Vault = `${v.live} live · soft-del ${v.softDeleted} · archives ${v.archives} · auto ${v.autoSourceLive}${purged}`
          }
          if (r.samples.length > 0) {
            return mdSection(
              r.dryRun === false
                ? 'Retention (Rho) — worst excess/score (actions applied)'
                : 'Retention (Rho) dry-run — worst excess/score (nothing removed)',
              mdList(
                r.samples.map((s) => {
                  const excess =
                    'excess' in s && typeof (s as { excess?: number }).excess === 'number'
                      ? ` excess=${(s as { excess: number }).excess.toFixed(2)}`
                      : ''
                  return `\`${s.id}\` [${s.type}] ${s.verdict} (${s.score}${excess}) — ${s.reasons.join(', ')}`
                })
              )
            )
          }
          return null
        })()
        // Dual evolution surfaces (project + developer)
        const projectEvolutionSection: string | null = result.projectStyle?.evolutionMd
          ? result.projectStyle.evolutionMd
          : result.projectStyle?.summary
            ? [
                '## Project style',
                '',
                result.projectStyle.summary,
                '',
                `Coverage: ${result.projectStyle.styleCoverage}/100 · ` +
                  `${result.projectStyle.patternCount} patterns · ` +
                  `${result.projectStyle.conventionCount} conventions · ` +
                  `${result.projectStyle.antiPatternCount} anti-patterns`,
              ].join('\n')
            : null
        const developerEvolutionSection: string | null = result.developerSnapshotCaptured
          ? await import('../services/developer-evolution')
              .then(({ renderDeveloperEvolution }) => renderDeveloperEvolution(projectId, 4))
              .catch(() => '## Developer evolution\n\nWeekly developer snapshot captured.')
          : null

        const md = mdOutput(
          mdDone(`Sync Complete`),
          mdStats(mdStatsObj),
          phaseTimingsSection,
          retentionSection,
          analysisDiffSection,
          projectEvolutionSection,
          developerEvolutionSection,
          result.git.hasChanges ? mdWarn('Uncommitted changes detected') : null,
          contextReviewSection,
          llmAnalysisInstructions,
          mdNextSteps(steps.map((s) => ({ label: s.desc, command: s.cmd })))
        )
        console.log(md)

        return {
          success: true,
          data: result,
          metrics: { elapsed, skillCount, fileCount: result.stats.fileCount },
        }
      }

      return showSyncResult(result, startTime)
    } catch (error) {
      if (options.md) {
        console.log(mdOutput(`## Sync Failed`, `> ${getErrorMessage(error)}`))
      } else {
        out.fail(getErrorMessage(error))
      }
      return failFromError(error)
    }
  }

  /**
   * Generate analysis payload for LLM consumption.
   * Called by the sync template to get data for the LLM to analyze.
   */
  async analysisPayload(
    projectPath: string = process.cwd(),
    options: { json?: boolean; md?: boolean } = {}
  ): Promise<CommandResult> {
    try {
      const proj = await requireProject(projectPath)
      if (!proj.ok) return proj.result
      const projectId = proj.value

      // Quick sync to get fresh data (without full regeneration)
      const result = await syncService.sync(projectPath)
      if (!result.success) {
        return { success: false, error: result.error || 'Failed to gather project data' }
      }

      const currentCommit = result.git.recentCommits[0]?.hash ?? null
      if (currentCommit && llmAnalysisStorage.isCurrent(projectId, currentCommit)) {
        if (options.md) {
          console.log(mdOutput(mdDone('LLM analysis is current'), '> No re-analysis needed.'))
        } else {
          console.log(
            JSON.stringify({ success: true, action: 'skip', message: 'Analysis is current' })
          )
        }
        return { success: true, message: 'Analysis is current' }
      }

      const payload = await buildAnalysisPayload(projectId, projectPath, result.git, result.stats)

      if (options.md) {
        console.log(
          mdOutput(
            `## Analysis Payload`,
            ANALYSIS_NOTES_INSTRUCTIONS,
            '### Data',
            '```json',
            JSON.stringify(payload),
            '```'
          )
        )
      } else {
        console.log(JSON.stringify({ success: true, payload }))
      }

      return { success: true, data: payload }
    } catch (error) {
      return failFromError(error)
    }
  }

  /**
   * Save structured LLM analysis findings to SQLite.
   * Called by the sync template after the LLM produces findings.
   */
  async saveLlmAnalysis(...args: Parameters<typeof saveLlmAnalysis>): Promise<CommandResult> {
    return saveLlmAnalysis(...args)
  }

  /**
   * Get the current LLM analysis for a project.
   */
  async getLlmAnalysis(...args: Parameters<typeof getLlmAnalysis>): Promise<CommandResult> {
    return getLlmAnalysis(...args)
  }

  /**
   * p. stats - Session summary and value dashboard
   *
   * Displays:
   * - Session activity (tasks completed, features shipped today)
   * - Patterns learned (from memory system)
   * - Token savings (total, compression rate, estimated cost)
   * - Performance metrics (sync count, avg duration)
   * - Agent usage breakdown
   * - 30-day trend visualization
   *
   * @see PRJ-89
   */
  async stats(...args: Parameters<typeof stats>): Promise<CommandResult> {
    return stats(...args)
  }

  /**
   * prjct diff - Show diff between draft and sealed analysis (PRJ-275)
   *
   * Compares the current draft with the sealed version to show
   * what changed: languages, frameworks, patterns, file count, etc.
   */
  async diff(...args: Parameters<typeof diff>): Promise<CommandResult> {
    return diff(...args)
  }

  /**
   * prjct seal - Seal the current draft analysis (PRJ-263)
   *
   * Locks the current draft with a SHA-256 signature.
   * Only sealed analysis feeds task context.
   */
  async seal(...args: Parameters<typeof seal>): Promise<CommandResult> {
    return seal(...args)
  }

  /**
   * prjct rollback - Rollback to the previous sealed analysis (PRJ-276)
   *
   * Restores the previous sealed version. The current sealed becomes a draft.
   * Only one level of rollback is supported.
   */
  async rollback(...args: Parameters<typeof rollback>): Promise<CommandResult> {
    return rollback(...args)
  }

  /**
   * prjct verify - Verify integrity of sealed analysis (PRJ-263)
   *
   * Modes:
   * - Default: Cryptographic verification (signature check)
   * - --semantic: Semantic verification (data accuracy check, PRJ-270)
   */
  async verify(...args: Parameters<typeof verify>): Promise<CommandResult> {
    return verify(...args)
  }

  /**
   * prjct analysis verify --semantic - Semantic verification of analysis results (PRJ-270)
   *
   * Validates that analysis data matches actual project state:
   * - Frameworks exist in package.json
   * - Languages match file extensions
   * - Pattern locations reference real files
   * - File count is accurate
   * - Anti-pattern files exist
   */
  async semanticVerify(...args: Parameters<typeof semanticVerifyCommand>): Promise<CommandResult> {
    return semanticVerifyCommand(...args)
  }
}
